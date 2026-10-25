const fs = require("fs");
const {
  loadCanonicalGlossary,
  loadCandidateTerms,
  loadStoryContext,
  loadStyleEvidence,
  loadStyleProfile,
  loadTranslationContext,
} = require("../../../domains/knowledge/assets/knowledge_assets");
const {
  clearTranslatorIngestionData,
  loadKnowledgeIndex,
  resolveKnowledgeAssetPaths,
} = require("../../../domains/knowledge/registry/knowledge_paths");
const { listReferenceSets } = require("../../../domains/reference/sets/reference_sets");
const { permanentlyDeleteMatchingJobs } = require("../reference/reference_management");
const { badRequest, sendJson } = require("../../server/http_helpers");

const KNOWLEDGE_ASSET_ROUTES = [
  { suffix: "glossary", loader: loadCanonicalGlossary },
  { suffix: "style-profile", loader: loadStyleProfile },
  { suffix: "story-context", loader: loadStoryContext },
  { suffix: "candidate-terms", loader: loadCandidateTerms },
  { suffix: "translation-context", loader: loadTranslationContext },
];

function matchKnowledgeAsset(pathname) {
  for (const route of KNOWLEDGE_ASSET_ROUTES) {
    const match = pathname.match(new RegExp(`^/knowledge/([^/]+)/${route.suffix}$`));
    if (match) return { mangaId: match[1], loader: route.loader };
  }
  return null;
}

async function handleKnowledgeAssetRead(ctx) {
  if (ctx.req.method !== "GET") return false;
  const asset = matchKnowledgeAsset(ctx.url.pathname);
  if (!asset) return false;
  const translatorId = ctx.url.searchParams.get("translatorId");
  sendJson(ctx.res, 200, asset.loader(asset.mangaId, translatorId));
  return true;
}

function resolveIngestionReferenceKind(mangaId, translatorId) {
  const series = (loadKnowledgeIndex().series || []).find((entry) => entry.mangaId === mangaId);
  const translator =
    series && translatorId ? (series.translators || []).find((entry) => entry.translatorId === translatorId) : null;
  return translator && /^(原文|original|source)$/i.test(String(translator.label || "").trim())
    ? "source"
    : "translator";
}

function resolveIngestionAssetState(mangaId, translatorId) {
  const paths = resolveKnowledgeAssetPaths({ mangaId, translatorId });
  const assetPaths = [
    paths.glossaryPath,
    paths.candidateTermsPath,
    paths.storyContextPath,
    paths.styleEvidencePath,
    paths.styleProfilePath,
    paths.translationContextPath,
  ];
  const existing = assetPaths.filter((assetPath) => fs.existsSync(assetPath));
  const updatedAt = existing.length
    ? new Date(Math.max(...existing.map((assetPath) => fs.statSync(assetPath).mtimeMs))).toISOString()
    : null;
  return { paths, existing, updatedAt };
}

function isIngestionStale(mangaId, translatorId, updatedAt) {
  if (!updatedAt) return false;
  return listReferenceSets()
    .filter((entry) => entry.mangaId === mangaId && (!translatorId || entry.translatorId === translatorId))
    .some((entry) => {
      const changedAt = entry.reviewedAt || entry.extractionUpdatedAt;
      return changedAt && Date.parse(changedAt) > Date.parse(updatedAt);
    });
}

function loadIngestionAssets(mangaId, translatorId) {
  return {
    glossary: loadCanonicalGlossary(mangaId, translatorId),
    candidateTerms: loadCandidateTerms(mangaId, translatorId),
    storyContext: loadStoryContext(mangaId, translatorId),
    styleEvidence: loadStyleEvidence(mangaId, translatorId),
    styleProfile: loadStyleProfile(mangaId, translatorId),
    translationContext: loadTranslationContext(mangaId, translatorId),
  };
}

function countChapterItems(chapters, field, onlyTruthy = false) {
  return Object.values(chapters || {}).reduce((count, chapter) => {
    const items = chapter && typeof chapter === "object" && Array.isArray(chapter[field]) ? chapter[field] : [];
    return count + (onlyTruthy ? items.filter(Boolean).length : items.length);
  }, 0);
}

function buildStoryIngestionSummary(storyContext, referenceKind) {
  const chapters = storyContext.chapters || {};
  const sourceOnly = (field) => (referenceKind === "source" ? countChapterItems(chapters, field) : 0);
  return {
    storyChapters: Object.keys(chapters).length,
    storyMentions: sourceOnly("mentions"),
    storyRelations: sourceOnly("relationships"),
    storyEvents: sourceOnly("events"),
    storyKeyLines: sourceOnly("keyLines"),
  };
}

