const { readJsonBody, sendJson } = require("../../server/http_helpers");
const { publicJob } = require("../jobs/job_http");

function requireTextRegionQueryService(ctx) {
  if (ctx.textRegionQueryService) return ctx.textRegionQueryService;
  throw Object.assign(new Error("Text-region query service is unavailable."), {
    statusCode: 503,
    code: "text_region_service_unavailable",
  });
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

async function handleTextRegionRoutes(ctx) {
  return (await handleTextRegionRead(ctx)) || handleTextRegionCorrection(ctx);
}

module.exports = { handleTextRegionRoutes };
