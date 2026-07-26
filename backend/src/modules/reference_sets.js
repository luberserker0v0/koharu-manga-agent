const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { paths } = require("../config");
const { DEFAULT_LANGUAGE_TAG, normalizeLanguageTag } = require("../language_codes");
const { listKnowledgeSeries, syncMangaManagementBinding } = require("./knowledge_paths");

const KNOWN_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".bmp",
  ".gif",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
]);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function naturalCompare(left, right) {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function createImportedReferenceSetId() {
  const shortId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `ref_${shortId}`;
}

function listReferenceImagesInFolder(sourceFolder) {
  if (!sourceFolder || !sourceFolder.trim()) {
    throw new Error("Reference source folder is required.");
  }
  if (!fs.existsSync(sourceFolder)) {
    throw new Error(`Reference source folder not found: ${sourceFolder}`);
  }
  const stat = fs.statSync(sourceFolder);
  if (!stat.isDirectory()) {
    throw new Error(`Reference source folder is not a directory: ${sourceFolder}`);
  }

  return fs
    .readdirSync(sourceFolder, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => KNOWN_IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort(naturalCompare)
    .map((name) => path.join(sourceFolder, name));
}

function referenceSetPaths(referenceSetId) {
  const legacyDiagnosticsRoot =
    paths.legacyReferenceDiagnostics || paths.referenceComparisons;

  return {
    imagesDir: path.join(paths.referenceImages, referenceSetId),
    extractedDir: path.join(paths.referenceExtracted, referenceSetId),
    comparisonsDir: path.join(legacyDiagnosticsRoot, referenceSetId),
    manifestPath: path.join(paths.referenceManifests, `${referenceSetId}.json`),
    textsPath: path.join(paths.referenceExtracted, referenceSetId, "texts.json"),
    scenePath: path.join(paths.referenceExtracted, referenceSetId, "scene.json"),
    reviewMetadataPath: path.join(paths.referenceExtracted, referenceSetId, "extraction_review.json"),
    draftScenePath: path.join(paths.referenceExtracted, referenceSetId, "draft_scene.json"),
    draftTextsPath: path.join(paths.referenceExtracted, referenceSetId, "draft_texts.json"),
    rawRevisionsDir: path.join(paths.referenceExtracted, referenceSetId, "raw"),
    reviewRevisionsDir: path.join(paths.referenceExtracted, referenceSetId, "revisions"),
    observationPath: path.join(paths.referenceExtracted, referenceSetId, "chapter_observation.json"),
    observationRevisionsDir: path.join(paths.referenceExtracted, referenceSetId, "observations"),
    deepReviewRevisionsDir: path.join(paths.referenceExtracted, referenceSetId, "deep_reviews"),
  };
}

function loadReferenceManifest(referenceSetId) {
  const { manifestPath } = referenceSetPaths(referenceSetId);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Reference manifest not found: ${manifestPath}. Add the manifest before running reference extraction or ingestion.`
    );
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  validateReferenceManifest(manifest);
  return manifest;
}

function validateReferenceManifest(manifest) {
  const required = [
    "id",
    "label",
    "source",
    "language",
    "pageCount",
    "imageDir",
    "extractedDir",
    "enabled",
  ];

  for (const key of required) {
    if (!(key in manifest)) {
      throw new Error(`Reference manifest missing required key: ${key}`);
    }
  }

  if ("comparisonDir" in manifest && typeof manifest.comparisonDir !== "string") {
    throw new Error("Reference manifest key comparisonDir must be a string when provided.");
  }

  if ("referenceKind" in manifest && manifest.referenceKind !== "source" && manifest.referenceKind !== "translator") {
    throw new Error("Reference manifest key referenceKind must be source or translator when provided.");
  }
}

function loadExtractedTexts(referenceSetId) {
  const { textsPath } = referenceSetPaths(referenceSetId);
  if (!fs.existsSync(textsPath)) {
    throw new Error(
      `Reference extracted texts not found: ${textsPath}. Run extraction for the reference set first.`
    );
  }
  return JSON.parse(fs.readFileSync(textsPath, "utf-8"));
}

function listReferenceSets() {
  ensureDir(paths.referenceManifests);
  const mangaLabelById = new Map(
    listKnowledgeSeries().map((entry) => [entry.mangaId, entry.label])
  );
  const manifests = fs
    .readdirSync(paths.referenceManifests)
    .filter((entry) => entry.toLowerCase().endsWith(".json") && !entry.startsWith("_"))
    .map((entry) => {
      const manifestPath = path.join(paths.referenceManifests, entry);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      validateReferenceManifest(manifest);
      const indexedMangaLabel = manifest.mangaId
        ? mangaLabelById.get(manifest.mangaId)
        : null;
      if (
        indexedMangaLabel &&
        indexedMangaLabel !== manifest.mangaId &&
        (!manifest.mangaLabel || manifest.mangaLabel === manifest.mangaId)
      ) {
        manifest.mangaLabel = indexedMangaLabel;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
      }
      const extractedPaths = referenceSetPaths(manifest.id);
      const review = fs.existsSync(extractedPaths.reviewMetadataPath)
        ? JSON.parse(fs.readFileSync(extractedPaths.reviewMetadataPath, "utf-8"))
        : null;
      const observation = fs.existsSync(extractedPaths.observationPath)
        ? JSON.parse(fs.readFileSync(extractedPaths.observationPath, "utf-8"))
        : null;
      const observationStatus = observation
        ? observation.extractionFingerprint === review?.currentFingerprint
          ? "complete"
          : "stale"
        : "missing";
      return {
        id: manifest.id,
        label: manifest.label,
        source: manifest.source,
        referenceKind: manifest.referenceKind || "translator",
        language: manifest.language,
        pageCount: manifest.pageCount,
        mangaId: manifest.mangaId || null,
        mangaLabel: manifest.mangaLabel || null,
        translatorId: manifest.translatorId || null,
        translatorLabel: manifest.translatorLabel || null,
        chapterId: manifest.chapterId || null,
        chapterTitle: manifest.chapterTitle || null,
        extractionAvailable: Boolean(review?.rawRevisionId) || fs.existsSync(extractedPaths.textsPath),
        extractionUpdatedAt: review?.extractedAt || (fs.existsSync(extractedPaths.textsPath)
          ? fs.statSync(extractedPaths.textsPath).mtime.toISOString()
          : null),
        reviewStatus: review?.status || (fs.existsSync(extractedPaths.textsPath) ? "awaiting_review" : null),
        activeReviewSessionId: review?.activeSessionId || null,
        reviewRevision: Number(review?.reviewRevision || 0),
        reviewedAt: review?.reviewedAt || null,
        koharuProjectAvailable: Boolean(review?.projectId),
        rawNodeCount: Number(review?.rawSummary?.nodeCount || 0),
        currentNodeCount: Number(review?.currentSummary?.nodeCount || 0),
        reviewDiff: review?.reviewDiff || null,
        extractionFingerprint: review?.currentFingerprint || null,
        observationStatus,
        observationRevision: observation?.revisionId || null,
        observationCoverage: observation?.coverage || null,
        observationUpdatedAt: observation?.observedAt || null,
        enabled: manifest.enabled !== false,
      };
    })
    .filter((manifest) => manifest.enabled)
    .sort((left, right) => left.label.localeCompare(right.label, "zh-Hant"));

  return manifests;
}

function importReferenceFolder({
  sourceFolder,
  label,
  language = DEFAULT_LANGUAGE_TAG,
  source = "imported_folder",
  referenceKind = "translator",
  mangaId = null,
  mangaLabel = null,
  translatorId = null,
  translatorLabel = null,
  chapterId = null,
  chapterTitle = null,
}) {
  const discoveredImages = listReferenceImagesInFolder(sourceFolder);
  if (discoveredImages.length === 0) {
    throw new Error("No supported image files were found in the selected reference folder.");
  }

  const resolvedLabel = String(label || path.basename(sourceFolder)).trim();
  if (!resolvedLabel) {
    throw new Error("Reference label is required.");
  }
  const resolvedLanguage = normalizeLanguageTag(language);

  let referenceSetId = createImportedReferenceSetId();
  let resolvedPaths = referenceSetPaths(referenceSetId);
  while (fs.existsSync(resolvedPaths.manifestPath) || fs.existsSync(resolvedPaths.imagesDir)) {
    referenceSetId = createImportedReferenceSetId();
    resolvedPaths = referenceSetPaths(referenceSetId);
  }

  ensureDir(paths.referenceManifests);
  ensureDir(resolvedPaths.imagesDir);
  ensureDir(resolvedPaths.extractedDir);

  for (const imagePath of discoveredImages) {
    const fileName = path.basename(imagePath);
    fs.copyFileSync(imagePath, path.join(resolvedPaths.imagesDir, fileName));
  }

  const manifest = {
    id: referenceSetId,
    label: resolvedLabel,
    source,
    referenceKind: referenceKind === "source" ? "source" : "translator",
    language: resolvedLanguage,
    pageCount: discoveredImages.length,
    imageDir: `references/other_images/${referenceSetId}`,
    extractedDir: `references/extracted/${referenceSetId}`,
    enabled: true,
    importedFrom: sourceFolder,
    mangaId,
    mangaLabel,
    translatorId,
    translatorLabel,
    chapterId,
    chapterTitle,
    createdAt: new Date().toISOString(),
  };
  validateReferenceManifest(manifest);
  fs.writeFileSync(resolvedPaths.manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  if (mangaId) {
    syncMangaManagementBinding({
      mangaId,
      label: mangaLabel || null,
      translatorId,
      translatorLabel: translatorLabel || translatorId,
      language: resolvedLanguage,
      chapterId,
      chapterTitle,
    });
  }

  return {
    ...manifest,
    sourceFolder,
    referenceKind: manifest.referenceKind,
    mangaId,
    translatorId,
    chapterId,
  };
}

function deleteReferenceSet(referenceSetId) {
  if (!referenceSetId || !String(referenceSetId).trim()) {
    throw new Error("referenceSetId is required.");
  }

  const resolvedPaths = referenceSetPaths(referenceSetId);
  const manifest = fs.existsSync(resolvedPaths.manifestPath)
    ? JSON.parse(fs.readFileSync(resolvedPaths.manifestPath, "utf-8"))
    : null;

  if (!manifest && !fs.existsSync(resolvedPaths.imagesDir) && !fs.existsSync(resolvedPaths.extractedDir)) {
    throw new Error(`Reference set not found: ${referenceSetId}`);
  }

  fs.rmSync(resolvedPaths.manifestPath, { force: true });
  fs.rmSync(resolvedPaths.imagesDir, { recursive: true, force: true });
  fs.rmSync(resolvedPaths.extractedDir, { recursive: true, force: true });
  fs.rmSync(resolvedPaths.comparisonsDir, { recursive: true, force: true });

  return {
    id: referenceSetId,
    label: manifest?.label || referenceSetId,
    deleted: true,
  };
}

function deleteReferenceExtraction(referenceSetId) {
  if (!referenceSetId || !String(referenceSetId).trim()) {
    throw new Error("referenceSetId is required.");
  }

  const resolvedPaths = referenceSetPaths(referenceSetId);
  const manifest = fs.existsSync(resolvedPaths.manifestPath)
    ? JSON.parse(fs.readFileSync(resolvedPaths.manifestPath, "utf-8"))
    : null;

  fs.rmSync(resolvedPaths.extractedDir, { recursive: true, force: true });
  fs.rmSync(resolvedPaths.comparisonsDir, { recursive: true, force: true });

  return {
    id: referenceSetId,
    label: manifest?.label || referenceSetId,
    deleted: true,
    deletedExtraction: true,
  };
}

function normalizeSceneTexts(scene, source = "self") {
  const pages = scene.scene?.pages || {};
  const normalizedPages = [];

  for (const [pageId, page] of Object.entries(pages)) {
    const texts = [];
    for (const [nodeId, node] of Object.entries(page.nodes || {})) {
      const textNode = node.kind?.text;
      if (!textNode || !textNode.text) {
        continue;
      }

      const x = node.transform?.x || 0;
      const y = node.transform?.y || 0;
      const width = node.transform?.width || 0;
      const height = node.transform?.height || 0;

      texts.push({
        nodeId,
        text: textNode.text,
        translation: textNode.translation || null,
        sourceText: textNode.text,
        translatedText: textNode.translation || null,
        bbox: { x, y, width, height },
        center: {
          x: x + width / 2,
          y: y + height / 2,
        },
      });
    }

    normalizedPages.push({
      pageId,
      pageName: page.name,
      texts,
    });
  }

  return {
    source,
    createdAt: new Date().toISOString(),
    pages: normalizedPages,
  };
}

function normalizeEditedSceneTexts(editedScene, source = "post_edit") {
  if (!editedScene || typeof editedScene !== "object") {
    throw new Error("Edited scene document is required.");
  }
  if (!Array.isArray(editedScene.pageOrder) || !editedScene.pages || typeof editedScene.pages !== "object") {
    throw new Error("Edited scene document is missing page data.");
  }

  const normalizedPages = editedScene.pageOrder.map((pageId) => {
    const page = editedScene.pages[pageId];
    if (!page || typeof page !== "object") {
      throw new Error(`Edited scene page is missing: ${pageId}`);
    }

    const texts = (page.nodeOrder || []).map((nodeId) => {
      const node = page.nodes?.[nodeId];
      if (!node || typeof node !== "object") {
        throw new Error(`Edited scene node is missing: ${pageId}/${nodeId}`);
      }

      const x = Number.isFinite(node.anchor?.x) ? node.anchor.x : 0;
      const y = Number.isFinite(node.anchor?.y) ? node.anchor.y : 0;
      const width = Number.isFinite(node.anchor?.width) ? node.anchor.width : 0;
      const height = Number.isFinite(node.anchor?.height) ? node.anchor.height : 0;
      const translatedText =
        typeof node.editedTranslation === "string" ? node.editedTranslation : node.originalTranslation || null;

      return {
        nodeId,
        text: node.originalText || "",
        translation: translatedText,
        sourceText: node.originalText || "",
        translatedText,
        bbox: { x, y, width, height },
        center: {
          x: Number.isFinite(node.anchor?.centerX) ? node.anchor.centerX : x + width / 2,
          y: Number.isFinite(node.anchor?.centerY) ? node.anchor.centerY : y + height / 2,
        },
      };
    });

    return {
      pageId,
      pageName: page.pageName || pageId,
      texts,
    };
  });

  return {
    source,
    createdAt: new Date().toISOString(),
    pages: normalizedPages,
  };
}

function importPostEditReference({
  editedScene,
  label,
  language = DEFAULT_LANGUAGE_TAG,
  source = "post_edit_document",
  referenceKind = "translator",
  mangaId = null,
  mangaLabel = null,
  translatorId = null,
  translatorLabel = null,
  chapterId = null,
  chapterTitle = null,
  sourceJobId = null,
}) {
  const normalizedTexts = normalizeEditedSceneTexts(editedScene, "post_edit");
  const resolvedLabel = String(label || chapterTitle || sourceJobId || "post_edit_reference").trim();
  if (!resolvedLabel) {
    throw new Error("Reference label is required.");
  }
  const resolvedLanguage = normalizeLanguageTag(language);

  let referenceSetId = createImportedReferenceSetId();
  let resolvedPaths = referenceSetPaths(referenceSetId);
  while (fs.existsSync(resolvedPaths.manifestPath) || fs.existsSync(resolvedPaths.imagesDir)) {
    referenceSetId = createImportedReferenceSetId();
    resolvedPaths = referenceSetPaths(referenceSetId);
  }

  ensureDir(paths.referenceManifests);
  ensureDir(resolvedPaths.imagesDir);
  ensureDir(resolvedPaths.extractedDir);

  const manifest = {
    id: referenceSetId,
    label: resolvedLabel,
    source,
    referenceKind: referenceKind === "source" ? "source" : "translator",
    language: resolvedLanguage,
    pageCount: normalizedTexts.pages.length,
    imageDir: `references/other_images/${referenceSetId}`,
    extractedDir: `references/extracted/${referenceSetId}`,
    enabled: true,
    importedFrom: sourceJobId ? `post_edit:${sourceJobId}` : "post_edit",
    mangaId,
    mangaLabel,
    translatorId,
    translatorLabel,
    chapterId,
    chapterTitle,
    createdAt: new Date().toISOString(),
  };
  validateReferenceManifest(manifest);
  fs.writeFileSync(resolvedPaths.manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  fs.writeFileSync(
    resolvedPaths.textsPath,
    JSON.stringify(
      {
        referenceSetId,
        ...normalizedTexts,
      },
      null,
      2
    ),
    "utf-8"
  );

  if (mangaId) {
    syncMangaManagementBinding({
      mangaId,
      label: mangaLabel || null,
      translatorId,
      translatorLabel: translatorLabel || translatorId,
      language: resolvedLanguage,
      chapterId,
      chapterTitle,
    });
  }

  return {
    ...manifest,
    sourceFolder: null,
    referenceKind: manifest.referenceKind,
    mangaId,
    translatorId,
    chapterId,
    textsPath: resolvedPaths.textsPath,
  };
}

module.exports = {
  ensureDir,
  importPostEditReference,
  loadExtractedTexts,
  loadReferenceManifest,
  listReferenceSets,
  listReferenceImagesInFolder,
  normalizeEditedSceneTexts,
  normalizeSceneTexts,
  referenceSetPaths,
  deleteReferenceExtraction,
  deleteReferenceSet,
  importReferenceFolder,
  validateReferenceManifest,
};
