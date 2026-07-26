const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { config = { agent: {} } } = require("../config");
const { buildTaskRequest } = require("../ao_prompt_templates");
const {
  loadExtractedTexts,
  loadReferenceManifest,
  referenceSetPaths,
} = require("./reference_sets");

const OBSERVATION_SCHEMA_VERSION = 1;
const OBSERVER_CONTRACT_VERSION = "chapter-observer-v1";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readJson(filePath) {
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : null;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function computeExtractionFingerprint(referenceSetId, extractedTexts) {
  const review = readJson(referenceSetPaths(referenceSetId).reviewMetadataPath);
  return review?.currentFingerprint || sha256(JSON.stringify(extractedTexts));
}

function computeObserverContractHash() {
  const files = [
    path.join(__dirname, "..", "chapter_observation_contract.js"),
    path.join(__dirname, "..", "..", "ao", "agents", "chapter-observer.md"),
    path.join(__dirname, "..", "..", "ao", "skills", "chapter-observation-contract", "SKILL.md"),
  ];
  const taskRequest = buildTaskRequest("chapter_observation", {}, {
    outputFilePath: "output/chapter_observation.txt",
  });
  return sha256([
    ...files.map((filePath) => fs.readFileSync(filePath, "utf8")),
    JSON.stringify(taskRequest),
  ].join("\n---\n"));
}

function observationCacheKey({ extractionFingerprint, observerContractHash, model, contentLanguage }) {
  return sha256(JSON.stringify({
    extractionFingerprint,
    observerContractHash,
    model: model || null,
    contentLanguage,
  }));
}

function scenePages(scene) {
  const pages = scene?.scene?.pages;
  return pages && typeof pages === "object" ? Object.values(pages) : [];
}

function buildScenePageIndex(scene) {
  const index = new Map();
  for (const page of scenePages(scene)) {
    if (page?.id) index.set(String(page.id), page);
    if (page?.name) index.set(String(page.name), page);
  }
  return index;
}

function compactFontHints(textKind) {
  const font = textKind?.fontPrediction?.namedFonts?.[0] || null;
  return {
    detectedFontSizePx: Number.isFinite(textKind?.detectedFontSizePx)
      ? textKind.detectedFontSizePx
      : null,
    namedFont: typeof font?.name === "string" ? font.name : null,
    serif: typeof font?.serif === "boolean" ? font.serif : null,
    probability: Number.isFinite(font?.probability) ? font.probability : null,
    angleDeg: Number.isFinite(textKind?.fontPrediction?.angleDeg)
      ? textKind.fontPrediction.angleDeg
      : null,
  };
}

function buildKnownCharacters(glossary, storyContext) {
  const entries = new Map();
  const add = (entry) => {
    const name = String(
      entry?.canonical_translation || entry?.name || entry?.canonicalForm || entry?.source_name || ""
    ).trim();
    if (!name) return;
    const aliases = [
      ...(Array.isArray(entry?.aliases) ? entry.aliases : []),
      ...(Array.isArray(entry?.title_forms) ? entry.title_forms : []),
      ...(Array.isArray(entry?.titleForms) ? entry.titleForms : []),
    ].map((value) => String(value || "").trim()).filter(Boolean);
    const existing = entries.get(name) || { name, aliases: [] };
    existing.aliases = [...new Set([...existing.aliases, ...aliases])];
    entries.set(name, existing);
  };
  for (const entry of glossary?.entries || []) {
    if (entry?.category === "character_name" || entry?.entity_type === "character") add(entry);
  }
  for (const chapter of Object.values(storyContext?.chapters || {})) {
    for (const character of chapter?.characters || []) add(character);
  }
  return [...entries.values()].slice(0, 40);
}

function compactStoryContext(storyContext) {
  return Object.values(storyContext?.chapters || {}).slice(-3).map((chapter) => ({
    chapterId: chapter?.chapterId || null,
    characters: (chapter?.characters || []).slice(0, 20),
    events: (chapter?.events || []).slice(0, 8),
    keyLines: (chapter?.keyLines || []).slice(0, 8),
  }));
}

function buildObservationTaskInput({
  referenceSetId,
  chapterId,
  chapterTitle,
  contentLanguage,
  referenceKind,
  extractedTexts,
  scene,
  glossary,
  storyContext,
}) {
  const observationTexts = {
    ...extractedTexts,
    pages: (extractedTexts?.pages || []).map((page) => ({
      ...page,
      texts: (page?.texts || []).map((node) => {
        const sourceText = String(node?.sourceText || node?.text || "").trim();
        const targetText = String(
          node?.translatedText || node?.translation || node?.targetText || sourceText
        ).trim();
        return {
          ...node,
          sourceText: referenceKind === "translator" ? targetText : sourceText,
        };
      }),
    })),
  };
  const sceneIndex = buildScenePageIndex(scene);
  const pages = observationTexts.pages.flatMap((page) => {
    const pageName = String(page?.pageName || page?.pageId || "").trim();
    if (!pageName) return [];
    const scenePage = sceneIndex.get(String(page?.pageId || "")) || sceneIndex.get(pageName) || null;
    const nodes = (page?.texts || []).flatMap((textNode, readingOrder) => {
      const nodeId = String(textNode?.nodeId || "").trim();
      const text = String(textNode?.sourceText || textNode?.text || "").trim();
      if (!nodeId || !text) return [];
      const sceneNode = scenePage?.nodes?.[nodeId] || null;
      const textKind = sceneNode?.kind?.text || null;
      return [{
        nodeId,
        text,
        readingOrder,
        bbox: textNode?.bbox || sceneNode?.transform || null,
        ocrConfidence: Number.isFinite(textKind?.confidence) ? textKind.confidence : null,
        sourceDirection: textKind?.sourceDirection || null,
        fontHints: compactFontHints(textKind),
      }];
    });
    return nodes.length > 0 ? [{
      pageName,
      pageId: pageName,
      width: Number.isFinite(scenePage?.width) ? scenePage.width : null,
      height: Number.isFinite(scenePage?.height) ? scenePage.height : null,
      nodes,
    }] : [];
  });
  const extractedNodeByKey = new Map(
    (extractedTexts?.pages || []).flatMap((page) => {
      const pageName = String(page?.pageName || page?.pageId || "").trim();
      return (page?.texts || []).map((node) => [`${pageName}::${node?.nodeId}`, node]);
    })
  );
  return {
    jobId: `reference_observation:${referenceSetId}`,
    chapterId,
    chapterTitle,
    contentLanguage,
    knownCharacters: buildKnownCharacters(glossary, storyContext),
    storyContext: compactStoryContext(storyContext),
    referenceSetId,
    referenceKind,
    compactStoryContext: compactStoryContext(storyContext),
    pages: pages.map((page) => ({
      ...page,
      pageId: page.pageName,
      nodes: page.nodes.map((node) => {
        const extractedNode = extractedNodeByKey.get(`${page.pageName}::${node.nodeId}`) || {};
        const sourceText = String(extractedNode.sourceText || extractedNode.text || "").trim();
        const targetText = String(
          extractedNode.translatedText ||
          extractedNode.translation ||
          extractedNode.targetText ||
          sourceText
        ).trim();
        return {
          ...node,
          text: referenceKind === "translator" ? targetText : sourceText,
        };
      }),
    })),
  };
}

function buildRoleAwareObservationNodes(texts, observation) {
  const roleIndex = new Map((observation?.nodes || []).map((record) => [
    `${record.pageName}\u0000${record.nodeId}`,
    record,
  ]));
  return (texts?.pages || []).flatMap((page) =>
    (page?.texts || []).flatMap((node) => {
      const role = roleIndex.get(`${page.pageName}\u0000${node.nodeId}`);
      if (!role) return [];
      return [{
        pageName: page.pageName,
        nodeId: node.nodeId,
        text: String(
          observation?.referenceKind === "translator"
            ? node?.translatedText || node?.translation || node?.targetText || node?.sourceText || node?.text || ""
            : node?.sourceText || node?.text || ""
        ).trim(),
        textRole: role.textRole,
        speakerType: role.speakerType,
        speakerRef: role.speakerRef || null,
        styleChannel: role.styleChannel,
        roleConfidence: role.roleConfidence,
        speakerConfidence: role.speakerConfidence,
      }];
    })
  );
}

function buildObservationDocument({
  referenceSetId,
  chapterId,
  chapterTitle,
  manifest,
  extractionFingerprint,
  observerContractHash,
  cacheKey,
  model,
  result,
}) {
  const observedAt = new Date().toISOString();
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    referenceSetId,
    referenceKind: manifest.referenceKind === "source" ? "source" : "translator",
    chapterId,
    chapterTitle: chapterTitle || null,
    contentLanguage: manifest.language,
    extractionFingerprint,
    observerContractVersion: OBSERVER_CONTRACT_VERSION,
    observerContractHash,
    cacheKey,
    model: model || null,
    observedAt,
    revisionId: `observation_${observedAt.replace(/[-:.TZ]/g, "")}_${cacheKey.slice(0, 12)}`,
    nodes: result.nodes,
    mentions: result.mentions,
    storyCues: result.storyCues,
    notes: result.notes,
    coverage: result.coverage,
    warnings: result.warnings || [],
  };
}

