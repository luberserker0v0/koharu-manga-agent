const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  loadCanonicalGlossary,
  loadKnowledgeBase,
  loadStoryContext,
  loadStyleEvidence,
  loadStyleProfile,
} = require("./knowledge_assets");
const { TranslationPublicationService } = require("./translation_publications");
const { listKnowledgeSeries, resolveKnowledgeAssetPaths } = require("./knowledge_paths");
const { resolveTranslationModePolicy } = require("./translation_modes");
const { listReferenceSets } = require("./reference_sets");
const { inspectChapterObservation } = require("./reference_observation");

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

function resolveSourceChapterMapping({ mangaId, translatorId, sourceChapterId = null, chapterId = null, chapterTitle = null }) {
  const series = listKnowledgeSeries().find((entry) => entry.mangaId === mangaId) || null;
  const sourceChapters = chapterProfile(series, ORIGINAL_TRANSLATOR_ID)?.chapters || [];
  const targetChapters = chapterProfile(series, translatorId)?.chapters || [];
  if (sourceChapterId) {
    const explicit = sourceChapters.find((entry) => entry.chapterId === sourceChapterId);
    if (!explicit) throw new Error(`Unknown source chapter ${sourceChapterId}.`);
    return { sourceChapterId: explicit.chapterId, sourceChapterTitle: explicit.chapterTitle || null, method: "explicit", warning: null };
  }

  const target = targetChapters.find((entry) => entry.chapterId === chapterId) || null;
  const number = chapterNumber(chapterTitle) ?? chapterNumber(target?.chapterTitle) ?? chapterNumber(chapterId);
  if (number !== null) {
    const numeric = sourceChapters.find((entry) =>
      chapterNumber(entry.chapterTitle) === number || chapterNumber(entry.chapterId) === number
    );
    if (numeric) {
      return { sourceChapterId: numeric.chapterId, sourceChapterTitle: numeric.chapterTitle || null, method: "chapter_number", warning: null };
    }
    return {
      sourceChapterId: null,
      sourceChapterTitle: null,
      method: "global_only",
      warning: `Source chapter ${number} is unavailable; chapter-local story context was not used.`,
    };
  }

  const targetIndex = target
    ? [...targetChapters].sort((left, right) => left.sortOrder - right.sortOrder).findIndex((entry) => entry.chapterId === target.chapterId)
    : -1;
  const orderedSource = [...sourceChapters].sort((left, right) => left.sortOrder - right.sortOrder);
  if (targetIndex >= 0 && orderedSource[targetIndex]) {
    const matched = orderedSource[targetIndex];
    return { sourceChapterId: matched.chapterId, sourceChapterTitle: matched.chapterTitle || null, method: "sort_order", warning: null };
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
  return { path: filePath, size: stat.size, modifiedAt: stat.mtime.toISOString() };
}

function topStyleChapters(styleEvidence, chapterId) {
  const chapters = Object.values(styleEvidence?.chapters || {});
  const exact = chapters.find((entry) => entry?.chapterId === chapterId);
  return exact ? [exact] : chapters.slice(-3);
}

function loadSourceRoleEvidence(mangaId, sourceChapterId) {
  if (!mangaId || !sourceChapterId) return [];
  const reference = listReferenceSets().find((entry) =>
    entry.mangaId === mangaId && entry.referenceKind === "source" && entry.chapterId === sourceChapterId
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

function composeTranslationMemory({
  translationMode,
  qualityCheck = false,
  mangaId = null,
  translatorId = null,
  referenceTranslatorId = null,
  chapterId = null,
  chapterTitle = null,
  sourceChapterId = null,
  glossaryMode = "canonical",
  sourceLanguage = null,
  targetLanguage = null,
}) {
  const policy = resolveTranslationModePolicy(translationMode, qualityCheck);
  const warnings = [];
  const series = mangaId ? listKnowledgeSeries().find((entry) => entry.mangaId === mangaId) || null : null;
  const resolvedSourceLanguage = sourceLanguage || chapterProfile(series, ORIGINAL_TRANSLATOR_ID)?.language || null;
  const resolvedTargetLanguage = targetLanguage || chapterProfile(series, translatorId)?.language || null;
  if (!mangaId || (!policy.useReferenceMemory && !policy.useLocalMemory)) {
    const snapshot = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      translationMode,
      policy,
      mangaId: mangaId || null,
      translatorId: translatorId || null,
      referenceTranslatorId: referenceTranslatorId || null,
      chapterId: chapterId || null,
      chapterMapping: null,
      layers: { reference: null, local: null },
      effective: { glossary: [], sourceIdentity: [], story: null, style: null, localKnowledge: null, sourceRoleEvidence: [] },
      usage: { glossaryEntries: 0, sourceIdentityEntries: 0, storyCharacters: 0, storyTerms: 0, styleChapters: 0, characterSpeechEntries: 0, localPairs: 0, sourceRoleEvidence: 0 },
      readiness: { reference: !policy.useReferenceMemory, local: !policy.useLocalMemory },
      warnings,
      revisions: [],
      languages: { sourceLanguage: resolvedSourceLanguage, targetLanguage: resolvedTargetLanguage, referenceLanguage: null },
    };
    snapshot.fingerprint = sha256(JSON.stringify(snapshot));
    return snapshot;
  }
  if (!translatorId) throw new Error(`${translationMode} requires translatorId.`);
  if (policy.useReferenceMemory && !referenceTranslatorId) {
    throw new Error(`${translationMode} requires referenceTranslatorId.`);
  }
  const referenceProfile = policy.useReferenceMemory
    ? chapterProfile(series, referenceTranslatorId)
    : null;
  const learningProfile = chapterProfile(series, translatorId);
  if (policy.useReferenceMemory && !referenceProfile) {
    throw new Error(`Unknown Reference translator profile ${referenceTranslatorId}.`);
  }
  if (!learningProfile) {
    throw new Error(`Unknown output translator profile ${translatorId}.`);
  }
  if (translationMode === "learning_style") {
    if (translatorId === referenceTranslatorId) {
      throw new Error("Learning Style requires a separate learning clone profile.");
    }
    if (
      learningProfile.profileKind !== "learning_clone" ||
      learningProfile.styleSourceTranslatorId !== referenceTranslatorId
    ) {
      throw new Error("Learning Style output profile must be a clone of the selected Reference translator.");
    }
  }

  const mapping = policy.useReferenceMemory
    ? resolveSourceChapterMapping({ mangaId, translatorId, sourceChapterId, chapterId, chapterTitle })
    : null;
  if (mapping?.warning) warnings.push(mapping.warning);

  const sourcePaths = resolveKnowledgeAssetPaths({ mangaId, translatorId: ORIGINAL_TRANSLATOR_ID });
  const referencePaths = policy.useReferenceMemory
    ? resolveKnowledgeAssetPaths({ mangaId, translatorId: referenceTranslatorId })
    : null;
  const localPaths = resolveKnowledgeAssetPaths({ mangaId, translatorId });
  const sourceGlossary = policy.useReferenceMemory ? loadCanonicalGlossary(mangaId, ORIGINAL_TRANSLATOR_ID) : null;
  const targetGlossary = policy.useReferenceMemory ? loadCanonicalGlossary(mangaId, referenceTranslatorId) : null;
  const sourceStory = policy.useReferenceMemory ? loadStoryContext(mangaId, ORIGINAL_TRANSLATOR_ID) : null;
  const targetStyleEvidence = policy.useReferenceMemory ? loadStyleEvidence(mangaId, referenceTranslatorId) : null;
  const targetStyleProfile = policy.useReferenceMemory ? loadStyleProfile(mangaId, referenceTranslatorId) : null;
  const publicationRegistry = policy.useLocalMemory && mangaId && translatorId
    ? new TranslationPublicationService({ resolveBaseDir: () => localPaths.baseDir || path.dirname(localPaths.knowledgeBasePath) }).load(mangaId, translatorId)
    : null;
  const activePublications = Object.values(publicationRegistry?.chapters || []).map((chapter) =>
    (chapter.revisions || []).find((entry) => entry.revisionId === chapter.activeRevisionId)
  ).filter(Boolean);
  const pendingRevalidation = activePublications.filter((entry) => entry.qualityStatus !== "passed");
  const localRevalidationBlocked = pendingRevalidation.length > 0;
  const localKnowledge = policy.useLocalMemory && !localRevalidationBlocked
    ? loadKnowledgeBase(mangaId, translatorId)
    : null;
  const bilingualEvidence = policy.useReferenceMemory && fs.existsSync(referencePaths.bilingualEvidencePath)
    ? JSON.parse(fs.readFileSync(referencePaths.bilingualEvidencePath, "utf8"))
    : null;

  const canonical = glossaryMode === "disabled"
    ? []
    : (targetGlossary?.entries || []).filter((entry) =>
        entry.locked === true || entry.source === "manual" || entry.source === "reference_bilingual_evidence" || entry.reference_kind === "translator"
      );
  const localTerms = policy.useLocalMemory && glossaryMode !== "disabled"
    ? (localKnowledge?.terminology || []).filter((entry) => entry.status === "stable" || entry.locked === true)
    : [];
  const glossary = [...canonical];
  const seenGlossary = new Set(glossary.map((entry) => entry.source_term || entry.term));
  for (const entry of localTerms) {
    if (!seenGlossary.has(entry.term)) glossary.push({
      source_term: entry.term,
      canonical_translation: entry.translation,
      category: entry.category,
      aliases: entry.aliases || [],
      confidence: entry.confidence,
      source: "self",
    });
  }
  const sourceIdentity = (sourceGlossary?.entries || []).map((entry) => ({
    sourceTerm: entry.source_term || entry.canonical_form || null,
    canonicalForm: entry.canonical_form || entry.source_term || null,
    category: entry.category || null,
    confidence: entry.confidence || null,
  })).filter((entry) => entry.sourceTerm);
  const storyChapter = mapping?.sourceChapterId ? sourceStory?.chapters?.[mapping.sourceChapterId] || null : null;
  const sourceRoleEvidence = policy.useReferenceMemory
    ? loadSourceRoleEvidence(mangaId, mapping?.sourceChapterId || null)
    : [];
  const styleChapters = topStyleChapters(targetStyleEvidence, chapterId);
  const acceptedStylePairs = (bilingualEvidence?.stylePairs || []).filter((entry) => entry.status === "accepted").slice(0, 12);
  const characterSpeech = (localKnowledge?.characters || []).filter((entry) =>
    (entry.speech_style || []).length > 0 || (entry.sentence_ending_patterns || []).length > 0
  ).slice(0, 12);
  const referenceReady = !policy.useReferenceMemory || Boolean(
    (Object.keys(sourceStory?.chapters || {}).length > 0 || (sourceGlossary?.entries || []).length > 0) &&
    (styleChapters.length > 0 || canonical.length > 0)
  );
  const localReady = !policy.useLocalMemory || Boolean(
    (localKnowledge?.translation_pairs || []).length > 0 ||
    (localKnowledge?.terminology || []).length > 0 ||
    (localKnowledge?.style_examples || []).length > 0
  );
  if (!referenceReady) warnings.push("Reference memory is incomplete; source ingestion and translator ingestion must be completed first.");
  if (!localReady) warnings.push("Local learning memory is empty; run learning on at least one completed translation first.");
  const revisions = [
    fileRevision(sourcePaths.glossaryPath),
    fileRevision(sourcePaths.storyContextPath),
    fileRevision(referencePaths?.glossaryPath),
    fileRevision(referencePaths?.styleEvidencePath),
    fileRevision(referencePaths?.styleProfilePath),
    fileRevision(referencePaths?.bilingualEvidencePath),
    fileRevision(localPaths.knowledgeBasePath),
  ].filter(Boolean);
  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    translationMode,
    policy,
    mangaId,
    translatorId,
    referenceTranslatorId,
    chapterId: chapterId || null,
    chapterMapping: mapping,
    layers: {
      reference: policy.useReferenceMemory ? {
        sourceTranslatorId: ORIGINAL_TRANSLATOR_ID,
        referenceTranslatorId,
        learningTranslatorId: translatorId,
        sourceStoryAvailable: Boolean(sourceStory),
        targetStyleAvailable: styleChapters.length > 0,
      } : null,
      local: policy.useLocalMemory ? {
        available: Boolean(localKnowledge),
        revalidationBlocked: localRevalidationBlocked,
        pendingChapterIds: pendingRevalidation.map((entry) => entry.chapterId),
      } : null,
    },
    effective: {
      glossary: glossary.slice(0, 60),
      sourceIdentity: sourceIdentity.slice(0, 60),
      story: policy.useReferenceMemory ? { global: sourceStory?.global || null, chapter: storyChapter } : null,
      style: policy.useReferenceMemory ? {
        profile: targetStyleProfile?.rules || {},
        chapters: styleChapters,
        bilingualPairs: acceptedStylePairs,
        characterSpeech,
      } : null,
      localKnowledge: policy.useLocalMemory ? {
        styleProfile: localKnowledge?.style_profile || null,
        styleExamples: (localKnowledge?.style_examples || []).slice(-12),
        translationPairs: localKnowledge?.translation_pairs || [],
      } : null,
      sourceRoleEvidence,
    },
    usage: {
      glossaryEntries: glossary.length,
      sourceIdentityEntries: sourceIdentity.length,
      storyCharacters: sourceStory?.global?.characters?.length || 0,
      storyTerms: sourceStory?.global?.terminology?.length || 0,
      styleChapters: styleChapters.length,
      characterSpeechEntries: characterSpeech.length,
      localPairs: localKnowledge?.translation_pairs?.length || 0,
      sourceRoleEvidence: sourceRoleEvidence.length,
    },
    readiness: { reference: referenceReady, local: localReady },
    warnings: [
      ...warnings,
      ...(localRevalidationBlocked ? [{
        code: "local_memory_pending_revalidation",
        chapterIds: pendingRevalidation.map((entry) => entry.chapterId),
      }] : []),
    ],
    revisions,
    languages: {
      sourceLanguage: resolvedSourceLanguage,
      targetLanguage: resolvedTargetLanguage,
      referenceLanguage: referenceProfile?.language || null,
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
  if (snapshot.layers?.local?.revalidationBlocked) {
    throw new Error(
      `Local memory is pending Quality revalidation for chapter(s): ${snapshot.layers.local.pendingChapterIds.join(", ")}.`
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
  if (snapshot.effective.glossary.length > 0) {
    lines.push("Canonical terminology (must follow):");
    for (const entry of snapshot.effective.glossary.slice(0, 40)) {
      lines.push(`- ${entry.source_term || entry.term} => ${entry.canonical_translation || entry.translation}`);
    }
  }
  if (snapshot.effective.sourceIdentity.length > 0) {
    lines.push("Original-language named entities (identity only; do not copy as target renderings):");
    for (const entry of snapshot.effective.sourceIdentity.slice(0, 30)) lines.push(`- ${entry.sourceTerm} [${entry.category || "term"}]`);
  }
  const story = snapshot.effective.story;
  if (story?.global?.summary) lines.push(`Global story context: ${story.global.summary}`);
  if (story?.chapter?.summary) lines.push(`Current chapter context: ${story.chapter.summary}`);
  for (const event of (story?.chapter?.events || []).slice(0, 6)) lines.push(`- Story event: ${event.summary || event.event || event}`);
  const style = snapshot.effective.style;
  if (style) {
    lines.push(`Translator style constraints: ${JSON.stringify(style.profile || {})}`);
    for (const chapter of style.chapters || []) {
      for (const sample of (chapter.dialogueSamples || []).slice(0, 2)) lines.push(`- Dialogue example: ${sample}`);
      for (const sample of (chapter.narrationSamples || []).slice(0, 2)) lines.push(`- Narration example: ${sample}`);
    }
    for (const character of style.characterSpeech || []) {
      lines.push(`- Character voice ${character.name}: ${(character.speech_style || []).join(", ")}`);
    }
  }
  const local = snapshot.effective.localKnowledge;
  for (const example of local?.styleExamples || []) lines.push(`- Learned ${example.type || "style"} example: ${example.translation}`);
  return lines.join("\n");
}

module.exports = {
  ORIGINAL_TRANSLATOR_ID,
  SNAPSHOT_SCHEMA_VERSION,
  chapterNumber,
  assertTranslationMemoryReady,
  composeTranslationMemory,
  formatTranslationMemoryPrompt,
  resolveSourceChapterMapping,
};
