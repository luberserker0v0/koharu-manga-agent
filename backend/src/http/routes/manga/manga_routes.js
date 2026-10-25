const { normalizeLanguageTag } = require("../../../language_codes");
const { deleteReferenceSet, listReferenceSets } = require("../../../domains/reference/sets/reference_sets");
const {
  createChapterRecord,
  createMangaRecord,
  createTranslatorProfile,
  deleteChapterRecord,
  deleteMangaRecord,
  deleteTranslatorProfile,
  listChapterRegistry,
  reconcileReferenceBindings,
  reorderChapterRegistry,
  updateChapterRecord,
} = require("../../../domains/knowledge/registry/knowledge_paths");
const { deleteChapterLearningData } = require("../../../domains/knowledge/learning/knowledge");
const {
  assertNoActiveJobs,
  deleteBoundReferenceData,
  permanentlyDeleteMatchingJobs,
} = require("../reference/reference_management");
const { notFound, readJsonBody, sendJson } = require("../../server/http_helpers");

async function handleMangaList(ctx) {
  if (ctx.req.method !== "GET" || ctx.url.pathname !== "/manga") return false;
  sendJson(ctx.res, 200, { series: reconcileReferenceBindings(listReferenceSets()) });
  return true;
}

async function handleMangaCreate(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/manga") return false;
  const body = await readJsonBody(ctx.req);
  const manga = createMangaRecord({ label: body.label, language: normalizeLanguageTag(body.language) });
  sendJson(ctx.res, 201, { manga });
  return true;
}

async function handleMangaDelete(ctx) {
  const match = ctx.url.pathname.match(/^\/manga\/([^/]+)$/);
  if (ctx.req.method !== "DELETE" || !match) return false;
  const mangaId = match[1];
  const referenceData = deleteBoundReferenceData(ctx.jobManager, { mangaId });
  const deletedRevisionCount = ctx.jobManager.store.deleteKnowledgeRevisions({ mangaId, allTranslators: true });
  sendJson(ctx.res, 200, {
    deleted: deleteMangaRecord({ mangaId }),
    deletedRevisionCount,
    ...referenceData,
  });
  return true;
}

async function handleTranslatorCreate(ctx) {
  const match = ctx.url.pathname.match(/^\/manga\/([^/]+)\/translators$/);
  if (ctx.req.method !== "POST" || !match) return false;
  const body = await readJsonBody(ctx.req);
  const translator = createTranslatorProfile({
    mangaId: match[1],
    label: body.label,
    language: normalizeLanguageTag(body.language),
    styleSourceTranslatorId: body.styleSourceTranslatorId || null,
  });
  sendJson(ctx.res, 201, { translator });
  return true;
}

async function handleTranslatorDelete(ctx) {
  const match = ctx.url.pathname.match(/^\/manga\/([^/]+)\/translators\/([^/]+)$/);
  if (ctx.req.method !== "DELETE" || !match) return false;
  const mangaId = match[1];
  const translatorId = match[2];
  const referenceData = deleteBoundReferenceData(ctx.jobManager, { mangaId, translatorId });
  const deletedRevisionCount = ctx.jobManager.store.deleteKnowledgeRevisions({ mangaId, translatorId });
  sendJson(ctx.res, 200, {
    deleted: deleteTranslatorProfile({ mangaId, translatorId }),
    deletedRevisionCount,
    ...referenceData,
  });
  return true;
}

async function handleChapterList(ctx) {
  const match = ctx.url.pathname.match(/^\/manga\/([^/]+)\/translators\/([^/]+)\/chapters$/);
  if (ctx.req.method !== "GET" || !match) return false;
  const chapters = listChapterRegistry({ mangaId: match[1], translatorId: match[2] });
  sendJson(ctx.res, 200, { chapters });
  return true;
}

async function handleChapterCreate(ctx) {
  const match = ctx.url.pathname.match(/^\/manga\/([^/]+)\/translators\/([^/]+)\/chapters$/);
  if (ctx.req.method !== "POST" || !match) return false;
  const body = await readJsonBody(ctx.req);
  const chapter = createChapterRecord({
    mangaId: match[1],
    translatorId: match[2],
    chapterTitle: body.chapterTitle || null,
  });
  sendJson(ctx.res, 201, { chapter });
  return true;
}

