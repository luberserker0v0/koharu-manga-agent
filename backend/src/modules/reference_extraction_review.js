const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  ensureDir,
  loadReferenceManifest,
  normalizeSceneTexts,
  referenceSetPaths,
} = require("./reference_sets");

const REVIEW_SCHEMA_VERSION = 1;

function reviewError(message, statusCode = 422) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (error && ["EPERM", "EBUSY", "EACCES"].includes(error.code)) {
      fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
      fs.rmSync(temporaryPath, { force: true });
      return;
    }
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function summarizeTexts(texts) {
  const pages = Array.isArray(texts?.pages) ? texts.pages : [];
  return {
    pageCount: pages.length,
    nodeCount: pages.reduce((total, page) => total + (Array.isArray(page.texts) ? page.texts.length : 0), 0),
  };
}

function pageContract(scene) {
  return Object.entries(scene?.scene?.pages || {}).map(([pageId, page]) => ({
    pageId,
    pageName: String(page?.name || pageId),
  }));
}

function assertPageContract(rawScene, draftScene) {
  const expected = pageContract(rawScene);
  const received = pageContract(draftScene);
  if (JSON.stringify(expected) !== JSON.stringify(received)) {
    const error = new Error("Koharu review cannot add, delete, rename, or reorder manga pages.");
    error.statusCode = 422;
    error.details = { expected, received };
    throw error;
  }
}

function nodeMap(texts) {
  const result = new Map();
  for (const page of texts?.pages || []) {
    for (const node of page.texts || []) {
      result.set(`${page.pageId}/${node.nodeId}`, node);
    }
  }
  return result;
}

function buildDiff(rawTexts, currentTexts) {
  const raw = nodeMap(rawTexts);
  const current = nodeMap(currentTexts);
  let added = 0;
  let deleted = 0;
  let changed = 0;
  for (const [key, node] of current) {
    const previous = raw.get(key);
    if (!previous) {
      added += 1;
    } else if (fingerprint(previous) !== fingerprint(node)) {
      changed += 1;
    }
  }
  for (const key of raw.keys()) {
    if (!current.has(key)) deleted += 1;
  }
  return { added, deleted, changed };
}

function buildReviewPages(rawTexts, currentTexts) {
  const rawPages = new Map((rawTexts?.pages || []).map((page) => [String(page.pageId), page]));
  return (currentTexts?.pages || []).map((page) => {
    const rawPage = rawPages.get(String(page.pageId));
    const rawNodes = new Map((rawPage?.texts || []).map((node, index) => [
      String(node.nodeId),
      { node, index },
    ]));
    const currentIds = new Set((page.texts || []).map((node) => String(node.nodeId)));
    return {
      ...page,
      texts: (page.texts || []).map((node) => {
        const original = rawNodes.get(String(node.nodeId));
        return {
          ...node,
          originalIndex: original ? original.index : null,
          changeType: !original
            ? "added"
            : fingerprint(original.node) === fingerprint(node)
              ? "unchanged"
              : "modified",
        };
      }),
      removedTexts: (rawPage?.texts || [])
        .map((node, index) => ({ ...node, originalIndex: index, changeType: "deleted" }))
        .filter((node) => !currentIds.has(String(node.nodeId))),
    };
  });
}

function rawRevisionPaths(referenceSetId, revisionId) {
  const root = path.join(referenceSetPaths(referenceSetId).rawRevisionsDir, revisionId);
  return { root, scenePath: path.join(root, "scene.json"), textsPath: path.join(root, "texts.json") };
}

function reviewRevisionPaths(referenceSetId, revision) {
  const root = path.join(referenceSetPaths(referenceSetId).reviewRevisionsDir, String(revision));
  return {
    root,
    scenePath: path.join(root, "scene.json"),
    textsPath: path.join(root, "texts.json"),
    metadataPath: path.join(root, "metadata.json"),
  };
}

function loadReviewMetadata(referenceSetId) {
  return readJson(referenceSetPaths(referenceSetId).reviewMetadataPath);
}

function saveReviewMetadata(referenceSetId, metadata) {
  const next = { ...metadata, schemaVersion: REVIEW_SCHEMA_VERSION, updatedAt: new Date().toISOString() };
  writeJsonAtomic(referenceSetPaths(referenceSetId).reviewMetadataPath, next);
  return next;
}