function loadChapterObservation(referenceSetId) {
  return readJson(referenceSetPaths(referenceSetId).observationPath);
}

function inspectChapterObservation(referenceSetId, { model = config.agent?.model || null } = {}) {
  const paths = referenceSetPaths(referenceSetId);
  const observation = readJson(paths.observationPath);
  if (!observation) return { status: "missing", observation: null };
  const extractedTexts = loadExtractedTexts(referenceSetId);
  const extractionFingerprint = computeExtractionFingerprint(referenceSetId, extractedTexts);
  const observerContractHash = computeObserverContractHash();
  const staleReasons = [];
  if (observation.extractionFingerprint !== extractionFingerprint) staleReasons.push("extraction_changed");
  if (observation.observerContractHash !== observerContractHash) staleReasons.push("observer_contract_changed");
  if ((observation.model || null) !== (model || null)) staleReasons.push("observer_model_changed");
  const manifest = loadReferenceManifest(referenceSetId);
  if (observation.contentLanguage !== manifest.language) staleReasons.push("content_language_changed");
  return {
    status: staleReasons.length > 0 ? "stale" : "complete",
    staleReasons,
    observation,
  };
}

async function ensureChapterObservation({
  aoTaskRunner,
  referenceSetId,
  chapterId,
  chapterTitle,
  glossary = null,
  storyContext = null,
  force = false,
  isCanceled = null,
  onProgress = null,
}) {
  if (!aoTaskRunner || typeof aoTaskRunner.runChapterObservation !== "function") {
    throw new Error("Chapter observation requires aoTaskRunner.runChapterObservation().");
  }
  const manifest = loadReferenceManifest(referenceSetId);
  const extractedTexts = loadExtractedTexts(referenceSetId);
  const paths = referenceSetPaths(referenceSetId);
  const extractionFingerprint = computeExtractionFingerprint(referenceSetId, extractedTexts);
  const observerContractHash = computeObserverContractHash();
  const model = aoTaskRunner.settings?.model || null;
  const cacheKey = observationCacheKey({
    extractionFingerprint,
    observerContractHash,
    model,
    contentLanguage: manifest.language,
  });
  const revisionPath = path.join(paths.observationRevisionsDir, `${cacheKey}.json`);
  if (!force) {
    const cached = readJson(revisionPath);
    if (cached) {
      writeJsonAtomic(paths.observationPath, cached);
      return { observation: cached, observationPath: paths.observationPath, reused: true };
    }
  }
  const scene = readJson(paths.scenePath);
  const input = buildObservationTaskInput({
    referenceSetId,
    chapterId,
    chapterTitle,
    contentLanguage: manifest.language,
    referenceKind: manifest.referenceKind,
    extractedTexts,
    scene,
    glossary,
    storyContext,
  });
  const result = await aoTaskRunner.runChapterObservation(input, {
    outputFilePath: "output/chapter_observation.txt",
    isCanceled,
    onProgress,
  });
  const observation = buildObservationDocument({
    referenceSetId,
    chapterId,
    chapterTitle,
    manifest,
    extractionFingerprint,
    observerContractHash,
    cacheKey,
    model,
    result,
  });
  writeJsonAtomic(revisionPath, observation);
  writeJsonAtomic(paths.observationPath, observation);
  return { observation, observationPath: paths.observationPath, reused: false };
}

