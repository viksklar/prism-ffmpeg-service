// PRISM ffmpeg microservice
// Deploy to Railway. Requires ffmpeg installed (see Dockerfile).
//
// POST /stitch
//   {
//     clips: [{url, startTime?, endTime?}],
//     voiceover?: { script, voiceId?, startMs? },
//     returnJson?: boolean
//   }
//   → raw MP4 bytes, or { mp4Base64, durationSec, byteLength } when returnJson=true.
//
// GET /health → { ok: true }

import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const execFileAsync = promisify(execFile);
const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT ?? 3000;
const STITCH_SECRET = process.env.STITCH_SECRET ?? "";
const FAL_KEY = process.env.FAL_KEY ?? process.env.FAL_AI_API_KEY ?? "";
const FFMPEG_BIN = process.env.FFMPEG_PATH ?? ffmpegStatic ?? "ffmpeg";
const FFPROBE_BIN = process.env.FFPROBE_PATH ?? ffprobeStatic.path ?? "ffprobe";

const PRESET_VOICES = {
  confident_male: "Wise_Woman",
  warm_female: "Friendly_Person",
  energetic_youth: "Grinch",
  authoritative_male: "Deep_Voice_Man",
  narrator_female: "Calm_Woman",
};

const OUTPUT_SIZES = {
  "9:16": { width: 720, height: 1280 },
  "16:9": { width: 1280, height: 720 },
  "1:1": { width: 1080, height: 1080 },
};

function videoNormalizeFilter(width, height) {
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    "setsar=1",
    "fps=30",
    "format=yuv420p",
  ].join(",");
}

// ── Auth middleware ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (!STITCH_SECRET || req.headers["x-stitch-secret"] !== STITCH_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ── Helpers ────────────────────────────────────────────────────────────────────
async function downloadFile(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed ${res.status} for: ${url}`);
  const writer = createWriteStream(dest);
  const reader = res.body.getReader();
  await new Promise((resolve, reject) => {
    const pump = () =>
      reader.read().then(({ done, value }) => {
        if (done) { writer.end(); resolve(); return; }
        writer.write(value);
        pump();
      }).catch(reject);
    pump();
  });
}

function buildFfmpegArgs(clips, workDir, aspectRatio = "9:16") {
  const outputPath = join(workDir, "output.mp4");
  const inputs = [];
  const videoFilters = [];
  const audioFilters = [];
  const concatLabels = [];
  const size = OUTPUT_SIZES[aspectRatio] ?? OUTPUT_SIZES["9:16"];
  const normalize = videoNormalizeFilter(size.width, size.height);

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const localPath = join(workDir, `clip${i}.mp4`);
    inputs.push("-i", localPath);

    const start = clip.startTime ?? 0;
    const hasEnd = clip.endTime !== undefined && clip.endTime !== null && clip.endTime < 900;

    const vTrim = hasEnd
      ? `trim=start=${start}:end=${clip.endTime},setpts=PTS-STARTPTS`
      : start > 0 ? `trim=start=${start},setpts=PTS-STARTPTS` : "copy";

    const aTrim = hasEnd
      ? `atrim=start=${start}:end=${clip.endTime},asetpts=PTS-STARTPTS`
      : start > 0 ? `atrim=start=${start},asetpts=PTS-STARTPTS` : "acopy";

    videoFilters.push(`[${i}:v]${vTrim},${normalize}[v${i}]`);
    audioFilters.push(`[${i}:a]${aTrim}[a${i}]`);
    concatLabels.push(`[v${i}][a${i}]`);
  }

  const filterComplex = [
    ...videoFilters,
    ...audioFilters,
    `${concatLabels.join("")}concat=n=${clips.length}:v=1:a=1[outv][outa]`,
  ].join(";");

  return {
    args: [
      ...inputs,
      "-filter_complex", filterComplex,
      "-map", "[outv]",
      "-map", "[outa]",
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-y", outputPath,
    ],
    outputPath,
  };
}

async function submitFal(model, input, falKey = FAL_KEY) {
  if (!falKey) {
    throw new Error("FAL_KEY is required for voiceover generation");
  }

  const submitRes = await fetch(`https://queue.fal.run/${model}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${falKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const submitData = await submitRes.json().catch(() => ({}));
  if (!submitRes.ok) {
    throw new Error(`FAL submit failed (${submitRes.status}): ${JSON.stringify(submitData)}`);
  }

  const statusUrl = submitData.status_url;
  const responseUrl = submitData.response_url;
  if (!statusUrl || !responseUrl) {
    throw new Error(`FAL submit returned no queue URLs: ${JSON.stringify(submitData)}`);
  }

  for (let i = 0; i < 90; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const pollRes = await fetch(statusUrl, {
      headers: { Authorization: `Key ${falKey}` },
    });
    const pollData = await pollRes.json().catch(() => ({}));
    if (pollData.status === "COMPLETED") {
      const resultRes = await fetch(responseUrl, {
        headers: { Authorization: `Key ${falKey}` },
      });
      const resultData = await resultRes.json().catch(() => ({}));
      if (!resultRes.ok) {
        throw new Error(`FAL result failed (${resultRes.status}): ${JSON.stringify(resultData)}`);
      }
      return resultData;
    }
    if (pollData.status === "FAILED") {
      throw new Error(`FAL job failed: ${JSON.stringify(pollData)}`);
    }
  }

  throw new Error("FAL job timed out after 180s");
}

