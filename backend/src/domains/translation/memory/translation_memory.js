const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  loadCanonicalGlossary,
  loadKnowledgeBase,
  loadStoryContext,
  loadStyleEvidence,
  loadStyleProfile,
} = require("../../knowledge/assets/knowledge_assets");
const { TranslationPublicationService } = require("../publications/translation_publications");
const { listKnowledgeSeries, resolveKnowledgeAssetPaths } = require("../../knowledge/registry/knowledge_paths");
const { resolveTranslationModePolicy } = require("../modes/translation_modes");
const { listReferenceSets } = require("../../reference/sets/reference_sets");
const { inspectChapterObservation } = require("../../reference/observation/reference_observation");

const SNAPSHOT_SCHEMA_VERSION = 2;
const ORIGINAL_TRANSLATOR_ID = "translator_original";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function chapterNumber(value) {
  const match = String(value || "").match(/(?:chapter|ch|第)?\s*0*(\d+)/i);
  return match ? Number(match[1]) : null;
}

function chapterProfile(series, translatorId) {
  return (series?.translators || []).find((entry) => entry.translatorId === translatorId) || null;
}

function resolveSourceChapterMapping({
  mangaId,
  translatorId,
  sourceChapterId = null,
  chapterId = null,
  chapterTitle = null,
}) {
  const series = listKnowledgeSeries().find((entry) => entry.mangaId === mangaId) || null;
  const sourceChapters = chapterProfile(series, ORIGINAL_TRANSLATOR_ID)?.chapters || [];
  const targetChapters = chapterProfile(series, translatorId)?.chapters || [];
  if (sourceChapterId) return resolveExplicitSourceChapter(sourceChapters, sourceChapterId);
  const target = targetChapters.find((entry) => entry.chapterId === chapterId) || null;
  const number = chapterNumber(chapterTitle) ?? chapterNumber(target?.chapterTitle) ?? chapterNumber(chapterId);
  if (number !== null) return resolveNumericSourceChapter(sourceChapters, number);
  return resolveOrderedSourceChapter(sourceChapters, targetChapters, target);
}

function resolveExplicitSourceChapter(sourceChapters, sourceChapterId) {
  const explicit = sourceChapters.find((entry) => entry.chapterId === sourceChapterId);
  if (!explicit) throw new Error(`Unknown source chapter ${sourceChapterId}.`);
  return {
    sourceChapterId: explicit.chapterId,
    sourceChapterTitle: explicit.chapterTitle || null,
    method: "explicit",
    warning: null,
  };
}

function resolveNumericSourceChapter(sourceChapters, number) {
  const numeric = sourceChapters.find(
    (entry) => chapterNumber(entry.chapterTitle) === number || chapterNumber(entry.chapterId) === number,
  );
  if (numeric) {
    return {
      sourceChapterId: numeric.chapterId,
      sourceChapterTitle: numeric.chapterTitle || null,
      method: "chapter_number",
      warning: null,
    };
  }
  return {
    sourceChapterId: null,
    sourceChapterTitle: null,
    method: "global_only",
    warning: `Source chapter ${number} is unavailable; chapter-local story context was not used.`,
  };
}

function resolveOrderedSourceChapter(sourceChapters, targetChapters, target) {
  const targetIndex = target
    ? [...targetChapters]
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .findIndex((entry) => entry.chapterId === target.chapterId)
    : -1;
  const orderedSource = [...sourceChapters].sort((left, right) => left.sortOrder - right.sortOrder);
  if (targetIndex >= 0 && orderedSource[targetIndex]) {
    const matched = orderedSource[targetIndex];
    return {
      sourceChapterId: matched.chapterId,
      sourceChapterTitle: matched.chapterTitle || null,
      method: "sort_order",
      warning: null,
    };
  }
  return {
    sourceChapterId: null,
    sourceChapterTitle: null,
    method: "global_only",
    warning: "No source chapter could be matched; chapter-local story context is unavailable.",
  };
}