async function handleChapterReorder(ctx) {
  const match = ctx.url.pathname.match(/^\/manga\/([^/]+)\/translators\/([^/]+)\/chapters\/reorder$/);
  if (ctx.req.method !== "POST" || !match) return false;
  const body = await readJsonBody(ctx.req);
  const chapters = reorderChapterRegistry({
    mangaId: match[1],
    translatorId: match[2],
    orderedChapterIds: body.orderedChapterIds,
  });
  sendJson(ctx.res, 200, { chapters });
  return true;
}

async function handleChapterUpdate(ctx) {
  const match = ctx.url.pathname.match(/^\/manga\/([^/]+)\/translators\/([^/]+)\/chapters\/([^/]+)$/);
  if (ctx.req.method !== "POST" || !match) return false;
  const body = await readJsonBody(ctx.req);
  const chapter = updateChapterRecord({
    mangaId: match[1],
    translatorId: match[2],
    chapterId: match[3],
    chapterTitle: body.chapterTitle || null,
  });
  sendJson(ctx.res, 200, { chapter });
  return true;
}

function collectChapterJobIds(jobs, mangaId, translatorId, chapterId) {
  const ids = new Set(jobs.filter((job) =>
    job.payload?.mangaId === mangaId && job.payload?.translatorId === translatorId && job.payload?.chapterId === chapterId,
  ).map((job) => job.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const job of jobs) {
      if (!ids.has(job.id) && ids.has(job.parentJobId)) {
        ids.add(job.id);
        changed = true;
      }
    }
  }
  return ids;
}

function deleteChapterResources(ctx, mangaId, translatorId, chapterId, jobIds) {
  const references = listReferenceSets().filter((entry) =>
    entry.mangaId === mangaId && entry.translatorId === translatorId && entry.chapterId === chapterId,
  );
  const deletedPublication = ctx.jobManager.engine?.translationPublicationService?.deleteChapter(
    mangaId, translatorId, chapterId,
  ) || { deleted: false, chapterId, revisionCount: 0 };
  return {
    deleted: deleteChapterRecord({ mangaId, translatorId, chapterId }),
    deletedPublication,
    deletedLearningData: deleteChapterLearningData({ mangaId, translatorId, chapterId }),
    deletedRevisionCount: ctx.jobManager.store.deleteKnowledgeRevisions({ mangaId, translatorId, chapterId }),
    deletedReferences: references.map((entry) => deleteReferenceSet(entry.id)),
    deletedJobs: permanentlyDeleteMatchingJobs(ctx.jobManager, (job) => jobIds.has(job.id)),
  };
}

function resolveChapterDeletion(ctx, mangaId, translatorId, chapterId) {
  const allJobs = ctx.jobManager.listJobsWithDeleted();
  const jobIds = collectChapterJobIds(allJobs, mangaId, translatorId, chapterId);
  assertNoActiveJobs(allJobs.filter((job) => jobIds.has(job.id)));
  return deleteChapterResources(ctx, mangaId, translatorId, chapterId, jobIds);
}

async function handleChapterDelete(ctx) {
  const match = ctx.url.pathname.match(/^\/manga\/([^/]+)\/translators\/([^/]+)\/chapters\/([^/]+)$/);
  if (ctx.req.method !== "DELETE" || !match) return false;
  const [mangaId, translatorId, chapterId] = match.slice(1);
  const exists = listChapterRegistry({ mangaId, translatorId }).some((chapter) => chapter.chapterId === chapterId);
  if (!exists) {
    notFound(ctx.res);
    return true;
  }
  sendJson(ctx.res, 200, resolveChapterDeletion(ctx, mangaId, translatorId, chapterId));
  return true;
}

const MANGA_ROUTE_HANDLERS = [
  handleMangaList,
  handleMangaCreate,
  handleMangaDelete,
  handleTranslatorCreate,
  handleTranslatorDelete,
  handleChapterList,
  handleChapterCreate,
  handleChapterReorder,
  handleChapterUpdate,
  handleChapterDelete,
];

async function handleMangaRoutes(ctx) {
  for (const handler of MANGA_ROUTE_HANDLERS) {
    if (await handler(ctx)) return true;
  }
  return false;
}

module.exports = { handleMangaRoutes };