function resolveVoiceId(voiceId) {
  if (!voiceId) return PRESET_VOICES.confident_male;
  return PRESET_VOICES[voiceId] ?? voiceId;
}

function pickAudioUrl(result) {
  return (
    result?.audio?.url ??
    result?.file?.url ??
    result?.output?.url ??
    result?.url ??
    result?.audio_url ??
    null
  );
}

async function generateVoiceoverAudio(voiceover, workDir, falKey = FAL_KEY) {
  const script = String(voiceover?.script ?? "").trim();
  if (!script) return null;

  const voiceId = resolveVoiceId(voiceover.voiceId);
  console.log(`[voiceover] Generating TTS (${script.length} chars, voice=${voiceId})`);

  const result = await submitFal("fal-ai/minimax/speech-02-turbo", {
    text: script,
    voice_setting: {
      voice_id: voiceId,
      speed: 1,
      vol: 1,
      pitch: 0,
      emotion: "neutral",
    },
    audio_setting: {
      sample_rate: "32000",
      bitrate: "128000",
      format: "mp3",
      channel: "1",
    },
    output_format: "url",
  }, falKey);

  const audioUrl = pickAudioUrl(result);
  if (!audioUrl) {
    throw new Error(`TTS returned no audio URL: ${JSON.stringify(result)}`);
  }

  const dest = join(workDir, "voiceover.mp3");
  await downloadFile(audioUrl, dest);
  return dest;
}

