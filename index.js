// PRISM ffmpeg microservice
// Deploy to Railway. Requires ffmpeg installed (see Dockerfile).
//
// POST /stitch
//   { clips: [{url, startTime?, endTime?}] }
//   → raw MP4 bytes (Content-Type: video/mp4)
//   The caller (video-stitch edge function) handles storage upload.
//
// GET /health → { ok: true }

import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT ?? 3000;
const STITCH_SECRET = process.env.STITCH_SECRET ?? "";

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

function buildFfmpegArgs(clips, workDir) {
  const outputPath = join(workDir, "output.mp4");
  const inputs = [];
  const videoFilters = [];
  const audioFilters = [];
  const concatLabels = [];

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

    videoFilters.push(`[${i}:v]${vTrim}[v${i}]`);
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

// ── Routes ─────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "prism-ffmpeg" });
});

app.post("/stitch", async (req, res) => {
  const { clips } = req.body;

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
        ? buildFfmpegArgs(clips, workDir)
        : buildFfmpegArgsVideoOnly(clips, workDir);

      outputPath = built.outputPath;
      console.log(`[stitch] Running ffmpeg (withAudio=${withAudio})`);

      try {
        const { stderr } = await execFileAsync("ffmpeg", built.args, {
          timeout: 300_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        if (stderr) console.log("[ffmpeg]", stderr.slice(-300));
        break; // success
      } catch (err) {
        console.warn(`[stitch] ffmpeg failed (withAudio=${withAudio}):`, err.stderr?.slice(-200) ?? err.message);
        if (!withAudio) throw new Error(`ffmpeg failed: ${err.stderr ?? err.message}`);
      }
    }

    // 3) Return raw MP4 bytes — caller handles storage
    const fileBytes = readFileSync(outputPath);
    console.log(`[stitch] Done: ${(fileBytes.length / 1024 / 1024).toFixed(2)} MB`);

    res.set("Content-Type", "video/mp4");
    res.set("Content-Length", String(fileBytes.length));
    res.send(fileBytes);
  } catch (err) {
    console.error("[stitch] Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

function buildFfmpegArgsVideoOnly(clips, workDir) {
  const outputPath = join(workDir, "output.mp4");
  const inputs = [];
  const videoFilters = [];
  const concatLabels = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    inputs.push("-i", join(workDir, `clip${i}.mp4`));
    const start = clip.startTime ?? 0;
    const hasEnd = clip.endTime !== undefined && clip.endTime !== null && clip.endTime < 900;
    const vTrim = hasEnd
      ? `trim=start=${start}:end=${clip.endTime},setpts=PTS-STARTPTS`
      : start > 0 ? `trim=start=${start},setpts=PTS-STARTPTS` : "copy";
    videoFilters.push(`[${i}:v]${vTrim}[v${i}]`);
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
  if (!STITCH_SECRET) console.warn("WARNING: STITCH_SECRET not set");
});
