const fs = require("fs");
const path = require("path");
const { DATA_ROOT } = require("../../../config");
const {
  beginSseHeartbeat,
  conflict,
  notFound,
  readJsonBody,
  sendJson,
  writeJobStreamEvent,
} = require("../../server/http_helpers");
const { publicArtifacts, publicEvent, publicJob, publicJobMessage } = require("./job_http");

function artifactContentType(filePath) {
  const types = {
    ".json": "application/json",
    ".zip": "application/zip",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".txt": "text/plain; charset=utf-8",
  };
  return types[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function resolveDownloadableArtifact(filePath) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  const resolvedRoot = fs.realpathSync(DATA_ROOT);
  const resolvedFile = fs.realpathSync(filePath);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolvedFile;
}

function jobsSnapshot(jobManager) {
  return {
    kind: "snapshot",
    type: "jobs.snapshot",
    jobs: jobManager.listJobsWithDeleted().map(publicJob),
    createdAt: new Date().toISOString(),
  };
}

function openAllJobsStream(ctx) {
  const { req, res, url, jobManager } = ctx;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const stopHeartbeat = beginSseHeartbeat(res);
  const useEnvelope = url.searchParams.get("eventMode") === "message";
  writeJobStreamEvent(res, "jobs.snapshot", jobsSnapshot(jobManager), useEnvelope);
  const unsubscribe = jobManager.subscribeAll((message) => {
    writeJobStreamEvent(res, message.type, publicJobMessage(message), useEnvelope);
  });
  req.on("close", () => closeJobStream(res, stopHeartbeat, unsubscribe));
}

function closeJobStream(res, stopHeartbeat, unsubscribe) {
  stopHeartbeat();
  unsubscribe();
  res.end();
}

async function handleJobList(ctx) {
  if (ctx.req.method !== "GET" || ctx.url.pathname !== "/jobs") return false;
  const includeDeleted = ctx.url.searchParams.get("includeDeleted") === "1";
  const jobs = includeDeleted ? ctx.jobManager.listJobsWithDeleted() : ctx.jobManager.listJobs();
  sendJson(ctx.res, 200, { jobs: jobs.map(publicJob) });
  return true;
}

async function handleAllJobsStream(ctx) {
  if (ctx.req.method !== "GET" || ctx.url.pathname !== "/jobs/stream") return false;
  openAllJobsStream(ctx);
  return true;
}

function replayJobEvents(res, events, useEnvelope) {
  for (const event of events || []) {
    writeJobStreamEvent(
      res,
      event.type,
      publicEvent({ type: event.type, payload: event.payload, createdAt: event.createdAt }),
      useEnvelope,
    );
  }
}

function openJobStream(ctx, jobId, job) {
  const { req, res, url, jobManager } = ctx;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const stopHeartbeat = beginSseHeartbeat(res);
  const useEnvelope = url.searchParams.get("eventMode") === "message";
  replayJobEvents(res, job.events, useEnvelope);
  const unsubscribe = jobManager.subscribe(jobId, (event) => {
    writeJobStreamEvent(res, event.type, publicJobMessage(event), useEnvelope);
  });
  req.on("close", () => closeJobStream(res, stopHeartbeat, unsubscribe));
}

async function handleJobStream(ctx) {
  const match = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/stream$/);
  if (ctx.req.method !== "GET" || !match) return false;
  const job = ctx.jobManager.getJob(match[1]);
  if (!job) {
    notFound(ctx.res);
    return true;
  }
  openJobStream(ctx, match[1], job);
  return true;
}

async function handleJobEventsAndArtifacts(ctx) {
  if (ctx.req.method !== "GET") return false;
  const eventsMatch = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/events$/);
  const artifactsMatch = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/artifacts$/);
  if (eventsMatch) return sendJobEvents(ctx, eventsMatch[1]);
  if (artifactsMatch) return sendJobArtifacts(ctx, artifactsMatch[1]);
  return false;
}

function sendJobArtifacts(ctx, jobId) {
  const artifacts = ctx.jobManager.getJobArtifacts(jobId);
  return sendJobCollection(ctx, "artifacts", artifacts && publicArtifacts(jobId, artifacts));
}