function observationAsRoleView(observation) {
  return {
    chapterId: observation.chapterId,
    chapterTitle: observation.chapterTitle,
    contentLanguage: observation.contentLanguage,
    records: observation.nodes.map((node) => ({ ...node, source: "chapter_observer" })),
    coverage: observation.coverage,
    warnings: observation.warnings || [],
  };
}

function observationAsExtractionResult(observation) {
  const terminologyEntries = [];
  const characterEntries = [];
  for (const mention of observation.mentions || []) {
    const exampleLines = mention.evidenceNodeKeys.map((key) => {
      const separator = key.lastIndexOf("::");
      return {
        pageName: separator >= 0 ? key.slice(0, separator) : null,
        nodeId: separator >= 0 ? key.slice(separator + 2) : key,
      };
    });
    if (mention.entityType === "character") {
      characterEntries.push({
        source_name: observation.referenceKind === "source" ? mention.surfaceForm : null,
        canonical_name: mention.surfaceForm,
        name: mention.surfaceForm,
        aliases: [],
        title_forms: [],
        confidence: mention.confidence,
        reason: mention.reason,
        example_lines: exampleLines,
      });
    } else {
      terminologyEntries.push({
        source_term: observation.referenceKind === "source" ? mention.surfaceForm : null,
        term: mention.surfaceForm,
        translation: observation.referenceKind === "translator" ? mention.surfaceForm : null,
        category: mention.entityType,
        confidence: mention.confidence,
        reason: mention.reason,
        evidence_node_keys: mention.evidenceNodeKeys,
      });
    }
  }
  return {
    terminologyEntries,
    characterEntries,
    candidateEntries: [],
    rejectedEntries: [],
    notes: (observation.notes || []).join(" "),
    observationRevisionId: observation.revisionId,
  };
}

