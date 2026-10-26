const { importPostEditReference } = require("../../../domains/reference/sets/reference_sets");
const { badRequest, notFound, readJsonBody, sendJson } = require("../../server/http_helpers");
const { publicJob, withoutInternalLocations } = require("../jobs/job_http");

async function handlePostEditExport(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/jobs/post-edit-export") return false;
  const body = await readJsonBody(ctx.req);
  if (Object.prototype.hasOwnProperty.call(body, "outputDir")) {
    badRequest(ctx.res, "outputDir is backend-owned and is not accepted by this API.");
    return true;
  }
  await ctx.jobManager.assertKoharuAvailableForJobType?.("post_edit_export", body);
  sendJson(ctx.res, 202, publicJob(ctx.jobManager.createPostEditExportJob(body)));
  return true;
}

async function handlePostEditRead(ctx) {
  const match = ctx.url.pathname.match(/^\/post-edit\/([^/]+)$/);
  if (ctx.req.method !== "GET" || !match) return false;
  const job = ctx.jobManager.getJob(match[1]);
  if (!job) {
    notFound(ctx.res);
    return true;
  }
  const document = ctx.resolvedPostEditWorkspaceModule.load(match[1]);
  sendJson(ctx.res, 200, {
    exists: Boolean(document),
    editedScene: document,
  });
  return true;
}

async function handlePostEditSave(ctx) {
  const match = ctx.url.pathname.match(/^\/post-edit\/([^/]+)$/);
  if (ctx.req.method !== "POST" || !match) return false;
  const job = ctx.jobManager.getJob(match[1]);
  if (!job) {
    notFound(ctx.res);
    return true;
  }
  const body = await readJsonBody(ctx.req);
  const editedScene = ctx.resolvedPostEditWorkspaceModule.save(match[1], body);
  sendJson(ctx.res, 200, { editedScene });
  return true;
}

function postEditReferenceInput(editedScene, body, sourceJobId) {
  return {
    editedScene,
    label: body.label,
    language: body.language,
    source: "post_edit_document",
    referenceKind: body.referenceKind || "translator",
    mangaId: body.mangaId || editedScene.mangaId || null,
    mangaLabel: body.mangaLabel || null,
    translatorId: body.translatorId || null,
    translatorLabel: body.translatorLabel || null,
    chapterId: body.chapterId || editedScene.chapterId || null,
    chapterTitle: body.chapterTitle || null,
    sourceJobId,
  };
}

async function importPostEditReferenceSet(ctx, jobId) {
  const job = ctx.jobManager.getJob(jobId);
  if (!job) return notFound(ctx.res);
  const editedScene = ctx.resolvedPostEditWorkspaceModule.load(jobId);
  if (!editedScene) {
    badRequest(ctx.res, "Post-edit document does not exist for this job.");
    return;
  }
  const body = await readJsonBody(ctx.req);
  const input = postEditReferenceInput(editedScene, body, jobId);
  sendJson(ctx.res, 201, { referenceSet: withoutInternalLocations(importPostEditReference(input)) });
}

async function handlePostEditReferenceImport(ctx) {
  const match = ctx.url.pathname.match(/^\/post-edit\/([^/]+)\/reference-set$/);
  if (ctx.req.method !== "POST" || !match) return false;
  await importPostEditReferenceSet(ctx, match[1]);
  return true;
}

const POST_EDIT_ROUTE_HANDLERS = [
  handlePostEditExport,
  handlePostEditRead,
  handlePostEditSave,
  handlePostEditReferenceImport,
];

async function handlePostEditRoutes(ctx) {
  for (const handler of POST_EDIT_ROUTE_HANDLERS) {
    if (await handler(ctx)) return true;
  }
  return false;
}

module.exports = { handlePostEditRoutes };
