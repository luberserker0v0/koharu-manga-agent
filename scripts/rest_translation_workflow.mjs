#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".avif", ".bmp", ".gif",
  ".tif", ".tiff", ".heic", ".heif",
]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled", "blocked"]);

function usage() {
  return `Usage:
  node scripts/rest_translation_workflow.mjs \\
    --source <image-directory> \\
    --manga-id <id> \\
    --translator-id <id> \\
    --chapter-id <id> [options]

Required:
  --source PATH                 Directory containing chapter images
  --manga-id ID                Stable manga identifier
  --translator-id ID           Stable output translator/profile identifier
  --chapter-id ID              Stable output chapter identifier

Options:
  --base-url URL               Backend API root (default: http://127.0.0.1:4001/api/v1)
  --token TOKEN                Bearer token (or set MANGA_BACKEND_TOKEN)
  --mode MODE                  quick, reference_style, local_style, or learning_style
                               (default: quick)
  --reference-translator-id ID Required by reference_style and learning_style
  --target-language TAG        Target language (default: zh-TW)
  --source-language TAG        Optional source language
  --quality-check              Enable optional Quality for supported modes
  --export-format FORMAT       Koharu export format (default: rendered)
  --download-dir PATH          Local artifact download directory
                               (default: ./workflow-downloads/<jobId>)
  --timeout-ms NUMBER          Job timeout (default: 600000)
  --help                       Show this help

The upload is retained after completion because post-edit export can still depend on
the original images. Delete it later with DELETE /api/v1/uploads/{uploadId} only when
the chapter no longer needs post-edit or re-export operations.`;
}

function parseArgs(argv) {
  const options = {
    baseUrl: "http://127.0.0.1:4001/api/v1",
    token: process.env.MANGA_BACKEND_TOKEN || "",
    mode: "quick",
    targetLanguage: "zh-TW",
    qualityCheck: false,
    exportFormat: "rendered",
    timeoutMs: 600000,
  };
  const valueFlags = new Map([
    ["--source", "source"],
    ["--manga-id", "mangaId"],
    ["--translator-id", "translatorId"],
    ["--chapter-id", "chapterId"],
    ["--base-url", "baseUrl"],
    ["--token", "token"],
    ["--mode", "mode"],
    ["--reference-translator-id", "referenceTranslatorId"],
    ["--target-language", "targetLanguage"],
    ["--source-language", "sourceLanguage"],
    ["--export-format", "exportFormat"],
    ["--download-dir", "downloadDir"],
    ["--timeout-ms", "timeoutMs"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      options.help = true;
      continue;
    }
    if (flag === "--quality-check") {
      options.qualityCheck = true;
      continue;
    }
    const key = valueFlags.get(flag);
    if (!key) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    options[key] = key === "timeoutMs" ? Number(value) : value;
    index += 1;
  }
  return options;
}

function validateOptions(options) {
  if (options.help) return;
  for (const key of ["source", "mangaId", "translatorId", "chapterId"]) {
    if (!options[key]) throw new Error(`Missing required option: ${key}`);
  }
  if (!["quick", "reference_style", "local_style", "learning_style"].includes(options.mode)) {
    throw new Error("--mode must be quick, reference_style, local_style, or learning_style.");
  }
  if (["reference_style", "learning_style"].includes(options.mode) && !options.referenceTranslatorId) {
    throw new Error(`${options.mode} requires --reference-translator-id.`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number.");
  }
}

function contentType(fileName) {
  switch (path.extname(fileName).toLowerCase()) {
    case ".png": return "image/png";
    case ".webp": return "image/webp";
    case ".avif": return "image/avif";
    case ".gif": return "image/gif";
    case ".bmp": return "image/bmp";
    case ".tif":
    case ".tiff": return "image/tiff";
    case ".heic": return "image/heic";
    case ".heif": return "image/heif";
    default: return "image/jpeg";
  }
}

function createClient(baseUrl, token) {
  const root = String(baseUrl).replace(/\/+$/, "");
  const headers = (extra = {}) => ({
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  });

  async function request(pathname, options = {}) {
    const response = await fetch(`${root}${pathname}`, {
      ...options,
      headers: headers(options.headers),
    });
    if (!response.ok) {
      const text = await response.text();
      let detail = text;
      try { detail = JSON.parse(text).error || text; } catch {}
      throw new Error(`${options.method || "GET"} ${pathname} failed (${response.status}): ${detail}`);
    }
    return response;
  }

  async function json(pathname, options = {}) {
    const body = options.body === undefined || typeof options.body === "string" || Buffer.isBuffer(options.body)
      ? options.body
      : JSON.stringify(options.body);
    const response = await request(pathname, {
      ...options,
      body,
      headers: body && typeof body === "string"
        ? { "Content-Type": "application/json", ...options.headers }
        : options.headers,
    });
    return response.json();
  }

  return { headers, json, request, root };
}

async function listImages(source) {
  const sourcePath = path.resolve(source);
  const stat = await fs.stat(sourcePath).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Source directory does not exist: ${sourcePath}`);
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => ({ name: entry.name, path: path.join(sourcePath, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
  if (files.length === 0) throw new Error(`No supported image files found in ${sourcePath}`);
  return files;
}

async function consumeJobEvents(client, jobId, signal) {
  const response = await client.request(`/jobs/${encodeURIComponent(jobId)}/stream?eventMode=message`, {
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (!response.body) return;
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    const blocks = pending.split(/\r?\n\r?\n/);
    pending = blocks.pop() || "";
    for (const block of blocks) {
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const event = JSON.parse(data);
        console.log(`[event] ${event.type || "message"}`);
      } catch {
        console.log("[event] message");
      }
    }
  }
}

async function waitForJob(client, jobId, timeoutMs) {
  const controller = new AbortController();
  const eventTask = consumeJobEvents(client, jobId, controller.signal).catch((error) => {
    if (error.name !== "AbortError") console.warn(`[warning] SSE unavailable; polling continues: ${error.message}`);
  });
  const startedAt = Date.now();
  let previousStage = null;
  try {
    while (Date.now() - startedAt < timeoutMs) {
      const job = await client.json(`/jobs/${encodeURIComponent(jobId)}`);
      if (job.stage !== previousStage) {
        console.log(`[job] status=${job.status} stage=${job.stage}`);
        previousStage = job.stage;
      }
      if (TERMINAL_STATUSES.has(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out after ${timeoutMs} ms waiting for job ${jobId}.`);
  } finally {
    controller.abort();
    await eventTask;
  }
}