function fileRevision(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function topStyleChapters(styleEvidence, chapterId) {
  const chapters = Object.values(styleEvidence?.chapters || {});
  const exact = chapters.find((entry) => entry?.chapterId === chapterId);
  return exact ? [exact] : chapters.slice(-3);
}

function loadSourceRoleEvidence(mangaId, sourceChapterId) {
  if (!mangaId || !sourceChapterId) return [];
  const reference = listReferenceSets().find(
    (entry) => entry.mangaId === mangaId && entry.referenceKind === "source" && entry.chapterId === sourceChapterId,
  );
  if (!reference) return [];
  const inspected = inspectChapterObservation(reference.id);
  if (inspected.status !== "complete") return [];
  const cueTypesByNodeKey = new Map();
  for (const cue of inspected.observation?.storyCues || []) {
    for (const nodeKey of cue.evidenceNodeKeys || []) {
      const types = cueTypesByNodeKey.get(nodeKey) || [];
      if (cue.cueType && !types.includes(cue.cueType)) types.push(cue.cueType);
      cueTypesByNodeKey.set(nodeKey, types);
    }
  }
  return (inspected.observation?.nodes || []).map((node) => ({
    textFingerprint: node.textFingerprint,
    textRole: node.textRole || null,
    styleChannel: node.styleChannel || null,
    speakerRef: node.speakerRef || null,
    roleConfidence: node.roleConfidence || 0,
    speakerConfidence: node.speakerConfidence || 0,
    storyCueTypes: cueTypesByNodeKey.get(`${node.pageName}::${node.nodeId}`) || [],
  }));
}

function normalizeMemoryParams(input) {
  return {
    qualityCheck: false,
    mangaId: null,
    translatorId: null,
    referenceTranslatorId: null,
    chapterId: null,
    chapterTitle: null,
    sourceChapterId: null,
    glossaryMode: "canonical",
    sourceLanguage: null,
    targetLanguage: null,
    ...input,
  };
}

function composeTranslationMemory(input = {}) {
  const state = initializeMemoryState(normalizeMemoryParams(input));
  if (!state.mangaId || (!state.policy.useReferenceMemory && !state.policy.useLocalMemory))
    return buildEmptyMemorySnapshot(state);
  validateMemoryIds(state);
  resolveMemoryMapping(state);
  loadMemoryPaths(state);
  loadMemoryAssets(state);
  buildMemoryGlossary(state);
  buildMemoryDerived(state);
  buildMemoryReadiness(state);
  buildMemoryRevisions(state);
  return finalizeMemorySnapshot(state);
}

function initializeMemoryState(params) {
  const policy = resolveTranslationModePolicy(params.translationMode, params.qualityCheck);
  const series = params.mangaId
    ? listKnowledgeSeries().find((entry) => entry.mangaId === params.mangaId) || null
    : null;
  return {
    ...params,
    policy,
    series,
    warnings: [],
    resolvedSourceLanguage: params.sourceLanguage || chapterProfile(series, ORIGINAL_TRANSLATOR_ID)?.language || null,
    resolvedTargetLanguage: params.targetLanguage || chapterProfile(series, params.translatorId)?.language || null,
  };
}

function emptyMemoryEffective() {
  return {
    glossary: [],
    sourceIdentity: [],
    story: null,
    style: null,
    localKnowledge: null,
    sourceRoleEvidence: [],
  };
}

function emptyMemoryUsage() {
  return {
    glossaryEntries: 0,
    sourceIdentityEntries: 0,
    storyCharacters: 0,
    storyTerms: 0,
    styleChapters: 0,
    characterSpeechEntries: 0,
    localPairs: 0,
    sourceRoleEvidence: 0,
  };
}

function memoryLanguages(state, referenceLanguage = null) {
  return {
    sourceLanguage: state.resolvedSourceLanguage,
    targetLanguage: state.resolvedTargetLanguage,
    referenceLanguage,
  };
}

function buildEmptyMemorySnapshot(state) {
  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    translationMode: state.translationMode,
    policy: state.policy,
    mangaId: state.mangaId || null,
    translatorId: state.translatorId || null,
    referenceTranslatorId: state.referenceTranslatorId || null,
    chapterId: state.chapterId || null,
    chapterMapping: null,
    layers: { reference: null, local: null },
    effective: emptyMemoryEffective(),
    usage: emptyMemoryUsage(),
    readiness: {
      reference: !state.policy.useReferenceMemory,
      local: !state.policy.useLocalMemory,
    },
    warnings: state.warnings,
    revisions: [],
    languages: memoryLanguages(state),
  };
  snapshot.fingerprint = sha256(JSON.stringify(snapshot));
  return snapshot;
}

