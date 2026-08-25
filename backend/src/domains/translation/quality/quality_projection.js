const crypto = require("crypto");

const QUALITY_PROJECTION_SCHEMA_VERSION = 1;
const DEFAULT_WINDOW_SIZE = 10;
const DEFAULT_REPRESENTATIVE_LIMIT = 12;
const DEFAULT_WINDOW_BYTE_BUDGET = 20000;

const QUALITY_PURPOSES = [
  {
    purpose: "completeness",
    limit: 10,
    reasons: new Set(["translation_missing", "source_target_identity", "observer_empty_translation"]),
  },
  {
    purpose: "sequence",
    limit: 40,
    reasons: new Set(["observer_sequence_shift"]),
  },
  {
    purpose: "terminology",
    limit: 20,
    reasons: new Set(["locked_term", "canonical_term", "local_pair_conflict", "chapter_rendering_drift", "observer_locked_term_violation", "observer_terminology"]),
  },
  {
    purpose: "style",
    limit: 20,
    reasons: new Set(["observer_style", "style_evidence", "speaker_evidence"]),
  },
  {
    purpose: "story",
    limit: 24,
    reasons: new Set(["observer_meaning_change", "observer_story_context", "story_entity", "story_cue"]),
  },
  {
    purpose: "representative",
    limit: 20,
    reasons: new Set(["observer_fluency", "representative_sample", "deep_audit"]),
  },
];

function normalizeEvidenceText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceTextHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function completenessReasons(translation, languages = {}) {
  const original = normalizeEvidenceText(translation?.original);
  const target = normalizeEvidenceText(translation?.translation);
  const reasons = [];
  if (!target) reasons.push({ type: "translation_missing", evidence: null });
  if (original && target && original === target) {
    reasons.push({ type: "source_target_identity", evidence: null });
  }
  return reasons;
}

function glossarySource(entry) {
  return entry?.source_term || entry?.sourceTerm || entry?.term || entry?.canonical_form || null;
}

function glossaryTarget(entry) {
  return entry?.canonical_translation || entry?.translation || entry?.targetRendering || null;
}

function isLockedTerm(entry) {
  return entry?.locked === true || entry?.source === "manual" || entry?.status === "locked";
}

function isStableLocalPair(pair) {
  return pair?.locked === true || pair?.sourceReference === "manual" ||
    (Number.isFinite(pair?.confidence) && pair.confidence >= 0.8) ||
    (Array.isArray(pair?.evidenceReasons) && pair.evidenceReasons.some((reason) => [
      "quality_revision", "locked_term", "canonical_term", "style_evidence", "speaker_evidence",
    ].includes(reason)));
}

function compactStoryEntry(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return entry;
  const fields = [
    "id", "name", "canonicalForm", "aliases", "summary", "event", "eventType",
    "subject", "object", "source", "target", "relationType", "state", "value",
    "participants", "characters", "terminology", "confidence", "evidenceNodeIds", "nodeIds", "translationImpact",
  ];
  return Object.fromEntries(fields.filter((field) => entry[field] !== undefined).map((field) => [
    field,
    Array.isArray(entry[field]) ? entry[field].slice(0, 8) : entry[field],
  ]));
}

function collectStoryEntities(story) {
  const output = new Set();
  const visit = (value, key = "") => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, key);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [field, entry] of Object.entries(value)) {
      if (["name", "term", "sourceTerm", "canonicalForm", "surfaceForm"].includes(field)) {
        const normalized = normalizeEvidenceText(entry);
        if (normalized) output.add(normalized);
      } else if (["global", "chapter", "characters", "terminology", "participants", "mentions", "relationships", "events", "characterStates", "openThreads"].includes(field)) {
        visit(entry, field);
      }
    }
  };
  visit(story);
  return [...output];
}

function evenlyDistributedIndexes(total, limit) {
  if (total <= 0 || limit <= 0) return [];
  if (total <= limit) return Array.from({ length: total }, (_, index) => index);
  const indexes = new Set();
  for (let index = 0; index < limit; index += 1) {
    indexes.add(Math.round((index * (total - 1)) / (limit - 1)));
  }
  return [...indexes].sort((left, right) => left - right);
}