function artifactFileName(response, artifact) {
  const disposition = response.headers.get("content-disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  let name = encoded ? decodeURIComponent(encoded) : `${artifact.kind || "artifact"}-${artifact.id}`;
  name = path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `${artifact.id}-${name}`;
}

async function downloadArtifacts(client, jobId, artifacts, destination) {
  await fs.mkdir(destination, { recursive: true });
  const downloaded = [];
  for (const artifact of artifacts) {
    try {
      const response = await client.request(
        `/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifact.id)}/content`
      );
      const fileName = artifactFileName(response, artifact);
      const target = path.join(destination, fileName);
      await fs.writeFile(target, Buffer.from(await response.arrayBuffer()));
      downloaded.push(target);
      console.log(`[download] ${target}`);
    } catch (error) {
      console.warn(`[warning] artifact ${artifact.id} (${artifact.kind}) was not downloadable: ${error.message}`);
    }
  }
  return downloaded;
}

async function downloadTranslatedImages(client, jobId, manifest, destination) {
  const imageDirectory = path.join(destination, "translated-images");
  await fs.mkdir(imageDirectory, { recursive: true });
  for (const image of manifest.images || []) {
    const response = await client.request(
      `/jobs/${encodeURIComponent(jobId)}/translated-images/${encodeURIComponent(image.id)}/content`
    );
    const safeName = path.basename(image.fileName).replace(/[^a-zA-Z0-9._-]+/g, "_");
    const target = path.join(imageDirectory, `${String(image.index + 1).padStart(4, "0")}-${safeName}`);
    await fs.writeFile(target, Buffer.from(await response.arrayBuffer()));
    console.log(`[translated-image] ${target}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  validateOptions(options);
  if (options.help) {
    console.log(usage());
    return;
  }

  const client = createClient(options.baseUrl, options.token);
  const images = await listImages(options.source);
  console.log(`[workflow] found ${images.length} image(s)`);

  const healthRoot = client.root.replace(/\/api\/v1$/, "");
  const health = await fetch(`${healthRoot}/health`).then(async (response) => {
    if (!response.ok) throw new Error(`GET /health failed (${response.status}).`);
    return response.json();
  });
  if (!health.ok) throw new Error("Backend health check did not return ok=true.");

  const runtime = await client.json("/runtime/status");
  if (runtime.backend?.status !== "ready") throw new Error("Backend runtime is not ready.");
  if (runtime.koharu?.status !== "running") {
    throw new Error(`Koharu is not ready (${runtime.koharu?.status || "unknown"}) at ${runtime.koharu?.baseUrl || "unknown URL"}.`);
  }
  if (options.mode !== "quick" && runtime.agent?.status !== "ready") {
    throw new Error(`AO is required by ${options.mode} but is ${runtime.agent?.status || "unknown"}.`);
  }

  const upload = await client.json("/uploads", { method: "POST", body: { kind: "source" } });
  console.log(`[upload] created ${upload.uploadId}`);
  try {
    for (const image of images) {
      const bytes = await fs.readFile(image.path);
      await client.json(`/uploads/${upload.uploadId}/files/${encodeURIComponent(image.name)}`, {
        method: "PUT",
        headers: { "Content-Type": contentType(image.name) },
        body: bytes,
      });
      console.log(`[upload] ${image.name} (${bytes.length} bytes)`);
    }
    await client.json(`/uploads/${upload.uploadId}/complete`, { method: "POST" });

    const preflight = await client.json("/source-preflight", {
      method: "POST",
      body: { uploadId: upload.uploadId },
    });
    if (!preflight.preflightId) throw new Error("Source preflight did not return preflightId.");
    console.log(`[preflight] ${preflight.preflightId}, accepted=${preflight.summary?.acceptedCount ?? "unknown"}`);

    const payload = {
      translationMode: options.mode,
      targetLanguage: options.targetLanguage,
      qualityCheck: options.mode === "learning_style" || options.qualityCheck,
      exportFormat: options.exportFormat,
      mangaId: options.mangaId,
      translatorId: options.translatorId,
      chapterId: options.chapterId,
      sourcePreflightId: preflight.preflightId,
      ...(options.sourceLanguage ? { sourceLanguage: options.sourceLanguage } : {}),
      ...(options.referenceTranslatorId ? { referenceTranslatorId: options.referenceTranslatorId } : {}),
    };
    const created = await client.json("/jobs/translation", { method: "POST", body: payload });
    console.log(`[job] created ${created.id}`);

    const job = await waitForJob(client, created.id, options.timeoutMs);
    const events = await client.json(`/jobs/${created.id}/events`);
    const artifactEnvelope = await client.json(`/jobs/${created.id}/artifacts`);
    console.log(`[result] status=${job.status} outcome=${job.outcome || "none"} events=${events.events.length} artifacts=${artifactEnvelope.artifacts.length}`);

    const downloadDir = path.resolve(options.downloadDir || path.join("workflow-downloads", created.id));
    await downloadArtifacts(client, created.id, artifactEnvelope.artifacts, downloadDir);
    let translatedImageCount = 0;
    if (job.status === "succeeded") {
      const translatedImages = await client.json(`/jobs/${created.id}/translated-images`);
      translatedImageCount = translatedImages.count;
      console.log(`[translated-images] source=${translatedImages.sourceFormat} count=${translatedImages.count}`);
      await downloadTranslatedImages(client, created.id, translatedImages, downloadDir);
    }

    const summary = {
      uploadId: upload.uploadId,
      preflightId: preflight.preflightId,
      jobId: created.id,
      status: job.status,
      outcome: job.outcome || null,
      stage: job.stage,
      error: job.error || null,
      translatedImageCount,
      downloadDir,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (job.status !== "succeeded") process.exitCode = 2;
  } catch (error) {
    console.error(`[workflow] upload ${upload.uploadId} was retained for diagnosis/retry.`);
    throw error;
  }
}

main().catch((error) => {
  console.error(`[error] ${error.message}`);
  process.exitCode = 1;
});
