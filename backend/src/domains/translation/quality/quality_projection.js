const crypto = require("crypto");

const QUALITY_PROJECTION_SCHEMA_VERSION = 1;
const DEFAULT_WINDOW_SIZE = 10;
const DEFAULT_REPRESENTATIVE_LIMIT = 12;
const DEFAULT_WINDOW_BYTE_BUDGET = 20000;

const QUALITY_PURPOSES = [
  {
    purpose: "completeness",
    limit: 10,
    reasons: new Set([
      "translation_missing",
      "source_target_identity",
      "observer_empty_translation",
    ]),
  },
  {
    purpose: "sequence",
    limit: 40,
    reasons: new Set(["observer_sequence_shift"]),
  },
  {
    purpose: "terminology",
    limit: 20,
    reasons: new Set([
      "locked_term",
      "canonical_term",
      "local_pair_conflict",
      "chapter_rendering_drift",
      "observer_locked_term_violation",
      "observer_terminology",
    ]),
  },
  {
    purpose: "style",
    limit: 20,
    reasons: new Set(["observer_style", "style_evidence", "speaker_evidence"]),
  },
  {
    purpose: "story",
    limit: 24,
    reasons: new Set([
      "observer_meaning_change",
      "observer_story_context",
      "story_entity",
      "story_cue",
    ]),
  },
  {
    purpose: "representative",
    limit: 20,
    reasons: new Set([
      "observer_fluency",
      "representative_sample",
      "deep_audit",
    ]),
  },
];

const STORY_ENTRY_FIELDS = [
  "id", "name", "canonicalForm", "aliases", "summary", "event", "eventType",
  "subject", "object", "source", "target", "relationType", "state", "value",
  "participants", "characters", "terminology", "confidence", "evidenceNodeIds",
  "nodeIds", "translationImpact",
];
const STORY_ENTITY_FIELDS = new Set(["name", "term", "sourceTerm", "canonicalForm", "surfaceForm"]);
const STORY_CONTAINER_FIELDS = new Set([
  "global", "chapter", "characters", "terminology", "participants", "mentions",
  "relationships", "events", "characterStates", "openThreads",
]);

function normalizeEvidenceText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function sourceTextHash(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex");
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
  return (
    entry?.source_term ||
    entry?.sourceTerm ||
    entry?.term ||
    entry?.canonical_form ||
    null
  );
}

function glossaryTarget(entry) {
  return (
    entry?.canonical_translation ||
    entry?.translation ||
    entry?.targetRendering ||
    null
  );
}

function isLockedTerm(entry) {
  return (
    entry?.locked === true ||
    entry?.source === "manual" ||
    entry?.status === "locked"
  );
}

function isStableLocalPair(pair) {
  return (
    pair?.locked === true ||
    pair?.sourceReference === "manual" ||
    (Number.isFinite(pair?.confidence) && pair.confidence >= 0.8) ||
    (Array.isArray(pair?.evidenceReasons) &&
      pair.evidenceReasons.some((reason) =>
        [
          "quality_revision",
          "locked_term",
          "canonical_term",
          "style_evidence",
          "speaker_evidence",
        ].includes(reason),
      ))
  );
}

function compactStoryEntry(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return entry;
  return Object.fromEntries(
    STORY_ENTRY_FIELDS
      .filter((field) => entry[field] !== undefined)
      .map((field) => [field, Array.isArray(entry[field]) ? entry[field].slice(0, 8) : entry[field]]),
  );
}