function buildStoryNodesFromObservation(observation, extractedTexts, { minimumConfidence = 0.6 } = {}) {
  const allNodes = (extractedTexts.pages || []).flatMap((page) =>
    (page.texts || []).map((node, index) => ({
      pageName: page.pageName,
      nodeId: node.nodeId,
      text: String(node.sourceText || node.text || "").trim(),
      index,
    }))
  );
  const selected = new Set(
    (observation.storyCues || [])
      .filter((cue) => cue.confidence >= minimumConfidence)
      .flatMap((cue) => cue.evidenceNodeKeys)
  );
  const roleByKey = new Map(observation.nodes.map((node) => [`${node.pageName}::${node.nodeId}`, node]));
  const include = new Set();
  allNodes.forEach((node, index) => {
    if (!selected.has(`${node.pageName}::${node.nodeId}`)) return;
    include.add(index);
    if (index > 0) include.add(index - 1);
    if (index + 1 < allNodes.length) include.add(index + 1);
  });
  return allNodes.filter((_, index) => include.has(index)).map((node) => {
    const role = roleByKey.get(`${node.pageName}::${node.nodeId}`);
    return {
      pageName: node.pageName,
      nodeId: node.nodeId,
      text: node.text,
      textRole: role?.textRole || "uncertain",
      speakerType: role?.speakerType || "uncertain",
      speakerRef: role?.speakerRef || null,
      styleChannel: role?.styleChannel || "unknown",
      roleConfidence: role?.roleConfidence || 0,
      speakerConfidence: role?.speakerConfidence || 0,
      selectedStoryCue: selected.has(`${node.pageName}::${node.nodeId}`),
    };
  });
}