function initializeExtractionReview({ referenceSetId, projectId, projectName, scene, texts }) {
  const resolvedPaths = referenceSetPaths(referenceSetId);
  const previousMetadata = loadReviewMetadata(referenceSetId);
  const rawFingerprint = fingerprint(texts);
  const revisionId = [
    new Date().toISOString().replace(/[-:.TZ]/g, ""),
    rawFingerprint.slice(0, 12),
    crypto.randomUUID().replace(/-/g, "").slice(0, 8),
  ].join("_");
  const rawPaths = rawRevisionPaths(referenceSetId, revisionId);
  ensureDir(rawPaths.root);
  writeJsonAtomic(rawPaths.scenePath, scene);
  writeJsonAtomic(rawPaths.textsPath, texts);
  // Extraction is immediately usable. Human review creates a corrected revision later.
  writeJsonAtomic(resolvedPaths.scenePath, scene);
  writeJsonAtomic(resolvedPaths.textsPath, texts);
  fs.rmSync(resolvedPaths.draftScenePath, { force: true });
  fs.rmSync(resolvedPaths.draftTextsPath, { force: true });
  return saveReviewMetadata(referenceSetId, {
    referenceSetId,
    status: "awaiting_review",
    projectId: projectId || null,
    projectName: projectName || null,
    rawRevisionId: revisionId,
    rawScenePath: rawPaths.scenePath,
    rawTextsPath: rawPaths.textsPath,
    reviewRevision: Number(previousMetadata?.reviewRevision || 0),
    rawFingerprint,
    currentFingerprint: rawFingerprint,
    draftFingerprint: null,
    rawSummary: summarizeTexts(texts),
    currentSummary: summarizeTexts(texts),
    draftSummary: null,
    reviewDiff: { added: 0, deleted: 0, changed: 0 },
    pageContract: pageContract(scene),
    orderDraft: null,
    extractedAt: new Date().toISOString(),
    reviewedAt: null,
  });
}

function ensureLegacyReviewMetadata(referenceSetId) {
  const existing = loadReviewMetadata(referenceSetId);
  if (existing) return existing;
  const resolvedPaths = referenceSetPaths(referenceSetId);
  if (!fs.existsSync(resolvedPaths.scenePath) || !fs.existsSync(resolvedPaths.textsPath)) return null;
  const scene = readJson(resolvedPaths.scenePath);
  const texts = readJson(resolvedPaths.textsPath);
  return initializeExtractionReview({
    referenceSetId,
    projectId: null,
    projectName: null,
    scene,
    texts,
  });
}

function syncDraftFromScene(referenceSetId, scene) {
  const metadata = ensureLegacyReviewMetadata(referenceSetId);
  if (!metadata) throw new Error("Extraction must exist before review can be synchronized.");
  const rawPaths = rawRevisionPaths(referenceSetId, metadata.rawRevisionId);
  const rawScene = readJson(rawPaths.scenePath);
  const rawTexts = readJson(rawPaths.textsPath);
  assertPageContract(rawScene, scene);
  const draftTexts = { referenceSetId, ...normalizeSceneTexts(scene, "koharu_review") };
  const resolvedPaths = referenceSetPaths(referenceSetId);
  writeJsonAtomic(resolvedPaths.draftScenePath, scene);
  writeJsonAtomic(resolvedPaths.draftTextsPath, draftTexts);
  return saveReviewMetadata(referenceSetId, {
    ...metadata,
    draftFingerprint: fingerprint(draftTexts),
    draftSummary: summarizeTexts(draftTexts),
    reviewDiff: buildDiff(rawTexts, draftTexts),
    orderDraft: null,
    lastSyncedAt: new Date().toISOString(),
  });
}

function validateOrderDraft(draftTexts, pages) {
  if (!Array.isArray(pages)) throw reviewError("Extraction review order requires a pages array.");
  const receivedPages = new Map(pages.map((page) => [String(page.pageId), page]));
  const expectedPages = new Map((draftTexts.pages || []).map((page) => [String(page.pageId), page]));
  if (receivedPages.size !== expectedPages.size) throw reviewError("Extraction review order must include every page exactly once.");
  for (const [pageId, page] of expectedPages) {
    const submitted = receivedPages.get(pageId);
    if (!submitted || !Array.isArray(submitted.nodeIds)) throw reviewError(`Missing node order for page ${pageId}.`);
    const expected = (page.texts || []).map((node) => String(node.nodeId));
    const received = submitted.nodeIds.map(String);
    if (new Set(received).size !== received.length) throw reviewError(`Duplicate node ID in page ${pageId}.`);
    if (expected.length !== received.length || expected.some((nodeId) => !received.includes(nodeId))) {
      throw reviewError(`Node order for page ${pageId} must contain every current text node exactly once.`);
    }
  }
  return pages.map((page) => ({ pageId: String(page.pageId), nodeIds: page.nodeIds.map(String) }));
}

