const { readJsonBody, sendJson } = require("../../server/http_helpers");
const { publicJob } = require("../jobs/job_http");

function requireTextRegionQueryService(ctx) {
  if (ctx.textRegionQueryService) return ctx.textRegionQueryService;
  throw Object.assign(new Error("Text-region query service is unavailable."), {
    statusCode: 503,
    code: "text_region_service_unavailable",
  });
}

function requireTextRegionReviewService(ctx) {
  if (ctx.textRegionReviewService) return ctx.textRegionReviewService;
  throw Object.assign(new Error("Text-region review service is unavailable."), {
    statusCode: 503,
    code: "text_region_review_service_unavailable",
  });
}

function requireOcrTextReviewService(ctx) {
  if (ctx.ocrTextReviewService) return ctx.ocrTextReviewService;
  throw Object.assign(new Error("OCR text-review service is unavailable."), {
    statusCode: 503,
    code: "ocr_text_review_service_unavailable",
  });
}

async function handleOcrTextReviewJob(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/jobs/ocr-text-review") return false;
  const body = await readJsonBody(ctx.req);
  const payload = requireOcrTextReviewService(ctx).prepare(body);
  const job = ctx.jobManager.createOcrTextReviewJob(payload);
  sendJson(ctx.res, 202, publicJob(job));
  return true;
}

async function handleTextRegionRead(ctx) {
  const match = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/text-regions$/);
  if (ctx.req.method !== "GET" || !match) return false;
  const result = await requireTextRegionQueryService(ctx).get(decodeURIComponent(match[1]), {
    sourceImageId: ctx.url.searchParams.get("sourceImageId"),
  });
  sendJson(ctx.res, 200, result);
  return true;
}

async function handleTextRegionCorrection(ctx) {
  const match = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/text-region-corrections$/);
  if (ctx.req.method !== "POST" || !match) return false;
  const body = await readJsonBody(ctx.req);
  const job = await ctx.jobManager.createTextRegionCorrectionJob(decodeURIComponent(match[1]), body);
  sendJson(ctx.res, 202, publicJob(job));
  return true;
}

async function handleTextRegionReview(ctx) {
  const match = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/text-region-reviews$/);
  if (ctx.req.method !== "POST" || !match) return false;
  const body = await readJsonBody(ctx.req);
  const result = await requireTextRegionReviewService(ctx).review(decodeURIComponent(match[1]), body);
  sendJson(ctx.res, 200, result);
  return true;
}

async function handleTextRegionReviewApply(ctx) {
  const match = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/text-region-reviews\/apply$/);
  if (ctx.req.method !== "POST" || !match) return false;
  const jobId = decodeURIComponent(match[1]);
  const body = await readJsonBody(ctx.req);
  const request = requireTextRegionReviewService(ctx).prepareCorrection(jobId, body);
  const job = await ctx.jobManager.createTextRegionCorrectionJob(jobId, request);
  sendJson(ctx.res, 202, publicJob(job));
  return true;
}

async function handleTextRegionRoutes(ctx) {
  return (await handleOcrTextReviewJob(ctx)) ||
    (await handleTextRegionRead(ctx)) ||
    (await handleTextRegionReview(ctx)) ||
    (await handleTextRegionReviewApply(ctx)) ||
    handleTextRegionCorrection(ctx);
}

module.exports = { handleTextRegionRoutes };