async function runReferenceDeepReview({
  aoTaskRunner,
  referenceSetId,
  nodeKeys = [],
  reviewReason,
  compactMemory = null,
  isCanceled = null,
  onProgress = null,
}) {
  if (!aoTaskRunner || typeof aoTaskRunner.runReferenceDeepReview !== "function") {
    throw new Error("Reference deep review requires aoTaskRunner.runReferenceDeepReview().");
  }
  const inspection = inspectChapterObservation(referenceSetId);
  if (inspection.status !== "complete") {
    throw new Error("Reference deep review requires a current chapter observation.");
  }
  const observation = inspection.observation;
  const manifest = loadReferenceManifest(referenceSetId);
  const extractedTexts = loadExtractedTexts(referenceSetId);
  const scene = readJson(referenceSetPaths(referenceSetId).scenePath);
  const fullInput = buildObservationTaskInput({
    referenceSetId,
    chapterId: observation.chapterId,
    chapterTitle: observation.chapterTitle,
    contentLanguage: manifest.language,
    referenceKind: observation.referenceKind,
    extractedTexts,
    scene,
    glossary: null,
    storyContext: null,
  });
  const flattened = fullInput.pages.flatMap((page) =>
    page.nodes.map((node) => ({ pageName: page.pageName, nodeId: node.nodeId }))
  );
  const requested = new Set(nodeKeys);
  if (requested.size === 0) {
    for (const node of observation.nodes) {
      if (node.textRole === "uncertain" || node.roleConfidence < 0.6 || node.speakerConfidence < 0.45) {
        requested.add(`${node.pageName}::${node.nodeId}`);
      }
    }
  }
  if (requested.size === 0) throw new Error("Reference deep review found no low-confidence or requested nodes.");
  const included = new Set();
  flattened.forEach((node, index) => {
    if (!requested.has(`${node.pageName}::${node.nodeId}`)) return;
    included.add(`${node.pageName}::${node.nodeId}`);
    if (index > 0) included.add(`${flattened[index - 1].pageName}::${flattened[index - 1].nodeId}`);
    if (index + 1 < flattened.length) included.add(`${flattened[index + 1].pageName}::${flattened[index + 1].nodeId}`);
  });
  const pages = fullInput.pages
    .map((page) => ({
      ...page,
      nodes: page.nodes.filter((node) => included.has(`${page.pageName}::${node.nodeId}`)),
    }))
    .filter((page) => page.nodes.length > 0);
  const input = {
    ...fullInput,
    jobId: `reference_deep_review:${referenceSetId}`,
    reviewReason: String(reviewReason || "low_confidence_evidence"),
    compactMemory,
    existingObservation: observation.nodes.filter((node) =>
      included.has(`${node.pageName}::${node.nodeId}`)
    ),
    pages,
  };
  const result = await aoTaskRunner.runReferenceDeepReview(input, { isCanceled, onProgress });
  const reviewedAt = new Date().toISOString();
  const revision = {
    schemaVersion: 1,
    revisionId: `deep_review_${reviewedAt.replace(/[-:.TZ]/g, "")}`,
    referenceSetId,
    baseObservationRevisionId: observation.revisionId,
    extractionFingerprint: observation.extractionFingerprint,
    reviewReason: input.reviewReason,
    requestedNodeKeys: [...requested],
    reviewedNodeKeys: result.nodes.map((node) => `${node.pageName}::${node.nodeId}`),
    reviewedAt,
    evidence: result,
    appliesAutomatically: false,
  };
  const filePath = path.join(
    referenceSetPaths(referenceSetId).deepReviewRevisionsDir,
    `${revision.revisionId}.json`
  );
  writeJsonAtomic(filePath, revision);
  return { ...revision, filePath };
}

module.exports = {
  OBSERVER_CONTRACT_VERSION,
  buildObservationTaskInput,
  buildRoleAwareObservationNodes,
  buildStoryNodesFromObservation,
  computeObserverContractHash,
  ensureChapterObservation,
  inspectChapterObservation,
  loadChapterObservation,
  observationAsExtractionResult,
  observationAsRoleView,
  observationCacheKey,
  runReferenceDeepReview,
};