function visitStoryEntities(value, output) {
  if (Array.isArray(value)) {
    for (const entry of value) visitStoryEntities(entry, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [field, entry] of Object.entries(value)) {
    if (STORY_ENTITY_FIELDS.has(field)) {
      const normalized = normalizeEvidenceText(entry);
      if (normalized) output.add(normalized);
    } else if (STORY_CONTAINER_FIELDS.has(field)) {
      visitStoryEntities(entry, output);
    }
  }
}

function collectStoryEntities(story) {
  const output = new Set();
  visitStoryEntities(story, output);
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

function createQualityCandidate(translation, priority) {
  return {
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
}

function hasQualityReason(candidate, reason, evidence) {
  return candidate.reasons.some(
    (entry) => entry.type === reason && JSON.stringify(entry.evidence) === JSON.stringify(evidence),
  );
}

function addReason(candidateMap, translation, reason, evidence = null, priority = 50) {
  const current = candidateMap.get(translation.id) || createQualityCandidate(translation, priority);
  if (!hasQualityReason(current, reason, evidence)) {
    current.reasons.push({ type: reason, evidence });
  }
  current.priority = Math.min(current.priority, priority);
  candidateMap.set(translation.id, current);
}

function qualityPurpose(candidate) {
  const reasons = new Set(
    (candidate?.reasons || []).map((entry) => entry.type),
  );
  if (
    [
      "translation_missing",
      "source_target_identity",
      "observer_empty_translation",
    ].some((reason) => reasons.has(reason))
  ) {
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
  return (
    QUALITY_PURPOSES.find((definition) =>
      [...definition.reasons].some((reason) => reasons.has(reason)),
    )?.purpose || "representative"
  );
}

function semanticSignature(entry) {
  return `${entry?.textRole || ""}|${entry?.styleChannel || ""}|${entry?.speakerRef || ""}`;
}

function selectSemanticEvidence(entries, minimumConfidence = 0.75) {
  const eligible = (entries || []).filter(
    (entry) =>
      (entry?.textRole || entry?.styleChannel || entry?.speakerRef) &&
      (!Number.isFinite(entry?.confidence) ||
        entry.confidence >= minimumConfidence) &&
      (!Number.isFinite(entry?.roleConfidence) ||
        entry.roleConfidence >= minimumConfidence),
  );
  const signatures = new Set(eligible.map(semanticSignature));
  if (signatures.size !== 1) return null;
  return (
    [...eligible].sort(
      (left, right) =>
        (right.roleConfidence || right.confidence || 0) -
        (left.roleConfidence || left.confidence || 0),
    )[0] || null
  );
}

function applyQualitySemanticAnnotations(translations, projection) {
  const annotations = new Map(
    (projection?.semanticAnnotations || []).map((entry) => [
      entry.nodeId,
      entry,
    ]),
  );
  return (translations || []).map((translation) => {
    const annotation = annotations.get(translation.id || translation.nodeId);
    if (!annotation) return translation;
    return {
      ...translation,
      textRole: translation.textRole || annotation.textRole || null,
      styleChannel: translation.styleChannel || annotation.styleChannel || null,
      speakerRef: translation.speakerRef || annotation.speakerRef || null,
      roleConfidence:
        translation.roleConfidence ?? annotation.roleConfidence ?? null,
      speakerConfidence:
        translation.speakerConfidence ?? annotation.speakerConfidence ?? null,
    };
  });
}

function annotateQualityTranslation(
  entry,
  roleEvidenceGroups,
  semanticLocalPairsByOriginal,
) {
  if (entry.textRole || entry.styleChannel || entry.speakerRef) return entry;
  const observationEvidence = selectSemanticEvidence(
    roleEvidenceGroups.get(sourceTextHash(entry.original)) || [],
  );
  const localEvidence = selectSemanticEvidence(
    semanticLocalPairsByOriginal.get(normalizeEvidenceText(entry.original)) ||
      [],
    0.8,
  );
  const strongest = observationEvidence || localEvidence;
  return strongest
    ? {
        ...entry,
        textRole: strongest.textRole || null,
        styleChannel: strongest.styleChannel || null,
        speakerRef: strongest.speakerRef || null,
        roleConfidence:
          strongest.roleConfidence ?? strongest.confidence ?? null,
        speakerConfidence: strongest.speakerConfidence ?? null,
        storyCueTypes: strongest.storyCueTypes || [],
      }
    : entry;
}

function groupQualityEvidence(entries, keyOf) {
  const groups = new Map();
  for (const entry of entries || []) {
    const key = keyOf(entry);
    if (!key) continue;
    const group = groups.get(key) || [];
    group.push(entry);
    groups.set(key, group);
  }
  return groups;
}

function qualityTranslations(translations, roleEvidenceGroups, semanticLocalPairsByOriginal) {
  return (Array.isArray(translations) ? translations : [])
    .filter((entry) => entry && typeof entry.id === "string" && normalizeEvidenceText(entry.original))
    .map((entry) => annotateQualityTranslation(entry, roleEvidenceGroups, semanticLocalPairsByOriginal));
}

function prepareQualityInputs(input) {
  const { translations, translationMemory, semanticRoleEvidence, sourceLanguage, targetLanguage } = input;
  const languages = { sourceLanguage, targetLanguage };
  const localPairs = translationMemory?.effective?.localKnowledge?.translationPairs || [];
  const stableLocalPairs = localPairs.filter(isStableLocalPair);
  const semanticLocalPairsByOriginal = groupQualityEvidence(
    stableLocalPairs,
    (pair) => normalizeEvidenceText(pair?.original),
  );
  const roleEvidenceGroups = groupQualityEvidence([
    ...(translationMemory?.effective?.sourceRoleEvidence || []),
    ...(semanticRoleEvidence || []),
  ], (evidence) => evidence?.textFingerprint);
  const ordered = qualityTranslations(translations, roleEvidenceGroups, semanticLocalPairsByOriginal);
  return { languages, stableLocalPairs, semanticLocalPairsByOriginal, roleEvidenceGroups, ordered };
}

function createQualityCandidateState(input) {
  const { translationMemory, qualityObservation, stableLocalPairs } = input;
  const candidateMap = new Map();
  const observationById = new Map(
    (qualityObservation?.nodes || []).map((entry) => [entry.nodeId, entry]),
  );
  const observerDriven = observationById.size > 0;
  const glossary = translationMemory?.effective?.glossary || [];
  const localPairsByOriginal = groupQualityEvidence(stableLocalPairs, (pair) => normalizeEvidenceText(pair?.original));
  const story = translationMemory?.effective?.story || null;
  const storyEntities = collectStoryEntities(story);
  const originalGroups = new Map();
  const styleGroups = new Map();
  const speakerGroups = new Map();
  return {
    candidateMap,
    observationById,
    observerDriven,
    glossary,
    localPairsByOriginal,
    story,
    storyEntities,
    originalGroups,
    styleGroups,
    speakerGroups,
    translationMemory,
    qualityObservation,
  };
}

function addCompletenessQualityReasons(candidateMap, translation, languages) {
  for (const reason of completenessReasons(translation, languages)) {
    addReason(candidateMap, translation, reason.type, reason.evidence, 5);
  }
}

function addGlossaryQualityReasons(state, translation) {
  const { candidateMap, glossary, observationById, observerDriven } = state;
  const original = normalizeEvidenceText(translation.original);
  const target = normalizeEvidenceText(translation.translation);
  for (const entry of glossary) {
    const source = normalizeEvidenceText(glossarySource(entry));
    if (source && original.includes(source)) {
      const observation = observationById.get(translation.id);
      const targetRendering = normalizeEvidenceText(glossaryTarget(entry));
      const deterministicLockedViolation = isLockedTerm(entry) && targetRendering && !target.includes(targetRendering);
      if (observerDriven && observation?.disposition !== "suspect" && !deterministicLockedViolation) continue;
      addReason(
        candidateMap,
        translation,
        isLockedTerm(entry) ? "locked_term" : "canonical_term",
        {
          sourceTerm: glossarySource(entry),
          canonicalTranslation: glossaryTarget(entry),
          locked: isLockedTerm(entry),
        },
        isLockedTerm(entry) ? 0 : 10,
      );
    }
  }
}

function addLocalPairQualityReasons(state, translation) {
  const original = normalizeEvidenceText(translation.original);
  const target = normalizeEvidenceText(translation.translation);
  for (const pair of state.localPairsByOriginal.get(original) || []) {
    if (normalizeEvidenceText(pair?.translation) !== target) {
      addReason(
        state.candidateMap,
        translation,
        "local_pair_conflict",
        {
          preferredTranslation: pair.translation,
        },
        15,
      );
    }
  }
}

function addStoryEntityQualityReason(state, translation) {
  const original = normalizeEvidenceText(translation.original);
  const matchedEntities = state.storyEntities.filter(
    (entity) => entity && original.includes(entity),
  );
  if (matchedEntities.length === 0) return;
  if (
    state.observerDriven &&
    state.observationById.get(translation.id)?.disposition !== "suspect"
  )
    return;
  addReason(
    state.candidateMap,
    translation,
    "story_entity",
    { entities: matchedEntities.slice(0, 8) },
    20,
  );
}

function updateQualityGroups(state, translation) {
  const original = normalizeEvidenceText(translation.original);
  const group = state.originalGroups.get(original) || [];
  group.push(translation);
  state.originalGroups.set(original, group);
  if (translation.textRole || translation.styleChannel) {
    const key = `${translation.textRole || "unknown"}|${translation.styleChannel || "unknown"}`;
    const styleGroup = state.styleGroups.get(key) || [];
    styleGroup.push(translation);
    state.styleGroups.set(key, styleGroup);
  }
  if (translation.speakerRef) {
    const speakerGroup = state.speakerGroups.get(translation.speakerRef) || [];
    speakerGroup.push(translation);
    state.speakerGroups.set(translation.speakerRef, speakerGroup);
  }
}

function addStoryCueQualityReason(state, translation) {
  if (
    !Array.isArray(translation.storyCueTypes) ||
    translation.storyCueTypes.length === 0
  )
    return;
  if (
    state.observerDriven &&
    state.observationById.get(translation.id)?.disposition !== "suspect"
  )
    return;
  addReason(
    state.candidateMap,
    translation,
    "story_cue",
    { cueTypes: translation.storyCueTypes },
    18,
  );
}

function processQualityTranslation(state, translation, languages) {
  updateQualityGroups(state, translation);
  addCompletenessQualityReasons(state.candidateMap, translation, languages);
  addGlossaryQualityReasons(state, translation);
  addLocalPairQualityReasons(state, translation);
  addStoryEntityQualityReason(state, translation);
  addStoryCueQualityReason(state, translation);
}

function addQualityTranslationReasons(state, ordered, languages) {
  for (const translation of ordered)
    processQualityTranslation(state, translation, languages);
}

function addObserverQualityReasons(state, ordered) {
  const orderedById = new Map(ordered.map((entry) => [entry.id, entry]));
  const observationRiskPriority = [
    "sequence_shift",
    "empty_translation",
    "locked_term_violation",
    "terminology",
    "meaning_change",
    "story_context",
    "style",
    "fluency",
  ];
  for (const observationNode of state.qualityObservation?.nodes || []) {
    addObserverNodeReason(state, orderedById, observationRiskPriority, observationNode);
  }
}

function addObserverNodeReason(state, orderedById, riskPriority, observationNode) {
  if (observationNode.disposition !== "suspect") return;
  const translation = orderedById.get(observationNode.nodeId);
  if (!translation) return;
  const primaryRisk = riskPriority.find((risk) => observationNode.riskTypes?.includes(risk));
  if (!primaryRisk) return;
  const evidence = { confidence: observationNode.confidence, reason: observationNode.reason };
  addReason(
    state.candidateMap,
    translation,
    `observer_${primaryRisk}`,
    evidence,
    primaryRisk === "sequence_shift" ? 1 : 8,
  );
}

function addStyleGroupQualityReasons(state) {
  for (const group of state.styleGroups.values()) {
    for (const index of evenlyDistributedIndexes(group.length, 3)) {
      const translation = group[index];
      addReason(
        state.candidateMap,
        translation,
        "style_evidence",
        {
          textRole: translation.textRole || null,
          styleChannel: translation.styleChannel || null,
          speakerRef: translation.speakerRef || null,
        },
        25,
      );
    }
  }
}

function addSpeakerGroupQualityReasons(state) {
  for (const group of [...state.speakerGroups.values()].slice(0, 12)) {
    const translation = group[Math.floor((group.length - 1) / 2)];
    addReason(
      state.candidateMap,
      translation,
      "speaker_evidence",
      {
        textRole: translation.textRole || null,
        styleChannel: translation.styleChannel || null,
        speakerRef: translation.speakerRef,
      },
      24,
    );
  }
}

function addNonObserverStyleSpeakerReasons(state) {
  addStyleGroupQualityReasons(state);
  addSpeakerGroupQualityReasons(state);
}

function addRepresentativeQualityReasons(state, ordered, representativeLimit) {
  for (const index of evenlyDistributedIndexes(
    ordered.length,
    representativeLimit,
  )) {
    addReason(
      state.candidateMap,
      ordered[index],
      "representative_sample",
      { index, total: ordered.length },
      90,
    );
  }
}

function addChapterRenderingDrift(state) {
  for (const group of state.originalGroups.values()) {
    if (group.length < 2) continue;
    const renderings = new Set(
      group.map((entry) => normalizeEvidenceText(entry.translation)),
    );
    if (renderings.size < 2) continue;
    for (const translation of group) {
      addReason(
        state.candidateMap,
        translation,
        "chapter_rendering_drift",
        {
          renderings: [...renderings],
        },
        12,
      );
    }
  }
}

function addDeepAuditQualityReasons(state, ordered) {
  for (const translation of ordered)
    addReason(state.candidateMap, translation, "deep_audit", null, 100);
}

function buildQualityCandidates(state, ordered) {
  const indexById = new Map(ordered.map((entry, index) => [entry.id, index]));
  return [...state.candidateMap.values()]
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        indexById.get(left.nodeId) - indexById.get(right.nodeId),
    )
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
}

function collectRelevantTermKeys(candidates) {
  return new Set(
    candidates.flatMap((candidate) =>
      candidate.reasons
        .filter((reason) =>
          ["locked_term", "canonical_term"].includes(reason.type),
        )
        .map((reason) => normalizeEvidenceText(reason.evidence?.sourceTerm)),
    ),
  );
}

function filterRelevantGlossary(glossary, relevantTermKeys) {
  return glossary
    .filter((entry) =>
      relevantTermKeys.has(normalizeEvidenceText(glossarySource(entry))),
    )
    .map((entry) => ({
      sourceTerm: glossarySource(entry),
      canonicalTranslation: glossaryTarget(entry),
      aliases: Array.isArray(entry.aliases) ? entry.aliases.slice(0, 8) : [],
      category: entry.category || null,
      confidence: entry.confidence || null,
      locked: isLockedTerm(entry),
    }));
}

function collectRelevantStoryEntities(candidates) {
  return new Set(
    candidates.flatMap(
      (candidate) =>
        candidate.reasons.find((reason) => reason.type === "story_entity")
          ?.evidence?.entities || [],
    ),
  );
}

function buildRelevantQualityData(state, candidates) {
  const relevantTermKeys = collectRelevantTermKeys(candidates);
  const relevantGlossary = filterRelevantGlossary(state.glossary, relevantTermKeys);
  const representedRoles = new Set(candidates.map((entry) => entry.textRole).filter(Boolean));
  const relevantStoryEntities = collectRelevantStoryEntities(candidates);
  const hasStoryCueCandidate = candidates.some((candidate) =>
    candidate.reasons.some((reason) => reason.type === "story_cue"),
  );
  return {
    relevantTermKeys,
    relevantGlossary,
    representedRoles,
    relevantStoryEntities,
    hasStoryCueCandidate,
  };
}

function includesRelevantEntity(relevantStoryEntities, entry) {
  const serialized = normalizeEvidenceText(
    typeof entry === "string" ? entry : JSON.stringify(entry),
  );
  return [...relevantStoryEntities].some((entity) =>
    serialized.includes(entity),
  );
}

function compactRelevantStoryEntries(entries, includes, limit) {
  return (entries || []).filter(includes).slice(0, limit).map(compactStoryEntry);
}

function buildCompactQualityStory(story, relevantStoryEntities, hasStoryCueCandidate) {
  if (!story) return null;
  const includes = (entry) => includesRelevantEntity(relevantStoryEntities, entry);
  const events = [...(story.chapter?.events || []), ...(story.global?.events || [])];
  const relevantEvent = (entry) =>
    hasStoryCueCandidate || (relevantStoryEntities.size > 0 && includes(entry));
  const characterStates = story.chapter?.characterStates || story.global?.characterStates || [];
  return {
    globalSummary: story.global?.summary || null,
    chapterSummary: story.chapter?.summary || null,
    characters: compactRelevantStoryEntries(story.global?.characters, includes, 12),
    relationships: compactRelevantStoryEntries(story.global?.relationships, includes, 12),
    events: compactRelevantStoryEntries(events, relevantEvent, 8),
    characterStates: compactRelevantStoryEntries(characterStates, includes, 8),
  };
}

function buildQualityStyleExamples(style, representedRoles) {
  const styleExamples = [];
  const roleExampleCounts = new Map();
  for (const chapter of style?.chapters || []) {
    for (const [field, role] of [
      ["dialogueSamples", "dialogue"],
      ["narrationSamples", "narration"],
      ["monologueSamples", "monologue"],
    ]) {
      if (representedRoles.size > 0 && !representedRoles.has(role)) continue;
      for (const sample of chapter?.[field] || []) {
        if ((roleExampleCounts.get(role) || 0) >= 3) break;
        styleExamples.push({ role, sample });
        roleExampleCounts.set(role, (roleExampleCounts.get(role) || 0) + 1);
      }
    }
  }
  return styleExamples;
}

function buildQualityStyleContext(style, styleExamples, candidates) {
  if (!style) return null;
  return {
    profile: style.profile || {},
    examples: styleExamples,
    characterSpeech: (style.characterSpeech || []).filter((entry) =>
      candidates.some((candidate) => candidate.speakerRef && candidate.speakerRef === entry.name),
    ),
  };
}

function buildQualityLocalPairs(state, candidates) {
  return (state.translationMemory?.effective?.localKnowledge?.translationPairs || [])
    .filter(isStableLocalPair)
    .filter((pair) =>
      candidates.some(
        (candidate) => normalizeEvidenceText(candidate.original) === normalizeEvidenceText(pair?.original),
      ),
    )
    .slice(0, 20);
}

function buildQualitySequencePages(state, ordered) {
  return (state.qualityObservation?.sequenceRisks || []).map((risk) => ({
    ...risk,
    orderedPairs: ordered
      .filter((entry) => entry.pageName === risk.pageName)
      .map((entry) => ({ nodeId: entry.id, original: entry.original, translation: entry.translation })),
  }));
}

function buildQualityContext(input) {
  const { state, candidates, ordered, relevantGlossary, compactStory, styleExamples, style } = input;
  return {
    glossary: relevantGlossary,
    story: compactStory,
    style: buildQualityStyleContext(style, styleExamples, candidates),
    localPairs: buildQualityLocalPairs(state, candidates),
    sequencePages: buildQualitySequencePages(state, ordered),
  };
}

function windowCandidateKeys(windowCandidates) {
  return {
    sourceTerms: new Set(
      windowCandidates.flatMap((candidate) =>
        candidate.reasons
          .map((reason) => normalizeEvidenceText(reason.evidence?.sourceTerm))
          .filter(Boolean),
      ),
    ),
    originals: new Set(windowCandidates.map((candidate) => normalizeEvidenceText(candidate.original))),
  };
}

function windowSequencePages(context, purpose, windowCandidates) {
  if (purpose !== "sequence") return [];
  return (context.sequencePages || []).filter((page) =>
    windowCandidates.some((candidate) => candidate.pageName === page.pageName),
  );
}

function contextForWindow(context, purpose, windowCandidates) {
  const { sourceTerms, originals } = windowCandidateKeys(windowCandidates);
  return {
    glossary: context.glossary.filter((entry) =>
      sourceTerms.has(normalizeEvidenceText(entry.sourceTerm)),
    ),
    story: purpose === "story" ? context.story : null,
    style: purpose === "style" ? context.style : null,
    localPairs: context.localPairs.filter((pair) =>
      originals.has(normalizeEvidenceText(pair?.original)),
    ),
    sequencePages: windowSequencePages(context, purpose, windowCandidates),
  };
}

function qualityWindowBytes(purpose, candidates, contextForWindowFn) {
  return Buffer.byteLength(
    JSON.stringify({ purpose, context: contextForWindowFn(purpose, candidates), candidates }),
    "utf8",
  );
}

function pushQualityWindow(windows, current, currentPurpose, contextForWindowFn) {
  if (current.length === 0) return;
  const inputBytes = qualityWindowBytes(currentPurpose, current, contextForWindowFn);
  const purposeIndex = windows.filter((window) => window.purpose === currentPurpose).length + 1;
  windows.push({
    windowId: `quality_${currentPurpose}_${String(purposeIndex).padStart(3, "0")}`,
    purpose: currentPurpose,
    candidates: current,
    inputBytes,
  });
}

function qualityPurposeLimit(purposeDefinition, windowSize) {
  return Number.isInteger(windowSize) && windowSize > 0
    ? Math.min(windowSize, purposeDefinition.limit)
    : purposeDefinition.limit;
}

function assertQualityCandidateFits(candidate, current, purpose, contextForWindowFn, windowByteBudget) {
  if (qualityWindowBytes(purpose, current, contextForWindowFn) <= windowByteBudget) return;
  throw new Error(`Quality candidate ${candidate.nodeId} exceeds the ${windowByteBudget}-byte window budget.`);
}

function buildQualityWindowsForPurpose(input) {
  const { purposeDefinition, purposeCandidates, contextForWindowFn, windowSize } = input;
  const { windowByteBudget, windows } = input;
  let current = [];
  const currentPurpose = purposeDefinition.purpose;
  const purposeLimit = qualityPurposeLimit(purposeDefinition, windowSize);
  for (const candidate of purposeCandidates) {
    const proposed = [...current, candidate];
    const proposedBytes = qualityWindowBytes(currentPurpose, proposed, contextForWindowFn);
    if (current.length > 0 && (proposed.length > purposeLimit || proposedBytes > windowByteBudget)) {
      pushQualityWindow(windows, current, currentPurpose, contextForWindowFn);
      current = [];
    }
    current.push(candidate);
    assertQualityCandidateFits(candidate, current, currentPurpose, contextForWindowFn, windowByteBudget);
  }
  pushQualityWindow(windows, current, currentPurpose, contextForWindowFn);
}

function buildQualityWindows(candidates, context, windowSize, windowByteBudget) {
  const windows = [];
  const contextForWindowFn = (purpose, windowCandidates) =>
    contextForWindow(context, purpose, windowCandidates);
  for (const purposeDefinition of QUALITY_PURPOSES) {
    const purposeCandidates = candidates.filter(
      (candidate) => qualityPurpose(candidate) === purposeDefinition.purpose,
    );
    buildQualityWindowsForPurpose({
      purposeDefinition,
      purposeCandidates,
      contextForWindowFn,
      windowSize,
      windowByteBudget,
      windows,
    });
  }
  return windows;
}

function buildQualityCounts(candidates) {
  const candidateReasonCounts = {};
  const candidatePurposeCounts = {};
  for (const candidate of candidates) {
    for (const reason of candidate.reasons)
      candidateReasonCounts[reason.type] =
        (candidateReasonCounts[reason.type] || 0) + 1;
    const purpose = qualityPurpose(candidate);
    candidatePurposeCounts[purpose] =
      (candidatePurposeCounts[purpose] || 0) + 1;
  }
  return { candidateReasonCounts, candidatePurposeCounts };
}

function applyQualityReasons(state, inputs, representativeLimit, includeAll) {
  addQualityTranslationReasons(state, inputs.ordered, inputs.languages);
  addObserverQualityReasons(state, inputs.ordered);
  if (!state.observerDriven) {
    addNonObserverStyleSpeakerReasons(state);
    addRepresentativeQualityReasons(state, inputs.ordered, representativeLimit);
  }
  addChapterRenderingDrift(state);
  if (includeAll) addDeepAuditQualityReasons(state, inputs.ordered);
}

function buildQualitySemanticAnnotations(inputs) {
  return inputs.ordered
    .filter((entry) => entry.textRole || entry.styleChannel || entry.speakerRef)
    .map((entry) => ({
      nodeId: entry.id,
      textRole: entry.textRole || null,
      styleChannel: entry.styleChannel || null,
      speakerRef: entry.speakerRef || null,
      roleConfidence: entry.roleConfidence ?? null,
      speakerConfidence: entry.speakerConfidence ?? null,
    }));
}

function qualityCandidateCoverage(inputs, candidates) {
  return inputs.ordered.length > 0
    ? Number((candidates.length / inputs.ordered.length).toFixed(4))
    : 0;
}

function buildQualityProjection(input) {
  const { inputs, candidates, counts, context, windows, semanticEvidenceFingerprint } = input;
  const { translationMemory, qualityObservation, windowByteBudget } = input;
  return {
    schemaVersion: QUALITY_PROJECTION_SCHEMA_VERSION,
    translationMemoryFingerprint: translationMemory?.fingerprint || null,
    translationMemoryRevisions: translationMemory?.revisions || [],
    semanticEvidenceFingerprint,
    qualityObservationFingerprint: qualityObservation?.fingerprint || null,
    chapterMapping: translationMemory?.chapterMapping || null,
    languages: inputs.languages,
    totalTranslations: inputs.ordered.length,
    candidateCount: candidates.length,
    omittedCount: Math.max(0, inputs.ordered.length - candidates.length),
    coverage: qualityCandidateCoverage(inputs, candidates),
    candidateReasonCounts: counts.candidateReasonCounts,
    candidatePurposeCounts: counts.candidatePurposeCounts,
    context,
    semanticAnnotations: buildQualitySemanticAnnotations(inputs),
    candidates,
    windows,
    windowByteBudget,
  };
}

function buildQualitySemanticCoverage(projection, ordered) {
  return {
    annotated: projection.semanticAnnotations.length,
    total: ordered.length,
    ratio:
      ordered.length > 0
        ? Number(
            (projection.semanticAnnotations.length / ordered.length).toFixed(4),
          )
        : 0,
  };
}

function normalizeQualityProjectionParams(params) {
  const input = {
    windowSize: null,
    representativeLimit: DEFAULT_REPRESENTATIVE_LIMIT,
    windowByteBudget: DEFAULT_WINDOW_BYTE_BUDGET,
    includeAll: false,
    semanticRoleEvidence: [],
    semanticEvidenceFingerprint: null,
    qualityObservation: null,
    ...(params || {}),
  };
  if (input.sourceLanguage === undefined)
    input.sourceLanguage = input.translationMemory?.languages?.sourceLanguage || null;
  if (input.targetLanguage === undefined)
    input.targetLanguage = input.translationMemory?.languages?.targetLanguage || null;
  return input;
}

function prepareQualityProjection(input) {
  const inputs = prepareQualityInputs({
    translations: input.translations,
    translationMemory: input.translationMemory,
    semanticRoleEvidence: input.semanticRoleEvidence,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
  });
  const state = createQualityCandidateState({
    translationMemory: input.translationMemory,
    qualityObservation: input.qualityObservation,
    stableLocalPairs: inputs.stableLocalPairs,
  });
  applyQualityReasons(state, inputs, input.representativeLimit, input.includeAll);
  const candidates = buildQualityCandidates(state, inputs.ordered);
  return { inputs, state, candidates };
}

function prepareQualityContext(input, prepared) {
  const { inputs, state, candidates } = prepared;
  const relevantData = buildRelevantQualityData(state, candidates);
  const compactStory = buildCompactQualityStory(
    state.story,
    relevantData.relevantStoryEntities,
    relevantData.hasStoryCueCandidate,
  );
  const style = input.translationMemory?.effective?.style || null;
  return buildQualityContext({
    state,
    candidates,
    ordered: inputs.ordered,
    relevantGlossary: relevantData.relevantGlossary,
    compactStory,
    styleExamples: buildQualityStyleExamples(style, relevantData.representedRoles),
    style,
  });
}

function finalizeQualityProjection(projection, ordered) {
  projection.semanticCoverage = buildQualitySemanticCoverage(projection, ordered);
  projection.fingerprint = stableHash(projection);
  return projection;
}

function buildQualityContextProjection(params = {}) {
  const input = normalizeQualityProjectionParams(params);
  const prepared = prepareQualityProjection(input);
  const context = prepareQualityContext(input, prepared);
  const windows = buildQualityWindows(
    prepared.candidates,
    context,
    input.windowSize,
    input.windowByteBudget,
  );
  const projection = buildQualityProjection({
    ...prepared,
    counts: buildQualityCounts(prepared.candidates),
    context,
    windows,
    semanticEvidenceFingerprint: input.semanticEvidenceFingerprint,
    translationMemory: input.translationMemory,
    qualityObservation: input.qualityObservation,
    windowByteBudget: input.windowByteBudget,
  });
  return finalizeQualityProjection(projection, prepared.inputs.ordered);
}

function buildQualityWindowInput(projection, window) {
  const context = {
    ...projection.context,
    sequencePages:
      window.purpose === "sequence"
        ? (projection.context.sequencePages || []).filter((page) =>
            window.candidates.some(
              (candidate) => candidate.pageName === page.pageName,
            ),
          )
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