function buildStyleIngestionSummary(styleEvidence, referenceKind) {
  const chapters = styleEvidence?.chapters || {};
  if (referenceKind === "source") {
    return { styleEvidenceChapters: 0, styleDialogueSamples: 0, styleNarrationSamples: 0, styleCharacters: 0 };
  }
  return {
    styleEvidenceChapters: Object.keys(chapters).length,
    styleDialogueSamples: countChapterItems(chapters, "dialogueSamples", true),
    styleNarrationSamples: countChapterItems(chapters, "narrationSamples", true),
    styleCharacters: countChapterItems(chapters, "characterSpeech"),
  };
}

function countKnowledgeEntries(assets) {
  const glossary = Array.isArray(assets.glossary.entries) ? assets.glossary.entries : [];
  const candidates = Array.isArray(assets.candidateTerms.entries) ? assets.candidateTerms.entries : [];
  return {
    glossaryEntries: glossary.length,
    acceptedTerminology: glossary.filter((entry) => entry.category !== "character_name").length,
    acceptedCharacters: glossary.filter((entry) => entry.category === "character_name").length,
    candidateTerms: candidates.filter((entry) => entry.kind === "term" && entry.status === "candidate").length,
    candidateCharacters: candidates.filter((entry) => entry.kind === "character" && entry.status === "candidate")
      .length,
  };
}

function normalizeIngestionStyle(assets, referenceKind) {
  if (referenceKind !== "source") {
    return { styleEvidence: assets.styleEvidence, styleProfile: assets.styleProfile };
  }
  return {
    styleEvidence: { metadata: assets.styleEvidence?.metadata || {}, chapters: {} },
    styleProfile: { metadata: assets.styleProfile?.metadata || {}, rules: {}, samples: {} },
  };
}

function summarizeIngestionAssets(assets, styleEvidence, referenceKind) {
  return {
    ...countKnowledgeEntries(assets),
    ...buildStoryIngestionSummary(assets.storyContext, referenceKind),
    ...buildStyleIngestionSummary(styleEvidence, referenceKind),
  };
}

function buildIngestionReport(mangaId, translatorId) {
  const referenceKind = resolveIngestionReferenceKind(mangaId, translatorId);
  const state = resolveIngestionAssetState(mangaId, translatorId);
  const assets = loadIngestionAssets(mangaId, translatorId);
  const { styleEvidence, styleProfile } = normalizeIngestionStyle(assets, referenceKind);
  return {
    mangaId,
    translatorId: translatorId || null,
    referenceKind,
    ingestionAvailable: state.existing.length > 0,
    ingestionUpdatedAt: state.updatedAt,
    ingestionStale: isIngestionStale(mangaId, translatorId, state.updatedAt),
    assets: state.paths,
    summary: summarizeIngestionAssets(assets, styleEvidence, referenceKind),
    glossary: assets.glossary,
    candidateTerms: assets.candidateTerms,
    storyContext: assets.storyContext,
    styleEvidence,
    styleProfile,
    translationContext: assets.translationContext,
  };
}

async function handleIngestionReport(ctx) {
  const match = ctx.url.pathname.match(/^\/knowledge\/([^/]+)\/ingestion-report$/);
  if (ctx.req.method !== "GET" || !match) return false;
  const translatorId = ctx.url.searchParams.get("translatorId");
  sendJson(ctx.res, 200, buildIngestionReport(match[1], translatorId));
  return true;
}

function matchesReferenceIngestion(job, mangaId, translatorId) {
  return (
    job.type === "reference_ingestion" &&
    typeof job.payload?.mangaId === "string" &&
    job.payload.mangaId === mangaId &&
    typeof job.payload?.translatorId === "string" &&
    job.payload.translatorId === translatorId
  );
}

function deleteTranslatorIngestion(ctx, mangaId, translatorId) {
  const deletedIngestion = clearTranslatorIngestionData({ mangaId, translatorId });
  const deletedRevisionCount = ctx.jobManager.store.deleteKnowledgeRevisions({ mangaId, translatorId });
  const deletedJobs = permanentlyDeleteMatchingJobs(ctx.jobManager, (job) =>
    matchesReferenceIngestion(job, mangaId, translatorId),
  );
  return { deletedIngestion, deletedRevisionCount, deletedJobs };
}

async function handleIngestionDelete(ctx) {
  const match = ctx.url.pathname.match(/^\/knowledge\/([^/]+)\/ingestion$/);
  if (ctx.req.method !== "DELETE" || !match) return false;
  const translatorId = ctx.url.searchParams.get("translatorId");
  if (!translatorId || !String(translatorId).trim()) {
    badRequest(ctx.res, "translatorId is required.");
    return true;
  }
  sendJson(ctx.res, 200, deleteTranslatorIngestion(ctx, match[1], translatorId));
  return true;
}

const KNOWLEDGE_ROUTE_HANDLERS = [
  handleKnowledgeAssetRead,
  handleIngestionReport,
  handleIngestionDelete,
];

async function handleKnowledgeRoutes(ctx) {
  for (const handler of KNOWLEDGE_ROUTE_HANDLERS) {
    if (await handler(ctx)) return true;
  }
  return false;
}

module.exports = { handleKnowledgeRoutes };