function validateMemoryIds(state) {
  if (!state.translatorId) throw new Error(`${state.translationMode} requires translatorId.`);
  if (state.policy.useReferenceMemory && !state.referenceTranslatorId) {
    throw new Error(`${state.translationMode} requires referenceTranslatorId.`);
  }
  state.referenceProfile = state.policy.useReferenceMemory
    ? chapterProfile(state.series, state.referenceTranslatorId)
    : null;
  state.learningProfile = chapterProfile(state.series, state.translatorId);
  if (state.policy.useReferenceMemory && !state.referenceProfile) {
    throw new Error(`Unknown Reference translator profile ${state.referenceTranslatorId}.`);
  }
  if (!state.learningProfile) {
    throw new Error(`Unknown output translator profile ${state.translatorId}.`);
  }
  validateLearningStyle(state);
}

function validateLearningStyle(state) {
  if (state.translationMode !== "learning_style") return;
  if (state.translatorId === state.referenceTranslatorId) {
    throw new Error("Learning Style requires a separate learning clone profile.");
  }
  if (
    state.learningProfile.profileKind !== "learning_clone" ||
    state.learningProfile.styleSourceTranslatorId !== state.referenceTranslatorId
  ) {
    throw new Error("Learning Style output profile must be a clone of the selected Reference translator.");
  }
}

function resolveMemoryMapping(state) {
  state.mapping = state.policy.useReferenceMemory
    ? resolveSourceChapterMapping({
        mangaId: state.mangaId,
        translatorId: state.translatorId,
        sourceChapterId: state.sourceChapterId,
        chapterId: state.chapterId,
        chapterTitle: state.chapterTitle,
      })
    : null;
  if (state.mapping?.warning) state.warnings.push(state.mapping.warning);
}

function loadMemoryPaths(state) {
  state.sourcePaths = resolveKnowledgeAssetPaths({
    mangaId: state.mangaId,
    translatorId: ORIGINAL_TRANSLATOR_ID,
  });
  state.referencePaths = state.policy.useReferenceMemory
    ? resolveKnowledgeAssetPaths({
        mangaId: state.mangaId,
        translatorId: state.referenceTranslatorId,
      })
    : null;
  state.localPaths = resolveKnowledgeAssetPaths({
    mangaId: state.mangaId,
    translatorId: state.translatorId,
  });
}

function loadReferenceMemoryAssets(state) {
  state.sourceGlossary = state.policy.useReferenceMemory
    ? loadCanonicalGlossary(state.mangaId, ORIGINAL_TRANSLATOR_ID)
    : null;
  state.targetGlossary = state.policy.useReferenceMemory
    ? loadCanonicalGlossary(state.mangaId, state.referenceTranslatorId)
    : null;
  state.sourceStory = state.policy.useReferenceMemory ? loadStoryContext(state.mangaId, ORIGINAL_TRANSLATOR_ID) : null;
  state.targetStyleEvidence = state.policy.useReferenceMemory
    ? loadStyleEvidence(state.mangaId, state.referenceTranslatorId)
    : null;
  state.targetStyleProfile = state.policy.useReferenceMemory
    ? loadStyleProfile(state.mangaId, state.referenceTranslatorId)
    : null;
  state.bilingualEvidence =
    state.policy.useReferenceMemory && fs.existsSync(state.referencePaths.bilingualEvidencePath)
      ? JSON.parse(fs.readFileSync(state.referencePaths.bilingualEvidencePath, "utf8"))
      : null;
}

function loadPublicationMemoryAssets(state) {
  state.publicationRegistry =
    state.policy.useLocalMemory && state.mangaId && state.translatorId
      ? new TranslationPublicationService({
          resolveBaseDir: () => state.localPaths.baseDir || path.dirname(state.localPaths.knowledgeBasePath),
        }).load(state.mangaId, state.translatorId)
      : null;
  state.activePublications = Object.values(state.publicationRegistry?.chapters || {})
    .map((chapter) => chapter.revisions.find((entry) => entry.revisionId === chapter.activeRevisionId))
    .filter(Boolean);
  state.unverifiedPublications = state.activePublications.filter((entry) => entry.qualityStatus === "unverified");
  state.pendingKnowledge = state.activePublications.filter(
    (entry) =>
      entry.qualityStatus === "passed" && entry.learningEvidenceSnapshotPath && entry.knowledgeStatus !== "committed",
  );
  state.localKnowledgeReady = state.pendingKnowledge.length === 0 && state.unverifiedPublications.length === 0;
  state.localKnowledge =
    state.policy.useLocalMemory && state.localKnowledgeReady
      ? loadKnowledgeBase(state.mangaId, state.translatorId)
      : null;
}