function sendJobEvents(ctx, jobId) {
  const events = ctx.jobManager.getJobEvents(jobId);
  return sendJobCollection(ctx, "events", events && events.map(publicEvent));
}

function sendJobCollection(ctx, key, entries) {
  if (!entries) {
    notFound(ctx.res);
    return true;
  }
  sendJson(ctx.res, 200, { [key]: entries });
  return true;
}

function requireTranslatedImageService(ctx) {
  if (ctx.translatedImageService) return ctx.translatedImageService;
  throw Object.assign(new Error("Translated image service is unavailable."), {
    statusCode: 503,
  });
}

async function streamTranslatedImage(ctx, match) {
  const service = requireTranslatedImageService(ctx);
  const artifacts = ctx.jobManager.getJobArtifacts(match[1]);
  if (!artifacts) return notFound(ctx.res);
  const { image } = await service.find({
    jobId: match[1],
    artifacts,
    imageId: match[2],
  });
  ctx.res.writeHead(200, {
    "Content-Type": image.mediaType,
    "Content-Length": image.size,
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(image.fileName)}`,
    "Cache-Control": "private, max-age=31536000, immutable",
  });
  fs.createReadStream(image.path).pipe(ctx.res);
}

async function handleTranslatedImageContent(ctx) {
  const match = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/translated-images\/([^/]+)\/content$/);
  if (ctx.req.method !== "GET" || !match) return false;
  await streamTranslatedImage(ctx, match);
  return true;
}

async function sendEncodedTranslatedImage(ctx, match) {
  const service = requireTranslatedImageService(ctx);
  const artifacts = ctx.jobManager.getJobArtifacts(match[1]);
  if (!artifacts) return notFound(ctx.res);
  const response = await service.encoded({
    jobId: match[1],
    artifacts,
    imageId: match[2],
  });
  sendJson(ctx.res, 200, response);
}

async function sendTranslatedImages(ctx, jobId) {
  const service = requireTranslatedImageService(ctx);
  const artifacts = ctx.jobManager.getJobArtifacts(jobId);
  if (!artifacts) return notFound(ctx.res);
  let response = await service.list({ jobId, artifacts });
  if (ctx.pageRevisionService) {
    response = await ctx.pageRevisionService.enrichTranslatedImages(jobId, response);
  }
  sendJson(ctx.res, 200, response);
}

async function handleTranslatedImages(ctx) {
  if (ctx.req.method !== "GET") return false;
  const imageMatch = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/translated-images\/([^/]+)$/);
  const imagesMatch = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/translated-images$/);
  if (imageMatch) {
    await sendEncodedTranslatedImage(ctx, imageMatch);
    return true;
  }
  if (imagesMatch) {
    await sendTranslatedImages(ctx, imagesMatch[1]);
    return true;
  }
  return false;
}

function streamArtifact(ctx, artifact) {
  const filePath = resolveDownloadableArtifact(artifact.path);
  if (!filePath) {
    sendJson(ctx.res, 409, { error: "Artifact file is unavailable or outside the data root." });
    return;
  }
  const stat = fs.statSync(filePath);
  const fileName = path.basename(filePath);
  ctx.res.writeHead(200, {
    "Content-Type": artifactContentType(filePath),
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  });
  fs.createReadStream(filePath).pipe(ctx.res);
}

async function handleArtifactContent(ctx) {
  const match = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/artifacts\/(\d+)\/content$/);
  if (ctx.req.method !== "GET" || !match) return false;
  const artifacts = ctx.jobManager.getJobArtifacts(match[1]);
  const artifact = artifacts?.find((entry) => String(entry.id) === match[2]);
  if (!artifact) {
    notFound(ctx.res);
    return true;
  }
  streamArtifact(ctx, artifact);
  return true;
}

async function retryJob(ctx, jobId) {
  const sourceJob = ctx.jobManager.getJob(jobId);
  if (!sourceJob) return notFound(ctx.res);
  if (["translation", "translation_quality_repair"].includes(sourceJob.type)) {
    await ctx.jobManager.assertAgentAvailableForTranslation?.(sourceJob.payload);
  }
  await ctx.jobManager.assertKoharuAvailableForJobType?.(sourceJob.type, sourceJob.payload);
  const job = ctx.jobManager.retryJob(jobId);
  if (!job) return notFound(ctx.res);
  sendJson(ctx.res, 202, publicJob(job));
}

async function handleJobRetry(ctx) {
  const match = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/retry$/);
  if (ctx.req.method !== "POST" || !match) return false;
  await retryJob(ctx, match[1]);
  return true;
}

async function resumeJob(ctx, jobId) {
  const sourceJob = ctx.jobManager.getJob(jobId);
  if (!sourceJob) return notFound(ctx.res);
  await ctx.jobManager.assertKoharuAvailableForJobType?.(sourceJob.type, sourceJob.payload);
  const job = ctx.jobManager.resumeJob(jobId);
  if (!job) return notFound(ctx.res);
  sendJson(ctx.res, 202, publicJob(job));
}

async function handleJobResume(ctx) {
  const match = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/resume$/);
  if (ctx.req.method !== "POST" || !match) return false;
  await resumeJob(ctx, match[1]);
  return true;
}

async function handleJobCancel(ctx) {
  const match = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/cancel$/);
  if (ctx.req.method !== "POST" || !match) return false;
  const job = ctx.jobManager.cancelJob(match[1]);
  if (!job) {
    notFound(ctx.res);
    return true;
  }
  sendJson(ctx.res, 202, publicJob(job));
  return true;
}

const BATCH_MUTATIONS = {
  "/jobs/delete-batch": "deleteJobs",
  "/jobs/restore-batch": "restoreJobs",
  "/jobs/purge-batch": "purgeJobs",
};

async function handleJobBatchMutation(ctx) {
  const method = BATCH_MUTATIONS[ctx.url.pathname];
  if (ctx.req.method !== "POST" || !method) return false;
  const body = await readJsonBody(ctx.req);
  try {
    sendJson(ctx.res, 200, ctx.jobManager[method](body.jobIds));
  } catch (error) {
    conflict(ctx.res, error.message);
  }
  return true;
}

function jobMutationResult(action, job) {
  return {
    [action]: {
      id: job.id,
      status: job.status,
      type: job.type,
    },
  };
}

function runJobMutation(ctx, jobId, action, method) {
  try {
    const job = ctx.jobManager[method](jobId);
    if (!job) {
      notFound(ctx.res);
      return;
    }
    sendJson(ctx.res, 200, jobMutationResult(action, job));
  } catch (error) {
    conflict(ctx.res, error.message);
  }
}

async function handleJobDelete(ctx) {
  const match = ctx.url.pathname.match(/^\/jobs\/([^/]+)$/);
  if (ctx.req.method !== "DELETE" || !match) return false;
  runJobMutation(ctx, match[1], "deleted", "deleteJob");
  return true;
}

async function handleJobRestore(ctx) {
  const match = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/restore$/);
  if (ctx.req.method !== "POST" || !match) return false;
  runJobMutation(ctx, match[1], "restored", "restoreJob");
  return true;
}

async function handleJobPurge(ctx) {
  const match = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/permanent$/);
  if (ctx.req.method !== "DELETE" || !match) return false;
  runJobMutation(ctx, match[1], "purged", "purgeJob");
  return true;
}

async function handleJobRead(ctx) {
  const match = ctx.url.pathname.match(/^\/jobs\/([^/]+)$/);
  if (ctx.req.method !== "GET" || !match) return false;
  const job = ctx.jobManager.getJob(match[1]);
  if (!job) {
    notFound(ctx.res);
    return true;
  }
  sendJson(ctx.res, 200, publicJob(job));
  return true;
}

const JOB_ROUTE_HANDLERS = [
  handleJobList,
  handleAllJobsStream,
  handleJobStream,
  handleJobEventsAndArtifacts,
  handleTranslatedImageContent,
  handleTranslatedImages,
  handleArtifactContent,
  handleJobRetry,
  handleJobResume,
  handleJobCancel,
  handleJobBatchMutation,
  handleJobDelete,
  handleJobRestore,
  handleJobPurge,
  handleJobRead,
];

async function handleJobRoutes(ctx) {
  for (const handler of JOB_ROUTE_HANDLERS) {
    if (await handler(ctx)) return true;
  }
  return false;
}

module.exports = { handleJobRoutes };
