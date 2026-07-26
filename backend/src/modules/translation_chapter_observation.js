const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { paths } = require("../config");
const {
  computeObserverContractHash,
  observationCacheKey,
} = require("./reference_observation");

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporaryPath, filePath);
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
  const model = aoTaskRunner.settings?.model || null;
  const language = contentLanguage || "und";
  const cacheKey = observationCacheKey({
    extractionFingerprint,
    observerContractHash,
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
  const result = await aoTaskRunner.runChapterObservation(input, {
    outputFilePath: "output/translation_chapter_observation.txt",
    isCanceled,
    onProgress,
  });
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
  };
  writeJsonAtomic(observationPath, observation);
  return { observation, observationPath, reused: false };
}

module.exports = {
  ensureTranslationChapterObservation,
  observationPages,
  sourceFingerprint,
};