async function getDurationSec(filePath) {
  try {
    const { stdout } = await execFileAsync(FFPROBE_BIN, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    const duration = Number(stdout.trim());
    return Number.isFinite(duration) ? duration : null;
  } catch {
    return null;
  }
}

async function mixVoiceover(basePath, voiceoverPath, startMs, workDir) {
  const outputPath = join(workDir, "output-voiceover.mp4");
  const delay = Math.max(0, Math.round(Number(startMs) || 0));

  const withBaseAudio = [
    "-i", basePath,
    "-i", voiceoverPath,
    "-filter_complex",
    `[1:a]adelay=${delay}:all=1,apad[vo];[0:a][vo]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
    "-map", "0:v",
    "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "128k",
    "-shortest",
    "-movflags", "+faststart",
    "-y", outputPath,
  ];

  const voiceOnlyAudio = [
    "-i", basePath,
    "-i", voiceoverPath,
    "-filter_complex",
    `[1:a]adelay=${delay}:all=1,apad[aout]`,
    "-map", "0:v",
    "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "128k",
    "-shortest",
    "-movflags", "+faststart",
    "-y", outputPath,
  ];

  try {
    console.log(`[voiceover] Mixing over stitched video at ${delay}ms`);
    await execFileAsync(FFMPEG_BIN, withBaseAudio, {
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    console.warn("[voiceover] Base audio mix failed, using voiceover-only audio:", err.stderr?.slice(-200) ?? err.message);
    await execFileAsync(FFMPEG_BIN, voiceOnlyAudio, {
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  return outputPath;
}

// ── Routes ─────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "prism-ffmpeg" });
});

app.post("/stitch", async (req, res) => {
  const { clips, voiceover, returnJson = false, aspectRatio = "9:16" } = req.body;
  const requestFalKey = req.headers["x-fal-key"] || FAL_KEY;

  if (!Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: "clips array required" });
  }
  if (clips.length > 50) {
    return res.status(400).json({ error: "Max 50 clips per stitch job" });
  }

  const workDir = join(tmpdir(), `stitch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(workDir, { recursive: true });

  try {
    console.log(`[stitch] clips=${clips.length}`);

    // 1) Download clips in parallel (up to 5 at a time)
    const downloadQueue = [...clips.entries()];
    let idx = 0;
    const workers = Array.from({ length: Math.min(5, clips.length) }, async () => {
      while (idx < downloadQueue.length) {
        const [i, clip] = downloadQueue[idx++];
        const dest = join(workDir, `clip${i}.mp4`);
        console.log(`[stitch] Downloading clip ${i}: ${clip.url.slice(0, 80)}`);
        await downloadFile(clip.url, dest);
      }
    });
    await Promise.all(workers);

    // 2) Run ffmpeg — try with audio first, fallback to video-only
    let outputPath;
    for (const withAudio of [true, false]) {
      const built = withAudio
        ? buildFfmpegArgs(clips, workDir, aspectRatio)
        : buildFfmpegArgsVideoOnly(clips, workDir, aspectRatio);

      outputPath = built.outputPath;
      console.log(`[stitch] Running ffmpeg (withAudio=${withAudio})`);

      try {
        const { stderr } = await execFileAsync(FFMPEG_BIN, built.args, {
          timeout: 300_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        if (stderr) console.log("[ffmpeg]", stderr.slice(-300));
        break; // success
      } catch (err) {
        console.warn(`[stitch] ffmpeg failed (withAudio=${withAudio}):`, err.stderr?.slice(-200) ?? err.message);
        if (!withAudio) throw new Error(`ffmpeg failed: ${err.stderr || err.message}`);
      }
    }

    if (voiceover?.script?.trim()) {
      const voiceoverPath = await generateVoiceoverAudio(voiceover, workDir, requestFalKey);
      outputPath = await mixVoiceover(outputPath, voiceoverPath, voiceover.startMs ?? 0, workDir);
    }

    // 3) Return raw MP4 bytes — caller handles storage
    const fileBytes = readFileSync(outputPath);
    const durationSec = await getDurationSec(outputPath);
    console.log(`[stitch] Done: ${(fileBytes.length / 1024 / 1024).toFixed(2)} MB`);

    if (returnJson) {
      return res.json({
        ok: true,
        mp4Base64: fileBytes.toString("base64"),
        durationSec,
        byteLength: fileBytes.length,
      });
    }

    res.set("Content-Type", "video/mp4");
    res.set("Content-Length", String(fileBytes.length));
    if (durationSec != null) res.set("X-Duration-Sec", String(durationSec));
    res.send(fileBytes);
  } catch (err) {
    console.error("[stitch] Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

function buildFfmpegArgsVideoOnly(clips, workDir, aspectRatio = "9:16") {
  const outputPath = join(workDir, "output.mp4");
  const inputs = [];
  const videoFilters = [];
  const concatLabels = [];
  const size = OUTPUT_SIZES[aspectRatio] ?? OUTPUT_SIZES["9:16"];
  const normalize = videoNormalizeFilter(size.width, size.height);

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    inputs.push("-i", join(workDir, `clip${i}.mp4`));
    const start = clip.startTime ?? 0;
    const hasEnd = clip.endTime !== undefined && clip.endTime !== null && clip.endTime < 900;
    const vTrim = hasEnd
      ? `trim=start=${start}:end=${clip.endTime},setpts=PTS-STARTPTS`
      : start > 0 ? `trim=start=${start},setpts=PTS-STARTPTS` : "copy";
    videoFilters.push(`[${i}:v]${vTrim},${normalize}[v${i}]`);
    concatLabels.push(`[v${i}]`);
  }

  return {
    args: [
      ...inputs,
      "-filter_complex", [...videoFilters, `${concatLabels.join("")}concat=n=${clips.length}:v=1:a=0[outv]`].join(";"),
      "-map", "[outv]",
      "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-an",
      "-movflags", "+faststart", "-y", outputPath,
    ],
    outputPath,
  };
}

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`prism-ffmpeg-service listening on :${PORT}`);
  console.log(`ffmpeg: ${FFMPEG_BIN}`);
  console.log(`ffprobe: ${FFPROBE_BIN}`);
  if (!STITCH_SECRET) console.warn("WARNING: STITCH_SECRET not set");
});