function loadMemoryAssets(state) {
  loadReferenceMemoryAssets(state);
  loadPublicationMemoryAssets(state);
}

function selectCanonicalGlossary(state) {
  return state.glossaryMode === "disabled"
    ? []
    : (state.targetGlossary?.entries || []).filter(
        (entry) =>
          entry.locked === true ||
          entry.source === "manual" ||
          entry.source === "reference_bilingual_evidence" ||
          entry.reference_kind === "translator",
      );
}

function selectLocalTerms(state) {
  return state.policy.useLocalMemory && state.glossaryMode !== "disabled"
    ? (state.localKnowledge?.terminology || []).filter((entry) => entry.status === "stable" || entry.locked === true)
    : [];
}

function mergeMemoryGlossary(canonical, localTerms) {
  const glossary = [...canonical];
  const seenGlossary = new Set(glossary.map((entry) => entry.source_term || entry.term));
  for (const entry of localTerms)
    if (!seenGlossary.has(entry.term))
      glossary.push({
        source_term: entry.term,
        canonical_translation: entry.translation,
        category: entry.category,
        aliases: entry.aliases || [],
        confidence: entry.confidence,
        source: "self",
      });
  return glossary;
}

function buildSourceIdentity(sourceGlossary) {
  return (sourceGlossary?.entries || [])
    .map((entry) => ({
      sourceTerm: entry.source_term || entry.canonical_form || null,
      canonicalForm: entry.canonical_form || entry.source_term || null,
      category: entry.category || null,
      confidence: entry.confidence || null,
    }))
    .filter((entry) => entry.sourceTerm);
}

function buildMemoryGlossary(state) {
  const canonical = selectCanonicalGlossary(state);
  const localTerms = selectLocalTerms(state);
  state.canonical = canonical;
  state.localTerms = localTerms;
  state.glossary = mergeMemoryGlossary(canonical, localTerms);
  state.sourceIdentity = buildSourceIdentity(state.sourceGlossary);
}

function buildMemoryDerived(state) {
  state.storyChapter = state.mapping?.sourceChapterId
    ? state.sourceStory?.chapters?.[state.mapping.sourceChapterId] || null
    : null;
  state.sourceRoleEvidence = state.policy.useReferenceMemory
    ? loadSourceRoleEvidence(state.mangaId, state.mapping?.sourceChapterId || null)
    : [];
  state.styleChapters = topStyleChapters(state.targetStyleEvidence, state.chapterId);
  state.acceptedStylePairs = (state.bilingualEvidence?.stylePairs || [])
    .filter((entry) => entry.status === "accepted")
    .slice(0, 12);
  state.characterSpeech = (state.localKnowledge?.characters || [])
    .filter((entry) => (entry.speech_style || []).length > 0 || (entry.sentence_ending_patterns || []).length > 0)
    .slice(0, 12);
}

function buildMemoryReadiness(state) {
  state.referenceReady =
    !state.policy.useReferenceMemory ||
    Boolean(
      (Object.keys(state.sourceStory?.chapters || {}).length > 0 || (state.sourceGlossary?.entries || []).length > 0) &&
        (state.styleChapters.length > 0 || state.canonical.length > 0),
    );
  state.localReady =
    !state.policy.useLocalMemory ||
    Boolean(
      (state.localKnowledge?.translation_pairs || []).length > 0 ||
        (state.localKnowledge?.terminology || []).length > 0 ||
        (state.localKnowledge?.style_examples || []).length > 0,
    );
  if (!state.referenceReady)
    state.warnings.push(
      "Reference memory is incomplete; source ingestion and translator ingestion must be completed first.",
    );
  if (!state.localReady)
    state.warnings.push("Local learning memory is empty; run learning on at least one completed translation first.");
}

function buildMemoryRevisions(state) {
  state.revisions = [
    fileRevision(state.sourcePaths.glossaryPath),
    fileRevision(state.sourcePaths.storyContextPath),
    fileRevision(state.referencePaths?.glossaryPath),
    fileRevision(state.referencePaths?.styleEvidencePath),
    fileRevision(state.referencePaths?.styleProfilePath),
    fileRevision(state.referencePaths?.bilingualEvidencePath),
    fileRevision(state.localPaths.knowledgeBasePath),
  ].filter(Boolean);
}

