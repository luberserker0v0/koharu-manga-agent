const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { paths } = require("../../../config");
const { writeJsonAtomic } = require("../../../infrastructure/filesystem/json_file");
const { isRetryableAoError } = require("../../../integrations/ao/errors/ao_error_classifier");
const {
  computeObserverContractHash,
  observationCacheKey,
} = require("../../reference/observation/reference_observation");

const TRANSLATION_ROLE_CONTRACT_VERSION = 1;
const TRANSLATION_ROLE_FIELDS = [
  "nodeId", "textRole", "speakerType", "speakerRef", "styleChannel",
  "roleConfidence", "speakerConfidence",
];

function translationRoleContractHash() {
  return crypto.createHash("sha256").update(JSON.stringify({
    version: TRANSLATION_ROLE_CONTRACT_VERSION,
    fields: TRANSLATION_ROLE_FIELDS,
  })).digest("hex");
}

function isTransientAoError(error) {
  return isRetryableAoError(error);
}

function sourceFingerprint(translations) {
  const rows = (translations || []).map((entry, index) => ({
    pageName: entry.pageName || null,
    readingOrder: index,
    text: String(entry.original || ""),
  }));
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function observationPages(translations) {
  const pages = [];
  const byPage = new Map();
  for (const entry of translations || []) {
    const text = String(entry?.original || "").trim();
    const nodeId = String(entry?.id || entry?.nodeId || "").trim();
    if (!text || !nodeId) continue;
    const pageName = String(entry.pageName || entry.pageId || "unknown").trim();
    let page = byPage.get(pageName);
    if (!page) {
      page = { pageId: entry.pageId || pageName, pageName, nodes: [] };
      byPage.set(pageName, page);
      pages.push(page);
    }
    page.nodes.push({ nodeId, readingOrder: page.nodes.length, text });
  }
  return pages;
}

function knownCharacters(translationMemory) {
  const names = new Set();
  for (const entry of translationMemory?.effective?.story?.global?.characters || []) {
    const name = typeof entry === "string" ? entry : entry?.name || entry?.canonicalForm;
    if (name) names.add(String(name));
  }
  for (const entry of translationMemory?.effective?.sourceIdentity || []) {
    if (entry?.category === "character" && entry.sourceTerm) names.add(String(entry.sourceTerm));
  }
  return [...names].slice(0, 40);
}

function compactStoryContext(translationMemory) {
  const story = translationMemory?.effective?.story;
  if (!story) return null;
  return {
    globalSummary: story.global?.summary || null,
    chapterSummary: story.chapter?.summary || null,
    characters: (story.global?.characters || []).slice(0, 20),
    relationships: (story.global?.relationships || []).slice(0, 20),
  };
}

async function ensureTranslationChapterObservation({
  aoTaskRunner,
  translations,
  mangaId = null,
  chapterId = null,
  chapterTitle = null,
  contentLanguage = null,
  translationMemory = null,
  cacheRoot = path.join(paths.workspaceRoot, "translation-observations"),
  force = false,
  isCanceled = null,
  onProgress = null,
}) {
  if (!aoTaskRunner || typeof aoTaskRunner.runChapterObservation !== "function") {
    throw new Error("Translation chapter observation requires aoTaskRunner.runChapterObservation().");
  }
  const pages = observationPages(translations);
  const nodeCount = pages.reduce((sum, page) => sum + page.nodes.length, 0);
  if (nodeCount === 0) throw new Error("Translation chapter observation requires OCR text nodes.");

  const extractionFingerprint = sourceFingerprint(translations);
  const observerContractHash = computeObserverContractHash();
  const roleContractHash = translationRoleContractHash();
  const model = aoTaskRunner.settings?.model || null;
  const language = contentLanguage || "und";
  const cacheKey = observationCacheKey({
    extractionFingerprint,
    observerContractHash: roleContractHash,
    model,
    contentLanguage: language,
  });
  const observationPath = path.join(cacheRoot, `${cacheKey}.json`);
  if (!force && fs.existsSync(observationPath)) {
    return {
      observation: JSON.parse(fs.readFileSync(observationPath, "utf8")),
      observationPath,
      reused: true,
    };
  }

  const input = {
    jobId: `translation_observation:${mangaId || "unknown"}:${chapterId || cacheKey.slice(0, 12)}`,
    mangaId,
    chapterId,
    chapterTitle,
    contentLanguage: language,
    referenceKind: "source",
    knownCharacters: knownCharacters(translationMemory),
    compactStoryContext: compactStoryContext(translationMemory),
    pages,
  };
  let result;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      result = await aoTaskRunner.runChapterObservation({ ...input, attempt }, {
        outputFilePath: "output/translation_chapter_observation.txt",
        isCanceled,
        onProgress,
      });
      break;
    } catch (error) {
      if (attempt >= 2 || !isTransientAoError(error) || isCanceled?.()) throw error;
      onProgress?.({
        activity: "retrying_transient_ao_failure",
        attempt: attempt + 1,
        error: error.message,
      });
    }
  }
  const observedAt = new Date().toISOString();
  const observation = {
    schemaVersion: 1,
    observationKind: "translation_source",
    mangaId,
    chapterId,
    chapterTitle,
    contentLanguage: language,
    extractionFingerprint,
    observerContractHash,
    translationRoleContractVersion: TRANSLATION_ROLE_CONTRACT_VERSION,
    translationRoleContractHash: roleContractHash,
    model,
    cacheKey,
    observedAt,
    fingerprint: crypto.createHash("sha256").update(JSON.stringify(result)).digest("hex"),
    nodes: result.nodes,
    mentions: result.mentions,
    storyCues: result.storyCues,
    notes: result.notes,
    coverage: result.coverage,
    warnings: result.warnings || [],
    semanticResult: result.semanticResult || null,
  };
  writeJsonAtomic(observationPath, observation);
  return { observation, observationPath, reused: false };
}

module.exports = {
  TRANSLATION_ROLE_CONTRACT_VERSION,
  ensureTranslationChapterObservation,
  isTransientAoError,
  observationPages,
  sourceFingerprint,
  translationRoleContractHash,
};
