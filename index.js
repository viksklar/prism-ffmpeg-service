// PRISM ffmpeg microservice
// Deploy to Railway (or Fly.io). Requires ffmpeg installed (see Dockerfile).
//
// POST /stitch
//   { clips: [{url, startTime?, endTime?}], userId?, jobId? }
//   → { url: string (signed Supabase Storage URL), path: string }
//
// GET /health → { ok: true }

import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createWriteStream,
  mkdirSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@supabase/supabase-js";

const execFileAsync = promisify(execFile);
const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT ?? 3000;
const STITCH_SECRET = process.env.STITCH_SECRET ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const STORAGE_BUCKET = process.env.STORAGE_BUCKET ?? "videos";

// ── Auth middleware ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  // Allow health checks unauthenticated
  if (req.path === "/health") return next();
  if (req.headers["x-stitch-secret"] !== STITCH_SECRET || !STITCH_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ── Helpers ────────────────────────────────────────────────────────────────────
async function downloadFile(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Download failed ${res.status} for: ${url}`);
  }
  const writer = createWriteStream(dest);
  const reader = res.body.getReader();
  await new Promise((resolve, reject) => {
    const pump = () =>
      reader
        .read()
        .then(({ done, value }) => {
          if (done) {
            writer.end();
            resolve();
            return;
          }
          writer.write(value);
          pump();
        })
        .catch(reject);
    pump();
  });
}

// Build ffmpeg args for trimming + concatenating clips.
// Returns { args, outputPath }
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
    // endTime === undefined or 999 → use full clip
    const hasEnd =
      clip.endTime !== undefined && clip.endTime !== null && clip.endTime < 900;

    const vTrim = hasEnd
      ? `trim=start=${start}:end=${clip.endTime},setpts=PTS-STARTPTS`
      : start > 0
      ? `trim=start=${start},setpts=PTS-STARTPTS`
      : "copy";

    const aTrim = hasEnd
      ? `atrim=start=${start}:end=${clip.endTime},asetpts=PTS-STARTPTS`
      : start > 0
      ? `atrim=start=${start},asetpts=PTS-STARTPTS`
      : "acopy";

    videoFilters.push(`[${i}:v]${vTrim}[v${i}]`);
    audioFilters.push(`[${i}:a]${aTrim}[a${i}]`);
    concatLabels.push(`[v${i}][a${i}]`);
  }

  const filterComplex = [
    ...videoFilters,
    ...audioFilters,
    `${concatLabels.join("")}concat=n=${clips.length}:v=1:a=1[outv][outa]`,
  ].join(";");

  const args = [
    ...inputs,
    "-filter_complex",
    filterComplex,
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    "-y",
    outputPath,
  ];

  return { args, outputPath };
}

// ── Routes ─────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "prism-ffmpeg" });
});

app.post("/stitch", async (req, res) => {
  const { clips, userId = "anon", jobId = Date.now().toString() } = req.body;

  if (!Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: "clips array required" });
  }
  if (clips.length > 50) {
    return res.status(400).json({ error: "Max 50 clips per stitch job" });
  }

  const workDir = join(
    tmpdir(),
    `stitch-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(workDir, { recursive: true });

  try {
    console.log(`[stitch] job=${jobId} clips=${clips.length}`);

    // 1) Download clips in parallel (up to 5 at a time)
    const downloadQueue = [...clips.entries()];
    const concurrency = 5;
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, clips.length) }, async () => {
      while (idx < downloadQueue.length) {
        const [i, clip] = downloadQueue[idx++];
        const dest = join(workDir, `clip${i}.mp4`);
        console.log(`[stitch] Downloading clip ${i}: ${clip.url.slice(0, 80)}`);
        await downloadFile(clip.url, dest);
      }
    });
    await Promise.all(workers);

    // 2) Run ffmpeg
    const { args, outputPath } = buildFfmpegArgs(clips, workDir);
    console.log(`[stitch] Running ffmpeg with ${args.length} args`);
    const { stdout, stderr } = await execFileAsync("ffmpeg", args, {
      timeout: 300_000, // 5 min max
      maxBuffer: 10 * 1024 * 1024,
    }).catch((err) => {
      throw new Error(`ffmpeg failed: ${err.stderr ?? err.message}`);
    });
    if (stderr) console.log("[ffmpeg]", stderr.slice(-500));

    // 3) Upload to Supabase Storage
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const storagePath = `stitched/${userId}/${jobId}.mp4`;
    const fileBytes = readFileSync(outputPath);

    const { error: uploadErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, fileBytes, {
        contentType: "video/mp4",
        upsert: true,
      });

    if (uploadErr) throw new Error(`Storage upload: ${uploadErr.message}`);

    const { data: signed, error: signErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(storagePath, 7200); // 2hr

    if (signErr) throw new Error(`Signed URL: ${signErr.message}`);

    console.log(`[stitch] Done: ${storagePath}`);
    res.json({ url: signed.signedUrl, path: storagePath });
  } catch (err) {
    console.error("[stitch] Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`prism-ffmpeg-service listening on :${PORT}`);
  if (!STITCH_SECRET) console.warn("WARNING: STITCH_SECRET not set");
  if (!SUPABASE_URL) console.warn("WARNING: SUPABASE_URL not set");
  if (!SUPABASE_SERVICE_ROLE_KEY) console.warn("WARNING: SUPABASE_SERVICE_ROLE_KEY not set");
});