function buildMemoryLayers(state) {
  return {
    reference: state.policy.useReferenceMemory
      ? {
          sourceTranslatorId: ORIGINAL_TRANSLATOR_ID,
          referenceTranslatorId: state.referenceTranslatorId,
          learningTranslatorId: state.translatorId,
          sourceStoryAvailable: Boolean(state.sourceStory),
          targetStyleAvailable: state.styleChapters.length > 0,
        }
      : null,
    local: state.policy.useLocalMemory
      ? {
          available: Boolean(state.localKnowledge),
          knowledgeReady: state.localKnowledgeReady,
          pendingKnowledgeChapterIds: state.pendingKnowledge.map((entry) => entry.chapterId),
          unverifiedChapterIds: state.unverifiedPublications.map((entry) => entry.chapterId),
        }
      : null,
  };
}

function buildMemoryEffective(state) {
  return {
    glossary: state.glossary.slice(0, 60),
    sourceIdentity: state.sourceIdentity.slice(0, 60),
    story: state.policy.useReferenceMemory
      ? {
          global: state.sourceStory?.global || null,
          chapter: state.storyChapter,
        }
      : null,
    style: state.policy.useReferenceMemory
      ? {
          profile: state.targetStyleProfile?.rules || {},
          chapters: state.styleChapters,
          bilingualPairs: state.acceptedStylePairs,
          characterSpeech: state.characterSpeech,
        }
      : null,
    localKnowledge: state.policy.useLocalMemory
      ? {
          styleProfile: state.localKnowledge?.style_profile || null,
          styleExamples: (state.localKnowledge?.style_examples || []).slice(-12),
          translationPairs: state.localKnowledge?.translation_pairs || [],
        }
      : null,
    sourceRoleEvidence: state.sourceRoleEvidence,
  };
}

function buildMemoryUsage(state) {
  return {
    glossaryEntries: state.glossary.length,
    sourceIdentityEntries: state.sourceIdentity.length,
    storyCharacters: state.sourceStory?.global?.characters?.length || 0,
    storyTerms: state.sourceStory?.global?.terminology?.length || 0,
    styleChapters: state.styleChapters.length,
    characterSpeechEntries: state.characterSpeech.length,
    localPairs: state.localKnowledge?.translation_pairs?.length || 0,
    sourceRoleEvidence: state.sourceRoleEvidence.length,
  };
}

function buildMemoryWarnings(state) {
  return [
    ...state.warnings,
    ...(state.pendingKnowledge.length > 0
      ? [
          {
            code: "local_memory_knowledge_pending",
            chapterIds: state.pendingKnowledge.map((entry) => entry.chapterId),
          },
        ]
      : []),
    ...(state.unverifiedPublications.length > 0
      ? [
          {
            code: "local_memory_publication_unverified",
            chapterIds: state.unverifiedPublications.map((entry) => entry.chapterId),
          },
        ]
      : []),
  ];
}

function finalizeMemorySnapshot(state) {
  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    translationMode: state.translationMode,
    policy: state.policy,
    mangaId: state.mangaId,
    translatorId: state.translatorId,
    referenceTranslatorId: state.referenceTranslatorId,
    chapterId: state.chapterId || null,
    chapterMapping: state.mapping,
    layers: buildMemoryLayers(state),
    effective: buildMemoryEffective(state),
    usage: buildMemoryUsage(state),
    readiness: { reference: state.referenceReady, local: state.localReady },
    warnings: buildMemoryWarnings(state),
    revisions: state.revisions,
    languages: {
      sourceLanguage: state.resolvedSourceLanguage,
      targetLanguage: state.resolvedTargetLanguage,
      referenceLanguage: state.referenceProfile?.language || null,
    },
  };
  snapshot.fingerprint = sha256(JSON.stringify(snapshot));
  return snapshot;
}

function assertTranslationMemoryReady(snapshot) {
  if (snapshot.policy.useReferenceMemory && !snapshot.readiness.reference) {
    throw new Error("Translation mode requires completed source and translator Reference memory.");
  }
  if (snapshot.translationMode === "local_style" && !snapshot.readiness.local) {
    throw new Error("Local style mode requires existing learned translation memory.");
  }
  if (snapshot.policy.useLocalMemory && snapshot.layers?.local?.knowledgeReady === false) {
    if ((snapshot.layers.local.unverifiedChapterIds || []).length > 0) {
      throw new Error(
        `Local memory contains unverified publication chapter(s): ${snapshot.layers.local.unverifiedChapterIds.join(", ")}.`,
      );
    }
    throw new Error(
      `Local memory is waiting for Knowledge commit for chapter(s): ${snapshot.layers.local.pendingKnowledgeChapterIds.join(", ")}.`,
    );
  }
}