function addReason(candidateMap, translation, reason, evidence = null, priority = 50) {
  const current = candidateMap.get(translation.id) || {
    nodeId: translation.id,
    pageId: translation.pageId || null,
    pageName: translation.pageName || null,
    original: translation.original,
    currentTranslation: translation.translation,
    textRole: translation.textRole || null,
    styleChannel: translation.styleChannel || null,
    speakerRef: translation.speakerRef || null,
    roleConfidence: translation.roleConfidence ?? null,
    speakerConfidence: translation.speakerConfidence ?? null,
    reasons: [],
    priority,
  };
  if (!current.reasons.some((entry) => entry.type === reason && JSON.stringify(entry.evidence) === JSON.stringify(evidence))) {
    current.reasons.push({ type: reason, evidence });
  }
  current.priority = Math.min(current.priority, priority);
  candidateMap.set(translation.id, current);
}

function qualityPurpose(candidate) {
  const reasons = new Set((candidate?.reasons || []).map((entry) => entry.type));
  if (["translation_missing", "source_target_identity", "observer_empty_translation"].some((reason) => reasons.has(reason))) {
    return "completeness";
  }
  const observerPurpose = [
    ["observer_sequence_shift", "sequence"],
    ["observer_locked_term_violation", "terminology"],
    ["observer_terminology", "terminology"],
    ["observer_style", "style"],
    ["observer_meaning_change", "story"],
    ["observer_story_context", "story"],
    ["observer_fluency", "representative"],
  ].find(([reason]) => reasons.has(reason));
  if (observerPurpose) return observerPurpose[1];
  return QUALITY_PURPOSES.find((definition) =>
    [...definition.reasons].some((reason) => reasons.has(reason))
  )?.purpose || "representative";
}

function semanticSignature(entry) {
  return `${entry?.textRole || ""}|${entry?.styleChannel || ""}|${entry?.speakerRef || ""}`;
}

function selectSemanticEvidence(entries, minimumConfidence = 0.75) {
  const eligible = (entries || []).filter((entry) =>
    (entry?.textRole || entry?.styleChannel || entry?.speakerRef) &&
    (!Number.isFinite(entry?.confidence) || entry.confidence >= minimumConfidence) &&
    (!Number.isFinite(entry?.roleConfidence) || entry.roleConfidence >= minimumConfidence)
  );
  const signatures = new Set(eligible.map(semanticSignature));
  if (signatures.size !== 1) return null;
  return [...eligible].sort((left, right) =>
    (right.roleConfidence || right.confidence || 0) - (left.roleConfidence || left.confidence || 0)
  )[0] || null;
}

function applyQualitySemanticAnnotations(translations, projection) {
  const annotations = new Map((projection?.semanticAnnotations || []).map((entry) => [entry.nodeId, entry]));
  return (translations || []).map((translation) => {
    const annotation = annotations.get(translation.id || translation.nodeId);
    if (!annotation) return translation;
    return {
      ...translation,
      textRole: translation.textRole || annotation.textRole || null,
      styleChannel: translation.styleChannel || annotation.styleChannel || null,
      speakerRef: translation.speakerRef || annotation.speakerRef || null,
      roleConfidence: translation.roleConfidence ?? annotation.roleConfidence ?? null,
      speakerConfidence: translation.speakerConfidence ?? annotation.speakerConfidence ?? null,
    };
  });
}