function saveOrderDraft(referenceSetId, pages) {
  const metadata = ensureLegacyReviewMetadata(referenceSetId);
  const draftTexts = readJson(referenceSetPaths(referenceSetId).draftTextsPath);
  if (!metadata || !draftTexts || metadata.status !== "awaiting_order_review") {
    throw reviewError("Finish Koharu editing before saving dialogue order.", 409);
  }
  const orderDraft = validateOrderDraft(draftTexts, pages);
  return saveReviewMetadata(referenceSetId, { ...metadata, orderDraft });
}

function discardReviewDraft(referenceSetId, restoredStatus = "awaiting_review") {
  const metadata = ensureLegacyReviewMetadata(referenceSetId);
  if (!metadata) return null;
  const resolvedPaths = referenceSetPaths(referenceSetId);
  fs.rmSync(resolvedPaths.draftScenePath, { force: true });
  fs.rmSync(resolvedPaths.draftTextsPath, { force: true });
  return saveReviewMetadata(referenceSetId, {
    ...metadata,
    status: restoredStatus,
    draftFingerprint: null,
    draftSummary: null,
    orderDraft: null,
    activeSessionId: null,
  });
}

function applyOrder(draftTexts, orderDraft) {
  const orderByPage = new Map(orderDraft.map((page) => [page.pageId, page.nodeIds]));
  return {
    ...draftTexts,
    pages: draftTexts.pages.map((page) => {
      const byId = new Map(page.texts.map((node) => [String(node.nodeId), node]));
      return { ...page, texts: orderByPage.get(String(page.pageId)).map((nodeId) => byId.get(nodeId)) };
    }),
  };
}

function confirmExtractionReview(referenceSetId) {
  const metadata = ensureLegacyReviewMetadata(referenceSetId);
  const resolvedPaths = referenceSetPaths(referenceSetId);
  const draftScene = readJson(resolvedPaths.draftScenePath);
  const draftTexts = readJson(resolvedPaths.draftTextsPath);
  if (!metadata || metadata.status !== "awaiting_order_review" || !draftScene || !draftTexts) {
    throw reviewError("Extraction review is not ready for final confirmation.", 409);
  }
  const orderDraft = validateOrderDraft(draftTexts, metadata.orderDraft);
  const orderedTexts = applyOrder(draftTexts, orderDraft);
  const revision = Number(metadata.reviewRevision || 0) + 1;
  const revisionPaths = reviewRevisionPaths(referenceSetId, revision);
  ensureDir(revisionPaths.root);
  writeJsonAtomic(revisionPaths.scenePath, draftScene);
  writeJsonAtomic(revisionPaths.textsPath, orderedTexts);
  writeJsonAtomic(resolvedPaths.scenePath, draftScene);
  writeJsonAtomic(resolvedPaths.textsPath, orderedTexts);
  const reviewedAt = new Date().toISOString();
  const next = saveReviewMetadata(referenceSetId, {
    ...metadata,
    status: "reviewed",
    reviewRevision: revision,
    reviewedAt,
    currentFingerprint: fingerprint(orderedTexts),
    currentSummary: summarizeTexts(orderedTexts),
    draftFingerprint: null,
    draftSummary: null,
    orderDraft: null,
    activeSessionId: null,
  });
  writeJsonAtomic(revisionPaths.metadataPath, next);
  return next;
}

function getReviewDocument(referenceSetId) {
  loadReferenceManifest(referenceSetId);
  const metadata = ensureLegacyReviewMetadata(referenceSetId);
  if (!metadata) return null;
  const resolvedPaths = referenceSetPaths(referenceSetId);
  const rawPaths = rawRevisionPaths(referenceSetId, metadata.rawRevisionId);
  const rawTexts = readJson(rawPaths.textsPath);
  const currentTexts =
    readJson(resolvedPaths.draftTextsPath) ||
    readJson(resolvedPaths.textsPath) ||
    rawTexts;
  return {
    ...metadata,
    pages: buildReviewPages(rawTexts, currentTexts),
  };
}

module.exports = {
  assertPageContract,
  buildDiff,
  buildReviewPages,
  confirmExtractionReview,
  discardReviewDraft,
  ensureLegacyReviewMetadata,
  fingerprint,
  getReviewDocument,
  initializeExtractionReview,
  loadReviewMetadata,
  saveOrderDraft,
  saveReviewMetadata,
  syncDraftFromScene,
  validateOrderDraft,
  writeJsonAtomic,
};