function formatTranslationMemoryPrompt(snapshot) {
  if (!snapshot || (!snapshot.policy.useReferenceMemory && !snapshot.policy.useLocalMemory)) return null;
  const lines = [
    "You are translating manga text into Traditional Chinese.",
    `Translation mode: ${snapshot.translationMode}.`,
    `Memory fingerprint: ${snapshot.fingerprint}.`,
  ];
  appendMemoryGlossaryLines(lines, snapshot);
  appendMemorySourceIdentityLines(lines, snapshot);
  appendMemoryStoryLines(lines, snapshot);
  appendMemoryStyleLines(lines, snapshot);
  appendMemoryLocalLines(lines, snapshot);
  return lines.join("\n");
}

function normalizeTranslationInstructions(instructions) {
  return typeof instructions === "string" && instructions.trim() ? instructions.trim() : null;
}

function buildTranslationSystemPrompt(snapshot, instructions = null) {
  const memoryPrompt = formatTranslationMemoryPrompt(snapshot);
  const normalizedInstructions = normalizeTranslationInstructions(instructions);
  const instructionPrompt = normalizedInstructions
    ? `User retranslation instructions:\n${normalizedInstructions}`
    : null;
  const text = [memoryPrompt, instructionPrompt].filter(Boolean).join("\n\n") || null;
  const source = memoryPrompt && instructionPrompt
    ? "translation_memory_and_user_instructions"
    : memoryPrompt ? "translation_memory" : instructionPrompt ? "user_instructions" : "none";
  return { text, source };
}

function appendMemoryGlossaryLines(lines, snapshot) {
  if (snapshot.effective.glossary.length === 0) return;
  lines.push("Canonical terminology (must follow):");
  for (const entry of snapshot.effective.glossary.slice(0, 40)) {
    lines.push(`- ${entry.source_term || entry.term} => ${entry.canonical_translation || entry.translation}`);
  }
}

function appendMemorySourceIdentityLines(lines, snapshot) {
  if (snapshot.effective.sourceIdentity.length === 0) return;
  lines.push("Original-language named entities (identity only; do not copy as target renderings):");
  for (const entry of snapshot.effective.sourceIdentity.slice(0, 30))
    lines.push(`- ${entry.sourceTerm} [${entry.category || "term"}]`);
}

function appendMemoryStoryLines(lines, snapshot) {
  const story = snapshot.effective.story;
  if (story?.global?.summary) lines.push(`Global story context: ${story.global.summary}`);
  if (story?.chapter?.summary) lines.push(`Current chapter context: ${story.chapter.summary}`);
  for (const event of (story?.chapter?.events || []).slice(0, 6))
    lines.push(`- Story event: ${event.summary || event.event || event}`);
}

function appendMemoryStyleLines(lines, snapshot) {
  const style = snapshot.effective.style;
  if (!style) return;
  lines.push(`Translator style constraints: ${JSON.stringify(style.profile || {})}`);
  for (const chapter of style.chapters || []) appendMemoryStyleChapterLines(lines, chapter);
  for (const character of style.characterSpeech || []) {
    lines.push(`- Character voice ${character.name}: ${(character.speech_style || []).join(", ")}`);
  }
}

function appendMemoryStyleChapterLines(lines, chapter) {
  for (const sample of (chapter.dialogueSamples || []).slice(0, 2)) lines.push(`- Dialogue example: ${sample}`);
  for (const sample of (chapter.narrationSamples || []).slice(0, 2)) lines.push(`- Narration example: ${sample}`);
}

function appendMemoryLocalLines(lines, snapshot) {
  const local = snapshot.effective.localKnowledge;
  for (const example of local?.styleExamples || [])
    lines.push(`- Learned ${example.type || "style"} example: ${example.translation}`);
}

module.exports = {
  ORIGINAL_TRANSLATOR_ID,
  SNAPSHOT_SCHEMA_VERSION,
  chapterNumber,
  assertTranslationMemoryReady,
  buildTranslationSystemPrompt,
  composeTranslationMemory,
  formatTranslationMemoryPrompt,
  resolveSourceChapterMapping,
};