function buildQualityContextProjection({
  translations,
  translationMemory,
  windowSize = null,
  representativeLimit = DEFAULT_REPRESENTATIVE_LIMIT,
  windowByteBudget = DEFAULT_WINDOW_BYTE_BUDGET,
  includeAll = false,
  sourceLanguage = translationMemory?.languages?.sourceLanguage || null,
  targetLanguage = translationMemory?.languages?.targetLanguage || null,
  semanticRoleEvidence = [],
  semanticEvidenceFingerprint = null,
  qualityObservation = null,
}) {
  const languages = { sourceLanguage, targetLanguage };
  const localPairs = translationMemory?.effective?.localKnowledge?.translationPairs || [];
  const stableLocalPairs = localPairs.filter(isStableLocalPair);
  const semanticLocalPairsByOriginal = new Map();
  for (const pair of stableLocalPairs) {
    const key = normalizeEvidenceText(pair?.original);
    if (!key) continue;
    const group = semanticLocalPairsByOriginal.get(key) || [];
    group.push(pair);
    semanticLocalPairsByOriginal.set(key, group);
  }
  const roleEvidenceGroups = new Map();
  for (const evidence of [
    ...(translationMemory?.effective?.sourceRoleEvidence || []),
    ...(semanticRoleEvidence || []),
  ]) {
    if (!evidence?.textFingerprint) continue;
    const group = roleEvidenceGroups.get(evidence.textFingerprint) || [];
    group.push(evidence);
    roleEvidenceGroups.set(evidence.textFingerprint, group);
  }
  const ordered = (Array.isArray(translations) ? translations : []).filter((entry) =>
    entry && typeof entry.id === "string" && normalizeEvidenceText(entry.original)
  ).map((entry) => {
    if (entry.textRole || entry.styleChannel || entry.speakerRef) return entry;
    const observationEvidence = selectSemanticEvidence(roleEvidenceGroups.get(sourceTextHash(entry.original)) || []);
    const localEvidence = selectSemanticEvidence(
      semanticLocalPairsByOriginal.get(normalizeEvidenceText(entry.original)) || [],
      0.8
    );
    const strongest = observationEvidence || localEvidence;
    return strongest ? {
      ...entry,
      textRole: strongest.textRole || null,
      styleChannel: strongest.styleChannel || null,
      speakerRef: strongest.speakerRef || null,
      roleConfidence: strongest.roleConfidence ?? strongest.confidence ?? null,
      speakerConfidence: strongest.speakerConfidence ?? null,
      storyCueTypes: strongest.storyCueTypes || [],
    } : entry;
  });
  const candidateMap = new Map();
  const observationById = new Map((qualityObservation?.nodes || []).map((entry) => [entry.nodeId, entry]));
  const observerDriven = observationById.size > 0;
  const glossary = translationMemory?.effective?.glossary || [];
  const localPairsByOriginal = new Map();
  for (const pair of stableLocalPairs) {
    const key = normalizeEvidenceText(pair?.original);
    if (!key) continue;
    const group = localPairsByOriginal.get(key) || [];
    group.push(pair);
    localPairsByOriginal.set(key, group);
  }
  const story = translationMemory?.effective?.story || null;
  const storyEntities = collectStoryEntities(story);
  const originalGroups = new Map();
  const styleGroups = new Map();
  const speakerGroups = new Map();

  for (const translation of ordered) {
    const original = normalizeEvidenceText(translation.original);
    const target = normalizeEvidenceText(translation.translation);
    const group = originalGroups.get(original) || [];
    group.push(translation);
    originalGroups.set(original, group);

    for (const reason of completenessReasons(translation, languages)) {
      addReason(candidateMap, translation, reason.type, reason.evidence, 5);
    }

    for (const entry of glossary) {
      const source = normalizeEvidenceText(glossarySource(entry));
      if (source && original.includes(source)) {
        const observation = observationById.get(translation.id);
        const targetRendering = normalizeEvidenceText(glossaryTarget(entry));
        const deterministicLockedViolation = isLockedTerm(entry) && targetRendering && !target.includes(targetRendering);
        if (observerDriven && observation?.disposition !== "suspect" && !deterministicLockedViolation) continue;
        addReason(candidateMap, translation, isLockedTerm(entry) ? "locked_term" : "canonical_term", {
          sourceTerm: glossarySource(entry),
          canonicalTranslation: glossaryTarget(entry),
          locked: isLockedTerm(entry),
        }, isLockedTerm(entry) ? 0 : 10);
      }
    }

    for (const pair of localPairsByOriginal.get(original) || []) {
      if (normalizeEvidenceText(pair?.translation) !== target) {
        addReason(candidateMap, translation, "local_pair_conflict", {
          preferredTranslation: pair.translation,
        }, 15);
      }
    }

    const matchedEntities = storyEntities.filter((entity) => entity && original.includes(entity));
    if (matchedEntities.length > 0) {
      if (!observerDriven || observationById.get(translation.id)?.disposition === "suspect") {
        addReason(candidateMap, translation, "story_entity", { entities: matchedEntities.slice(0, 8) }, 20);
      }
    }
    if (translation.textRole || translation.styleChannel) {
      const key = `${translation.textRole || "unknown"}|${translation.styleChannel || "unknown"}`;
      const group = styleGroups.get(key) || [];
      group.push(translation);
      styleGroups.set(key, group);
    }
    if (translation.speakerRef) {
      const group = speakerGroups.get(translation.speakerRef) || [];
      group.push(translation);
      speakerGroups.set(translation.speakerRef, group);
    }
    if (Array.isArray(translation.storyCueTypes) && translation.storyCueTypes.length > 0 &&
      (!observerDriven || observationById.get(translation.id)?.disposition === "suspect")) {
      addReason(candidateMap, translation, "story_cue", { cueTypes: translation.storyCueTypes }, 18);
    }
  }

  const orderedById = new Map(ordered.map((entry) => [entry.id, entry]));
  const observationRiskPriority = [
    "sequence_shift", "empty_translation", "locked_term_violation", "terminology",
    "meaning_change", "story_context", "style", "fluency",
  ];
  for (const observationNode of qualityObservation?.nodes || []) {
    if (observationNode.disposition !== "suspect") continue;
    const translation = orderedById.get(observationNode.nodeId);
    if (!translation) continue;
    const primaryRisk = observationRiskPriority.find((risk) => observationNode.riskTypes?.includes(risk));
    if (!primaryRisk) continue;
    addReason(candidateMap, translation, `observer_${primaryRisk}`, {
      confidence: observationNode.confidence,
      reason: observationNode.reason,
    }, primaryRisk === "sequence_shift" ? 1 : 8);
  }

  if (!observerDriven) {
    for (const group of styleGroups.values()) {
      for (const index of evenlyDistributedIndexes(group.length, 3)) {
        const translation = group[index];
        addReason(candidateMap, translation, "style_evidence", {
          textRole: translation.textRole || null,
          styleChannel: translation.styleChannel || null,
          speakerRef: translation.speakerRef || null,
        }, 25);
      }
    }
    for (const group of [...speakerGroups.values()].slice(0, 12)) {
      const translation = group[Math.floor((group.length - 1) / 2)];
      addReason(candidateMap, translation, "speaker_evidence", {
        textRole: translation.textRole || null,
        styleChannel: translation.styleChannel || null,
        speakerRef: translation.speakerRef,
      }, 24);
    }
  }

  for (const group of originalGroups.values()) {
    if (group.length < 2) continue;
    const renderings = new Set(group.map((entry) => normalizeEvidenceText(entry.translation)));
    if (renderings.size < 2) continue;
    for (const translation of group) {
      addReason(candidateMap, translation, "chapter_rendering_drift", {
        renderings: [...renderings],
      }, 12);
    }
  }

  if (!observerDriven) {
    for (const index of evenlyDistributedIndexes(ordered.length, representativeLimit)) {
      addReason(candidateMap, ordered[index], "representative_sample", { index, total: ordered.length }, 90);
    }
  }
  if (includeAll) {
    for (const translation of ordered) addReason(candidateMap, translation, "deep_audit", null, 100);
  }

  const indexById = new Map(ordered.map((entry, index) => [entry.id, index]));
  const candidates = [...candidateMap.values()]
    .sort((left, right) => left.priority - right.priority || indexById.get(left.nodeId) - indexById.get(right.nodeId))
    .map((candidate) => {
      const index = indexById.get(candidate.nodeId);
      return {
        ...candidate,
        neighbors: [ordered[index - 1], ordered[index + 1]]
          .filter(Boolean)
          .map((entry) => ({
            nodeId: entry.id,
            pageName: entry.pageName || null,
            original: entry.original,
            translation: entry.translation,
          })),
      };
    });

  const relevantTermKeys = new Set(candidates.flatMap((candidate) =>
    candidate.reasons
      .filter((reason) => ["locked_term", "canonical_term"].includes(reason.type))
      .map((reason) => normalizeEvidenceText(reason.evidence?.sourceTerm))
  ));
  const relevantGlossary = glossary
    .filter((entry) => relevantTermKeys.has(normalizeEvidenceText(glossarySource(entry))))
    .map((entry) => ({
      sourceTerm: glossarySource(entry),
      canonicalTranslation: glossaryTarget(entry),
      aliases: Array.isArray(entry.aliases) ? entry.aliases.slice(0, 8) : [],
      category: entry.category || null,
      confidence: entry.confidence || null,
      locked: isLockedTerm(entry),
    }));
  const representedRoles = new Set(candidates.map((entry) => entry.textRole).filter(Boolean));
  const relevantStoryEntities = new Set(candidates.flatMap((candidate) =>
    candidate.reasons.find((reason) => reason.type === "story_entity")?.evidence?.entities || []
  ));
  const hasStoryCueCandidate = candidates.some((candidate) =>
    candidate.reasons.some((reason) => reason.type === "story_cue")
  );
  const includesRelevantEntity = (entry) => {
    const serialized = normalizeEvidenceText(typeof entry === "string" ? entry : JSON.stringify(entry));
    return [...relevantStoryEntities].some((entity) => serialized.includes(entity));
  };
  const compactStory = story ? {
    globalSummary: story.global?.summary || null,
    chapterSummary: story.chapter?.summary || null,
    characters: (story.global?.characters || []).filter(includesRelevantEntity).slice(0, 12).map(compactStoryEntry),
    relationships: (story.global?.relationships || []).filter(includesRelevantEntity).slice(0, 12).map(compactStoryEntry),
    events: [...(story.chapter?.events || []), ...(story.global?.events || [])]
      .filter((entry) => hasStoryCueCandidate || (relevantStoryEntities.size > 0 && includesRelevantEntity(entry)))
      .slice(0, 8).map(compactStoryEntry),
    characterStates: (story.chapter?.characterStates || story.global?.characterStates || [])
      .filter(includesRelevantEntity).slice(0, 8).map(compactStoryEntry),
  } : null;
  const style = translationMemory?.effective?.style || null;
  const styleExamples = [];
  const roleExampleCounts = new Map();
  for (const chapter of style?.chapters || []) {
    for (const [field, role] of [["dialogueSamples", "dialogue"], ["narrationSamples", "narration"], ["monologueSamples", "monologue"]]) {
      if (representedRoles.size > 0 && !representedRoles.has(role)) continue;
      for (const sample of chapter?.[field] || []) {
        if ((roleExampleCounts.get(role) || 0) >= 3) break;
        styleExamples.push({ role, sample });
        roleExampleCounts.set(role, (roleExampleCounts.get(role) || 0) + 1);
      }
    }
  }

  const context = {
    glossary: relevantGlossary,
    story: compactStory,
    style: style ? {
      profile: style.profile || {},
      examples: styleExamples,
      characterSpeech: (style.characterSpeech || []).filter((entry) =>
        candidates.some((candidate) => candidate.speakerRef && candidate.speakerRef === entry.name)
      ),
    } : null,
    localPairs: stableLocalPairs.filter((pair) =>
      candidates.some((candidate) => normalizeEvidenceText(candidate.original) === normalizeEvidenceText(pair?.original))
    ).slice(0, 20),
    sequencePages: (qualityObservation?.sequenceRisks || []).map((risk) => ({
      ...risk,
      orderedPairs: ordered.filter((entry) => entry.pageName === risk.pageName).map((entry) => ({
        nodeId: entry.id,
        original: entry.original,
        translation: entry.translation,
      })),
    })),
  };
  const windows = [];
  let current = [];
  let currentPurpose = null;
  const contextForWindow = (purpose, windowCandidates) => {
    const sourceTerms = new Set(windowCandidates.flatMap((candidate) => candidate.reasons
      .map((reason) => normalizeEvidenceText(reason.evidence?.sourceTerm))
      .filter(Boolean)));
    const originals = new Set(windowCandidates.map((candidate) => normalizeEvidenceText(candidate.original)));
    return {
    glossary: context.glossary.filter((entry) => sourceTerms.has(normalizeEvidenceText(entry.sourceTerm))),
    story: purpose === "story" ? context.story : null,
    style: purpose === "style" ? context.style : null,
    localPairs: context.localPairs.filter((pair) => originals.has(normalizeEvidenceText(pair?.original))),
    sequencePages: purpose === "sequence"
      ? (context.sequencePages || []).filter((page) => windowCandidates.some((candidate) => candidate.pageName === page.pageName))
      : [],
    };
  };
  const pushWindow = () => {
    if (current.length === 0) return;
    const inputBytes = Buffer.byteLength(JSON.stringify({ purpose: currentPurpose, context: contextForWindow(currentPurpose, current), candidates: current }), "utf8");
    const purposeIndex = windows.filter((window) => window.purpose === currentPurpose).length + 1;
    windows.push({
      windowId: `quality_${currentPurpose}_${String(purposeIndex).padStart(3, "0")}`,
      purpose: currentPurpose,
      candidates: current,
      inputBytes,
    });
    current = [];
  };
  for (const purposeDefinition of QUALITY_PURPOSES) {
    currentPurpose = purposeDefinition.purpose;
    const purposeCandidates = candidates.filter((candidate) => qualityPurpose(candidate) === currentPurpose);
    const purposeLimit = Number.isInteger(windowSize) && windowSize > 0
      ? Math.min(windowSize, purposeDefinition.limit)
      : purposeDefinition.limit;
    for (const candidate of purposeCandidates) {
      const proposed = [...current, candidate];
      const proposedBytes = Buffer.byteLength(JSON.stringify({ purpose: currentPurpose, context: contextForWindow(currentPurpose, proposed), candidates: proposed }), "utf8");
      if (current.length > 0 && (proposed.length > purposeLimit || proposedBytes > windowByteBudget)) pushWindow();
      current.push(candidate);
      const singleBytes = Buffer.byteLength(JSON.stringify({ purpose: currentPurpose, context: contextForWindow(currentPurpose, current), candidates: current }), "utf8");
      if (singleBytes > windowByteBudget) {
        throw new Error(`Quality candidate ${candidate.nodeId} exceeds the ${windowByteBudget}-byte window budget.`);
      }
    }
    pushWindow();
  }
  const candidateReasonCounts = {};
  const candidatePurposeCounts = {};
  for (const candidate of candidates) {
    for (const reason of candidate.reasons) candidateReasonCounts[reason.type] = (candidateReasonCounts[reason.type] || 0) + 1;
    const purpose = qualityPurpose(candidate);
    candidatePurposeCounts[purpose] = (candidatePurposeCounts[purpose] || 0) + 1;
  }
  const projection = {
    schemaVersion: QUALITY_PROJECTION_SCHEMA_VERSION,
    translationMemoryFingerprint: translationMemory?.fingerprint || null,
    translationMemoryRevisions: translationMemory?.revisions || [],
    semanticEvidenceFingerprint,
    qualityObservationFingerprint: qualityObservation?.fingerprint || null,
    chapterMapping: translationMemory?.chapterMapping || null,
    languages,
    totalTranslations: ordered.length,
    candidateCount: candidates.length,
    omittedCount: Math.max(0, ordered.length - candidates.length),
    coverage: ordered.length > 0 ? Number((candidates.length / ordered.length).toFixed(4)) : 0,
    candidateReasonCounts,
    candidatePurposeCounts,
    context,
    semanticAnnotations: ordered.filter((entry) => entry.textRole || entry.styleChannel || entry.speakerRef).map((entry) => ({
      nodeId: entry.id,
      textRole: entry.textRole || null,
      styleChannel: entry.styleChannel || null,
      speakerRef: entry.speakerRef || null,
      roleConfidence: entry.roleConfidence ?? null,
      speakerConfidence: entry.speakerConfidence ?? null,
    })),
    candidates,
    windows,
    windowByteBudget,
  };
  projection.semanticCoverage = {
    annotated: projection.semanticAnnotations.length,
    total: ordered.length,
    ratio: ordered.length > 0 ? Number((projection.semanticAnnotations.length / ordered.length).toFixed(4)) : 0,
  };
  projection.fingerprint = stableHash(projection);
  return projection;
}

function buildQualityWindowInput(projection, window) {
  const context = {
    ...projection.context,
    sequencePages: window.purpose === "sequence"
      ? (projection.context.sequencePages || []).filter((page) => window.candidates.some((candidate) => candidate.pageName === page.pageName))
      : [],
  };
  return {
    projectionFingerprint: projection.fingerprint,
    translationMemoryFingerprint: projection.translationMemoryFingerprint,
    languages: projection.languages,
    windowId: window.windowId,
    purpose: window.purpose,
    context,
    candidates: window.candidates,
  };
}

module.exports = {
  DEFAULT_REPRESENTATIVE_LIMIT,
  DEFAULT_WINDOW_BYTE_BUDGET,
  DEFAULT_WINDOW_SIZE,
  QUALITY_PURPOSES,
  QUALITY_PROJECTION_SCHEMA_VERSION,
  applyQualitySemanticAnnotations,
  buildQualityContextProjection,
  buildQualityWindowInput,
  normalizeEvidenceText,
  qualityPurpose,
  completenessReasons,
};
