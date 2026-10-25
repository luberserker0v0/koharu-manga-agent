const fs = require("fs");
const path = require("path");
const { paths } = require("../../../config");
const { validateLearningEvidenceSnapshot } = require("./learning_evidence");
const { resolveKnowledgePaths, upsertKnowledgeIndexEntry } = require("../registry/knowledge_paths");

const SCHEMA_VERSION = "2.0";

function ensureDirectory(targetFile) {
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
}

function upsertTodoList(todoPath) {
  if (!fs.existsSync(todoPath)) {
    fs.writeFileSync(todoPath, "# Knowledge Base Tasks\n\n## Pending\n\n## Completed\n\n## Reflection\n");
  }
}

function updateTodoList(todoPath) {
  upsertTodoList(todoPath);
  const content = fs.readFileSync(todoPath, "utf-8");
  const date = new Date().toISOString().split("T")[0];
  let next = content;

  if (!next.includes("- [x] Update knowledge base")) {
    next = next.replace("## Completed\n", `## Completed\n- [x] Update knowledge base (${date})\n`);
  }

  if (!next.includes("- [ ] Review translation consistency after the update")) {
    next = next.replace("## Reflection\n", "## Reflection\n- [ ] Review translation consistency after the update\n");
  }

  fs.writeFileSync(todoPath, next);
}

function extractTranslationPairs(scene, chapterId = null) {
  const pages = scene.scene?.pages || {};
  const pairs = [];

  for (const page of Object.values(pages)) {
    for (const [nodeId, node] of Object.entries(page.nodes || {})) {
      const textNode = node.kind?.text;
      if (textNode && textNode.text && textNode.translation) {
        pairs.push({
          id: null,
          original: textNode.text,
          translation: textNode.translation,
          pageName: page.name,
          nodeId,
          chapterId,
          sourceReference: "self",
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  return pairs;
}

function translationPairsFromList(translations, chapterId = null) {
  return (Array.isArray(translations) ? translations : [])
    .filter(
      (entry) =>
        entry &&
        typeof entry.original === "string" &&
        entry.original &&
        typeof entry.translation === "string" &&
        entry.translation,
    )
    .map((entry, index) => ({
      id: entry.id || null,
      original: entry.original,
      translation: entry.translation,
      pageName: entry.pageName || `preview_${String(index + 1).padStart(3, "0")}.txt`,
      nodeId: entry.nodeId || entry.id || `preview_${String(index + 1).padStart(4, "0")}`,
      chapterId,
      sourceReference: "self",
      confidence: Number.isFinite(entry.confidence) ? entry.confidence : null,
      evidenceReasons: Array.isArray(entry.reasons) ? entry.reasons : [],
      textRole: entry.textRole || null,
      styleChannel: entry.styleChannel || null,
      speakerRef: entry.speakerRef || null,
      roleConfidence: Number.isFinite(entry.roleConfidence) ? entry.roleConfidence : null,
      speakerConfidence: Number.isFinite(entry.speakerConfidence) ? entry.speakerConfidence : null,
      updatedAt: new Date().toISOString(),
    }));
}

function defaultKnowledgeMetadata(projectName, now) {
  return {
    schema_version: SCHEMA_VERSION,
    manga_id: null,
    chapter_ids: [],
    project_name: projectName,
    source: "self",
    created_at: now,
    updated_at: now,
    last_enriched_at: now,
    enrichment_mode: "ao",
    source_projects: [],
  };
}

function defaultNarrationProfile() {
  return {
    tone: null,
    register: null,
    preferred_patterns: [],
    forbidden_patterns: [],
    notes: [],
  };
}

function defaultStyleProfile() {
  return {
    tone: null,
    register: null,
    honorific_policy: [],
    punctuation_policy: [],
    preferred_patterns: [],
    forbidden_patterns: [],
    narration: defaultNarrationProfile(),
    notes: [],
  };
}

function defaultKnowledgeBase(projectName = "unknown") {
  const now = new Date().toISOString();
  return {
    metadata: defaultKnowledgeMetadata(projectName, now),
    translation_pairs: [],
    terminology: [],
    characters: [],
    style_profile: defaultStyleProfile(),
    style_examples: [],
  };
}

function normalizeInferenceArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    return Object.values(value);
  }
  return [];
}

function normalizeNarrationProfile(styleNarration, baseNarration) {
  if (!styleNarration || typeof styleNarration !== "object" || Array.isArray(styleNarration)) {
    return baseNarration;
  }
  return {
    tone: styleNarration.tone ?? null,
    register: styleNarration.register ?? null,
    preferred_patterns: Array.isArray(styleNarration.preferred_patterns) ? styleNarration.preferred_patterns : [],
    forbidden_patterns: Array.isArray(styleNarration.forbidden_patterns) ? styleNarration.forbidden_patterns : [],
    notes: Array.isArray(styleNarration.notes) ? styleNarration.notes : [],
  };
}

function normalizeStyleProfile(styleProfile) {
  const base = defaultKnowledgeBase().style_profile;
  if (!styleProfile || typeof styleProfile !== "object" || Array.isArray(styleProfile)) {
    return base;
  }

  return {
    tone: styleProfile.tone ?? null,
    register: styleProfile.register ?? null,
    honorific_policy: Array.isArray(styleProfile.honorific_policy) ? styleProfile.honorific_policy : [],
    punctuation_policy: Array.isArray(styleProfile.punctuation_policy) ? styleProfile.punctuation_policy : [],
    preferred_patterns: Array.isArray(styleProfile.preferred_patterns) ? styleProfile.preferred_patterns : [],
    forbidden_patterns: Array.isArray(styleProfile.forbidden_patterns) ? styleProfile.forbidden_patterns : [],
    narration: normalizeNarrationProfile(styleProfile.narration, base.narration),
    notes: Array.isArray(styleProfile.notes) ? styleProfile.notes : [],
  };
}

function normalizeStringArray(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter(Boolean))];
}

function normalizeStyleExampleEntry(entry, fallbackChapterId = null) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const translation = typeof entry.translation === "string" ? entry.translation.trim() : "";
  if (!translation) {
    return null;
  }

  return {
    type: ["dialogue", "narration", "monologue"].includes(entry.type) ? entry.type : "dialogue",
    textRole: entry.textRole || entry.type || null,
    styleChannel: entry.styleChannel || null,
    speakerRef: entry.textRole === "narration" || entry.type === "narration" ? null : entry.speakerRef || null,
    roleConfidence: Number.isFinite(entry.roleConfidence) ? entry.roleConfidence : null,
    speakerConfidence: Number.isFinite(entry.speakerConfidence) ? entry.speakerConfidence : null,
    confidence: Number.isFinite(entry.confidence) ? entry.confidence : null,
    original: entry.original || null,
    pageName: entry.pageName || null,
    nodeId: entry.nodeId || null,
    chapterId: entry.chapterId || fallbackChapterId || null,
    translation,
    reason: entry.reason || null,
  };
}

function styleExampleMergeKey(entry) {
  return [entry.type || "", entry.chapterId || "", entry.pageName || "", entry.nodeId || "", entry.translation].join(
    "::",
  );
}

function mergeStyleExampleEntryInto(current, entry) {
  return {
    ...current,
    original: entry.original || current.original,
    textRole: entry.textRole || current.textRole,
    styleChannel: entry.styleChannel || current.styleChannel,
    speakerRef: entry.speakerRef || current.speakerRef,
    roleConfidence: entry.roleConfidence ?? current.roleConfidence,
    speakerConfidence: entry.speakerConfidence ?? current.speakerConfidence,
    confidence: entry.confidence ?? current.confidence,
    reason: entry.reason || current.reason,
  };
}

function mergeStyleExampleEntries(existingEntries, incomingEntries, fallbackChapterId = null, limit = 16) {
  const seen = new Map();
  const merged = [];

  for (const rawEntry of [...(existingEntries || []), ...(incomingEntries || [])]) {
    const entry = normalizeStyleExampleEntry(rawEntry, fallbackChapterId);
    if (!entry) {
      continue;
    }
    const key = styleExampleMergeKey(entry);
    if (seen.has(key)) {
      const index = seen.get(key);
      merged[index] = mergeStyleExampleEntryInto(merged[index], entry);
      continue;
    }
    seen.set(key, merged.length);
    merged.push(entry);
  }

  return merged.slice(-limit);
}

function styleExamplesFromLearningEvidence(evidenceRows, chapterId) {
  return (evidenceRows || [])
    .filter(
      (entry) =>
        (entry.reasons || []).some((reason) => reason === "style_evidence" || reason === "speaker_evidence") &&
        Number(entry.confidence) >= 0.75,
    )
    .map((entry) => ({
      type:
        entry.textRole === "narration"
          ? "narration"
          : String(entry.textRole || "").includes("monologue")
            ? "monologue"
            : "dialogue",
      textRole: entry.textRole || null,
      styleChannel: entry.styleChannel || null,
      speakerRef: entry.textRole === "narration" ? null : entry.speakerRef || null,
      roleConfidence: entry.roleConfidence ?? null,
      speakerConfidence: entry.speakerConfidence ?? null,
      confidence: entry.confidence,
      original: entry.original,
      translation: entry.translation,
      pageName: entry.pageName || null,
      nodeId: entry.nodeId,
      chapterId,
      reason: "verified_learning_evidence",
    }));
}

function styleEvidenceMetadata(styleEvidence) {
  if (
    styleEvidence &&
    typeof styleEvidence === "object" &&
    styleEvidence.metadata &&
    typeof styleEvidence.metadata === "object"
  ) {
    return styleEvidence.metadata;
  }
  return null;
}

function styleEvidenceChapterCoverage(styleEvidence) {
  const metadata = styleEvidenceMetadata(styleEvidence);
  return Array.isArray(metadata?.source_chapters) ? metadata.source_chapters.length : 0;
}

function styleEvidenceReferenceKindSupport(styleEvidence) {
  const referenceKindSupport = {};
  if (
    styleEvidence &&
    typeof styleEvidence === "object" &&
    styleEvidence.chapters &&
    typeof styleEvidence.chapters === "object"
  ) {
    for (const chapter of Object.values(styleEvidence.chapters)) {
      if (!chapter || typeof chapter !== "object") {
        continue;
      }
      const kind = chapter.referenceKind || "unknown";
      referenceKindSupport[kind] = (referenceKindSupport[kind] || 0) + 1;
    }
  }
  return referenceKindSupport;
}

function mergeStyleProfileNarration(current, incoming) {
  return {
    tone: incoming.narration?.tone || current.narration?.tone || null,
    register: incoming.narration?.register || current.narration?.register || null,
    preferred_patterns: normalizeStringArray([
      ...(current.narration?.preferred_patterns || []),
      ...(incoming.narration?.preferred_patterns || []),
    ]),
    forbidden_patterns: normalizeStringArray([
      ...(current.narration?.forbidden_patterns || []),
      ...(incoming.narration?.forbidden_patterns || []),
    ]),
    notes: normalizeStringArray([...(current.narration?.notes || []), ...(incoming.narration?.notes || [])]),
  };
}

function mergeStyleProfileNotes(current, incoming, chapterCoverage, referenceKindSupport) {
  return normalizeStringArray([
    ...(current.notes || []),
    ...(incoming.notes || []),
    chapterCoverage > 0 ? `chapter_coverage:${chapterCoverage}` : null,
    Object.keys(referenceKindSupport).length > 0
      ? `reference_kind_support:${JSON.stringify(referenceKindSupport)}`
      : null,
  ]);
}

function mergeStyleProfile(existingProfile, incomingProfile, styleEvidence = null) {
  const current = normalizeStyleProfile(existingProfile);
  const incoming = normalizeStyleProfile(incomingProfile);
  const chapterCoverage = styleEvidenceChapterCoverage(styleEvidence);
  const referenceKindSupport = styleEvidenceReferenceKindSupport(styleEvidence);

  return normalizeStyleProfile({
    ...current,
    ...incoming,
    tone: incoming.tone || current.tone || null,
    register: incoming.register || current.register || null,
    honorific_policy: normalizeStringArray([...(current.honorific_policy || []), ...(incoming.honorific_policy || [])]),
    punctuation_policy: normalizeStringArray([
      ...(current.punctuation_policy || []),
      ...(incoming.punctuation_policy || []),
    ]),
    preferred_patterns: normalizeStringArray([
      ...(current.preferred_patterns || []),
      ...(incoming.preferred_patterns || []),
    ]),
    forbidden_patterns: normalizeStringArray([
      ...(current.forbidden_patterns || []),
      ...(incoming.forbidden_patterns || []),
    ]),
    narration: mergeStyleProfileNarration(current, incoming),
    notes: mergeStyleProfileNotes(current, incoming, chapterCoverage, referenceKindSupport),
  });
}

function applyNarrationEvidenceEntry(state, entry, chapterId) {
  if (!entry || typeof entry !== "object") {
    return state;
  }
  const next = { ...state };
  if (!next.tone && entry.tone) {
    next.tone = entry.tone;
  }
  if (!next.register && entry.register) {
    next.register = entry.register;
  }
  next.preferredPatterns.push(...(Array.isArray(entry.preferred_patterns) ? entry.preferred_patterns : []));
  next.forbiddenPatterns.push(...(Array.isArray(entry.forbidden_patterns) ? entry.forbidden_patterns : []));
  next.notes.push(...(Array.isArray(entry.notes) ? entry.notes : []));
  if (chapterId) {
    next.notes.push(`narration_evidence_chapter:${chapterId}`);
  }
  return next;
}

function mergeNarrationEvidence(existingProfile, narrationEvidenceEntries, chapterId = null) {
  const current = normalizeStyleProfile(existingProfile);
  const initial = {
    tone: current.narration?.tone || null,
    register: current.narration?.register || null,
    preferredPatterns: [...(current.narration?.preferred_patterns || [])],
    forbiddenPatterns: [...(current.narration?.forbidden_patterns || [])],
    notes: [...(current.narration?.notes || [])],
  };
  const state = (narrationEvidenceEntries || []).reduce(
    (accumulator, entry) => applyNarrationEvidenceEntry(accumulator, entry, chapterId),
    initial,
  );

  return normalizeStyleProfile({
    ...current,
    narration: {
      tone: state.tone,
      register: state.register,
      preferred_patterns: normalizeStringArray(state.preferredPatterns),
      forbidden_patterns: normalizeStringArray(state.forbiddenPatterns),
      notes: normalizeStringArray(state.notes),
    },
  });
}

function normalizeExampleEntry(example, fallbackChapterId = null) {
  if (!example || typeof example !== "object") {
    return null;
  }
  const normalized = {
    pageName: example.pageName || null,
    nodeId: example.nodeId || null,
    original: example.original || null,
    translation: example.translation || null,
    chapterId: example.chapterId || fallbackChapterId || null,
    textRole: example.textRole || null,
    styleChannel: example.styleChannel || null,
    speakerRef: example.textRole === "narration" ? null : example.speakerRef || null,
    roleConfidence: Number.isFinite(example.roleConfidence) ? example.roleConfidence : null,
    speakerConfidence: Number.isFinite(example.speakerConfidence) ? example.speakerConfidence : null,
    confidence: Number.isFinite(example.confidence) ? example.confidence : null,
  };
  return normalized.translation ? normalized : null;
}

function exampleDedupeKey(normalized) {
  return [normalized.pageName || "", normalized.nodeId || "", normalized.chapterId || "", normalized.translation].join(
    "::",
  );
}

function normalizeExampleList(examples, fallbackChapterId = null) {
  const seen = new Set();
  const output = [];

  for (const example of Array.isArray(examples) ? examples : []) {
    const normalized = normalizeExampleEntry(example, fallbackChapterId);
    if (!normalized) {
      continue;
    }
    const key = exampleDedupeKey(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }

  return output;
}

function mergeExampleLists(existingExamples, incomingExamples, fallbackChapterId = null, limit = 8) {
  return normalizeExampleList(
    [
      ...normalizeExampleList(existingExamples, fallbackChapterId),
      ...normalizeExampleList(incomingExamples, fallbackChapterId),
    ],
    fallbackChapterId,
  ).slice(-limit);
}

function emptyEvidence() {
  const now = new Date().toISOString();
  return {
    mention_count: 0,
    chapter_ids: [],
    source_counts: {
      self: 0,
      reference: 0,
    },
    high_confidence_hits: 0,
    medium_confidence_hits: 0,
    score: 0,
    first_seen_at: now,
    last_seen_at: now,
  };
}

function normalizeEvidenceSourceCounts(sourceCounts) {
  return {
    self: typeof sourceCounts?.self === "number" && Number.isFinite(sourceCounts.self) ? sourceCounts.self : 0,
    reference:
      typeof sourceCounts?.reference === "number" && Number.isFinite(sourceCounts.reference)
        ? sourceCounts.reference
        : 0,
  };
}

function normalizeFiniteOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeEvidence(evidence) {
  const base = emptyEvidence();
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return base;
  }

  return {
    mention_count: normalizeFiniteOrZero(evidence.mention_count) || base.mention_count,
    chapter_ids: normalizeStringArray(evidence.chapter_ids),
    source_counts: normalizeEvidenceSourceCounts(evidence.source_counts),
    high_confidence_hits: normalizeFiniteOrZero(evidence.high_confidence_hits),
    medium_confidence_hits: normalizeFiniteOrZero(evidence.medium_confidence_hits),
    score: normalizeFiniteOrZero(evidence.score),
    first_seen_at: evidence.first_seen_at || base.first_seen_at,
    last_seen_at: evidence.last_seen_at || base.last_seen_at,
  };
}

function calculateEvidenceScore(evidence) {
  const mentionCount = evidence.mention_count || 0;
  const chapterCount = (evidence.chapter_ids || []).length;
  const referenceWeight = Math.min(evidence.source_counts?.reference || 0, 3) * 2;
  const selfWeight = Math.min(evidence.source_counts?.self || 0, 6) * 0.5;
  const highWeight = (evidence.high_confidence_hits || 0) * 1.5;
  const mediumWeight = (evidence.medium_confidence_hits || 0) * 0.5;
  return Number(
    (mentionCount + chapterCount * 2 + referenceWeight + selfWeight + highWeight + mediumWeight).toFixed(2),
  );
}

function deriveConfidenceFromEvidence(score, explicitConfidence = null) {
  const baseline = 0.45 + Math.min(score, 12) * 0.04;
  const candidate =
    explicitConfidence && Number.isFinite(explicitConfidence) ? Math.max(baseline, explicitConfidence) : baseline;
  return Math.max(0.45, Math.min(0.99, Number(candidate.toFixed(2))));
}

function deriveEntryStatus({ locked = false, source = null, evidence }) {
  if (locked || source === "manual") {
    return "locked";
  }
  const chapterCount = (evidence.chapter_ids || []).length;
  if ((evidence.source_counts?.reference || 0) >= 1 && evidence.score >= 7) {
    return "stable";
  }
  if (chapterCount >= 2 || evidence.score >= 8) {
    return "stable";
  }
  return "draft";
}

function buildIncomingEvidence(entry, sourceType = "self", chapterId = null) {
  const now = new Date().toISOString();
  const examples = normalizeExampleList(entry.examples || entry.example_lines || [], chapterId);
  const mentionCount = Math.max(examples.length, 1);
  const chapters = new Set([chapterId, ...examples.map((example) => example.chapterId)].filter(Boolean));
  const explicitConfidence = Number.isFinite(entry.confidence) ? entry.confidence : null;
  const evidence = {
    mention_count: mentionCount,
    chapter_ids: [...chapters],
    source_counts: {
      self: sourceType === "self" ? mentionCount : 0,
      reference: sourceType === "reference" ? mentionCount : 0,
    },
    high_confidence_hits: explicitConfidence !== null && explicitConfidence >= 0.85 ? 1 : 0,
    medium_confidence_hits:
      explicitConfidence !== null && explicitConfidence >= 0.65 && explicitConfidence < 0.85 ? 1 : 0,
    score: 0,
    first_seen_at: now,
    last_seen_at: now,
  };
  evidence.score = calculateEvidenceScore(evidence);
  return evidence;
}

function mergeEvidence(existingEvidence, incomingEvidence) {
  const current = normalizeEvidence(existingEvidence);
  const incoming = normalizeEvidence(incomingEvidence);
  const incomingAddsNewChapter = (incoming.chapter_ids || []).some(
    (chapterId) => !(current.chapter_ids || []).includes(chapterId),
  );
  if ((incoming.chapter_ids || []).length > 0 && !incomingAddsNewChapter) {
    return current;
  }
  const merged = {
    mention_count: current.mention_count + incoming.mention_count,
    chapter_ids: normalizeStringArray([...(current.chapter_ids || []), ...(incoming.chapter_ids || [])]),
    source_counts: {
      self: (current.source_counts?.self || 0) + (incoming.source_counts?.self || 0),
      reference: (current.source_counts?.reference || 0) + (incoming.source_counts?.reference || 0),
    },
    high_confidence_hits: (current.high_confidence_hits || 0) + (incoming.high_confidence_hits || 0),
    medium_confidence_hits: (current.medium_confidence_hits || 0) + (incoming.medium_confidence_hits || 0),
    score: 0,
    first_seen_at: current.first_seen_at || incoming.first_seen_at,
    last_seen_at: incoming.last_seen_at || current.last_seen_at,
  };
  merged.score = calculateEvidenceScore(merged);
  return merged;
}

function normalizeTerminologyKnowledgeEntry(entry) {
  const normalized = {
    term: entry?.term || entry?.translation || "",
    translation: entry?.translation || entry?.term || "",
    category: entry?.category || null,
    notes: entry?.notes || null,
    examples: normalizeExampleList(entry?.examples || []),
    aliases: normalizeStringArray(entry?.aliases),
    source: entry?.source || "self",
    locked: entry?.locked === true,
    status: entry?.status || "draft",
    confidence: Number.isFinite(entry?.confidence) ? entry.confidence : 0.45,
    evidence: normalizeEvidence(entry?.evidence),
  };
  normalized.evidence.score = calculateEvidenceScore(normalized.evidence);
  normalized.status = deriveEntryStatus(normalized);
  normalized.confidence = deriveConfidenceFromEvidence(normalized.evidence.score, normalized.confidence);
  return normalized;
}

function normalizeCharacterKnowledgeEntry(entry) {
  const normalized = {
    identity_key: entry?.identity_key || entry?.name || "",
    name: entry?.name || "",
    aliases: normalizeStringArray(entry?.aliases),
    title_forms: normalizeStringArray(entry?.title_forms),
    speech_style: normalizeStringArray(entry?.speech_style),
    sentence_ending_patterns: normalizeStringArray(entry?.sentence_ending_patterns),
    addressing_patterns: normalizeStringArray(entry?.addressing_patterns),
    first_seen_chapter: entry?.first_seen_chapter || null,
    example_lines: normalizeExampleList(entry?.example_lines || []),
    notes: Array.isArray(entry?.notes) ? entry.notes : entry?.notes ? [entry.notes] : [],
    source: entry?.source || "self",
    locked: entry?.locked === true,
    status: entry?.status || "draft",
    confidence: Number.isFinite(entry?.confidence) ? entry.confidence : 0.45,
    evidence: normalizeEvidence(entry?.evidence),
  };
  normalized.evidence.score = calculateEvidenceScore(normalized.evidence);
  normalized.status = deriveEntryStatus(normalized);
  normalized.confidence = deriveConfidenceFromEvidence(normalized.evidence.score, normalized.confidence);
  return normalized;
}

function pairKey(pair) {
  return [pair.original, pair.translation, pair.textRole || "", pair.speakerRef || ""].join("::");
}

function removeChapterEvidenceFromEntry(entry, chapterId, exampleField) {
  const normalizedEvidence = normalizeEvidence(entry.evidence);
  if (!normalizedEvidence.chapter_ids.includes(chapterId)) {
    return entry;
  }
  const examples = normalizeExampleList(entry[exampleField] || []);
  const removedExampleCount = examples.filter((example) => example.chapterId === chapterId).length;
  const decrement = Math.max(removedExampleCount, 1);
  const evidence = {
    ...normalizedEvidence,
    mention_count: Math.max(0, normalizedEvidence.mention_count - decrement),
    chapter_ids: normalizedEvidence.chapter_ids.filter((entryChapterId) => entryChapterId !== chapterId),
    source_counts: {
      ...normalizedEvidence.source_counts,
      self: Math.max(0, (normalizedEvidence.source_counts?.self || 0) - decrement),
    },
    last_seen_at: new Date().toISOString(),
  };
  evidence.score = calculateEvidenceScore(evidence);
  return {
    ...entry,
    [exampleField]: examples.filter((example) => example.chapterId !== chapterId),
    evidence,
  };
}

function removeChapterFromTranslationPairs(pairs, chapterId) {
  return (pairs || [])
    .map((pair) => {
      const occurrences = (
        pair.occurrences || [
          {
            chapterId: pair.chapterId,
            pageName: pair.pageName,
            nodeId: pair.nodeId,
          },
        ]
      ).filter((entry) => entry.chapterId !== chapterId);
      if (occurrences.length === 0) return null;
      const chapterIds = [...new Set(occurrences.map((entry) => entry.chapterId).filter(Boolean))];
      return {
        ...pair,
        occurrences,
        mentionCount: occurrences.length,
        chapterIds,
        chapterId: chapterIds.length === 1 ? chapterIds[0] : null,
        pageName: occurrences.length === 1 ? occurrences[0].pageName : null,
        nodeId: occurrences.length === 1 ? occurrences[0].nodeId : null,
      };
    })
    .filter(Boolean);
}

function removeChapterFromTerminology(entries, chapterId) {
  return (entries || [])
    .map((entry) =>
      entry.locked === true || entry.source === "manual" || entry.source === "reference"
        ? entry
        : removeChapterEvidenceFromEntry(entry, chapterId, "examples"),
    )
    .filter(
      (entry) =>
        entry.locked === true ||
        entry.source === "manual" ||
        entry.source === "reference" ||
        (entry.evidence?.chapter_ids || []).length > 0,
    )
    .map(normalizeTerminologyKnowledgeEntry);
}

function removeChapterFromCharacters(entries, chapterId) {
  return (entries || [])
    .map((entry) =>
      entry.locked === true || entry.source === "manual" || entry.source === "reference"
        ? entry
        : removeChapterEvidenceFromEntry(entry, chapterId, "example_lines"),
    )
    .filter(
      (entry) =>
        entry.locked === true ||
        entry.source === "manual" ||
        entry.source === "reference" ||
        (entry.evidence?.chapter_ids || []).length > 0,
    )
    .map(normalizeCharacterKnowledgeEntry);
}

function removeChapterNarrationNotes(styleProfile, chapterId) {
  if (styleProfile?.narration?.notes) {
    styleProfile.narration.notes = styleProfile.narration.notes.filter(
      (note) => note !== `narration_evidence_chapter:${chapterId}`,
    );
  }
  return styleProfile;
}

function removeChapterLearningEvidence(knowledge, chapterId) {
  if (!chapterId) return knowledge;
  knowledge.translation_pairs = removeChapterFromTranslationPairs(knowledge.translation_pairs, chapterId);
  knowledge.style_examples = (knowledge.style_examples || []).filter((entry) => entry.chapterId !== chapterId);
  knowledge.terminology = removeChapterFromTerminology(knowledge.terminology, chapterId);
  knowledge.characters = removeChapterFromCharacters(knowledge.characters, chapterId);
  knowledge.style_profile = removeChapterNarrationNotes(knowledge.style_profile, chapterId);
  return knowledge;
}

function updateKnowledgeMetadataAfterChapterDelete(knowledge, chapterId) {
  if (!knowledge.metadata || typeof knowledge.metadata !== "object") {
    return;
  }
  knowledge.metadata.chapter_ids = (knowledge.metadata.chapter_ids || []).filter((id) => id !== chapterId);
  if (knowledge.metadata.chapter_projects && typeof knowledge.metadata.chapter_projects === "object") {
    delete knowledge.metadata.chapter_projects[chapterId];
  }
  knowledge.metadata.updated_at = new Date().toISOString();
  if (knowledge.metadata.chapter_ids.length === 0) {
    knowledge.metadata.source_projects = [];
    knowledge.style_profile = defaultKnowledgeBase().style_profile;
  }
}

function deleteReportIfChapterMatches(reportPath, chapterId) {
  if (!fs.existsSync(reportPath)) {
    return false;
  }
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    if (report.chapterId === chapterId || report.chapter_id === chapterId) {
      fs.rmSync(reportPath, { force: true });
      return true;
    }
  } catch {
    // Leave unrelated or unreadable reports untouched; deletion remains scoped to validated chapter data.
  }
  return false;
}

function captureDeleteBefore(knowledge) {
  return {
    translationPairs: (knowledge.translation_pairs || []).length,
    styleExamples: (knowledge.style_examples || []).length,
    terminology: (knowledge.terminology || []).length,
    characters: (knowledge.characters || []).length,
  };
}

function writeDeleteKnowledgeFile(knowledgePath, knowledge) {
  const temporaryPath = `${knowledgePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(knowledge, null, 2), "utf8");
  fs.renameSync(temporaryPath, knowledgePath);
}

function buildDeleteResult(resolvedPaths, chapterId, before, knowledge, reportDeleted) {
  return {
    deleted: true,
    chapterId,
    knowledgePath: resolvedPaths.knowledgeBasePath,
    reportDeleted,
    removed: {
      translationPairs: before.translationPairs - (knowledge.translation_pairs || []).length,
      styleExamples: before.styleExamples - (knowledge.style_examples || []).length,
      terminology: before.terminology - (knowledge.terminology || []).length,
      characters: before.characters - (knowledge.characters || []).length,
    },
  };
}

function deleteChapterLearningData({ mangaId, translatorId, chapterId }) {
  const resolvedPaths = resolveKnowledgePaths({ mangaId, translatorId });
  const knowledgePath = resolvedPaths.knowledgeBasePath;
  const reportPath = resolvedPaths.reportPath;
  if (!fs.existsSync(knowledgePath)) {
    return { deleted: false, chapterId, knowledgePath, reportDeleted: false };
  }
  const knowledge = JSON.parse(fs.readFileSync(knowledgePath, "utf8"));
  const before = captureDeleteBefore(knowledge);
  removeChapterLearningEvidence(knowledge, chapterId);
  updateKnowledgeMetadataAfterChapterDelete(knowledge, chapterId);
  writeDeleteKnowledgeFile(knowledgePath, knowledge);
  const reportDeleted = deleteReportIfChapterMatches(reportPath, chapterId);
  return buildDeleteResult(resolvedPaths, chapterId, before, knowledge, reportDeleted);
}

function assignPairIds(pairs) {
  return pairs.map((pair, index) => ({
    ...pair,
    id: pair.id || `pair_${String(index + 1).padStart(6, "0")}`,
    occurrences: pair.occurrences || [
      {
        chapterId: pair.chapterId || null,
        pageName: pair.pageName || null,
        nodeId: pair.nodeId || null,
      },
    ],
    mentionCount: pair.mentionCount || pair.occurrences?.length || 1,
    chapterIds: pair.chapterIds || [...new Set([pair.chapterId].filter(Boolean))],
  }));
}

function normalizeMetadataKnowledgeBase(existing, projectName) {
  const merged = {
    ...defaultKnowledgeBase(projectName),
    ...existing,
    metadata: {
      ...defaultKnowledgeBase(projectName).metadata,
      ...existing.metadata,
      schema_version: existing.metadata.schema_version || SCHEMA_VERSION,
    },
  };
  merged.translation_pairs = assignPairIds(Array.isArray(existing.translation_pairs) ? existing.translation_pairs : []);
  merged.metadata.chapter_ids = Array.isArray(merged.metadata.chapter_ids) ? merged.metadata.chapter_ids : [];
  merged.metadata.source_projects = Array.isArray(merged.metadata.source_projects)
    ? merged.metadata.source_projects
    : [];
  merged.terminology = normalizeInferenceArray(existing.terminology).map(normalizeTerminologyKnowledgeEntry);
  merged.characters = normalizeInferenceArray(existing.characters).map(normalizeCharacterKnowledgeEntry);
  merged.style_profile = normalizeStyleProfile(existing.style_profile);
  merged.style_examples = normalizeInferenceArray(existing.style_examples);
  return merged;
}

function migrateLegacyTranslationPairs(existing, migrated) {
  return assignPairIds(
    Array.isArray(existing.translation_pairs)
      ? existing.translation_pairs.map((pair) => ({
          id: pair.id || null,
          original: pair.original,
          translation: pair.translation,
          pageName: pair.pageName,
          nodeId: pair.nodeId || null,
          chapterId: pair.chapterId || null,
          sourceReference: pair.sourceReference || "self",
          updatedAt: pair.updatedAt || existing.updated_at || migrated.metadata.updated_at,
        }))
      : [],
  );
}

function migrateLegacyKnowledgeBase(existing, projectName) {
  const migrated = defaultKnowledgeBase(existing.project_name || projectName);
  migrated.metadata.project_name = existing.project_name || projectName;
  migrated.metadata.source = existing.source || "self";
  migrated.metadata.created_at = existing.created_at || migrated.metadata.created_at;
  migrated.metadata.updated_at = existing.updated_at || migrated.metadata.updated_at;
  migrated.metadata.last_enriched_at = existing.updated_at || migrated.metadata.last_enriched_at;
  migrated.translation_pairs = migrateLegacyTranslationPairs(existing, migrated);
  migrated.terminology = normalizeInferenceArray(existing.terminology).map(normalizeTerminologyKnowledgeEntry);
  migrated.characters = normalizeInferenceArray(existing.characters).map(normalizeCharacterKnowledgeEntry);
  migrated.style_profile = normalizeStyleProfile(existing.style_profile);
  migrated.style_examples = normalizeInferenceArray(existing.style_examples);
  return migrated;
}

function normalizeExistingKnowledgeBase(existing, projectName = "unknown") {
  if (!existing || typeof existing !== "object") {
    return defaultKnowledgeBase(projectName);
  }

  if (existing.metadata) {
    return normalizeMetadataKnowledgeBase(existing, projectName);
  }

  return migrateLegacyKnowledgeBase(existing, projectName);
}

function terminologyEntryKey(entry) {
  return `${entry.category || ""}::${entry.term || ""}`;
}

function mergeOneTerminologyEntry(current, normalized, entry, sourceType, chapterId) {
  const evidence = mergeEvidence(current.evidence, buildIncomingEvidence(entry, sourceType, chapterId));
  const source = current.source === "manual" || current.source === "reference" ? current.source : normalized.source;
  const locked = current.locked === true || normalized.locked === true;
  return normalizeTerminologyKnowledgeEntry({
    ...current,
    term: current.term || normalized.term,
    translation: current.translation || normalized.translation,
    category: current.category || normalized.category,
    notes: current.notes || normalized.notes,
    aliases: normalizeStringArray([...(current.aliases || []), ...(normalized.aliases || []), normalized.term]),
    examples: mergeExampleLists(current.examples, normalized.examples, chapterId, 8),
    source,
    locked,
    evidence,
    confidence: Math.max(current.confidence || 0, normalized.confidence || 0),
    status: deriveEntryStatus({ locked, source, evidence }),
  });
}

function mergeTerminologyEntries(existingEntries, incomingEntries, options = {}) {
  const sourceType = options.sourceType || "self";
  const chapterId = options.chapterId || null;
  const merged = new Map();
  for (const entry of existingEntries || []) {
    const normalized = normalizeTerminologyKnowledgeEntry(entry);
    merged.set(terminologyEntryKey(normalized), normalized);
  }

  for (const entry of incomingEntries || []) {
    const normalized = normalizeTerminologyKnowledgeEntry({
      ...entry,
      evidence: buildIncomingEvidence(entry, sourceType, chapterId),
    });
    const key = terminologyEntryKey(normalized);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, normalized);
      continue;
    }
    merged.set(key, mergeOneTerminologyEntry(current, normalized, entry, sourceType, chapterId));
  }

  return [...merged.values()];
}

function characterIdentityValues(entry) {
  return new Set([entry.identity_key, entry.name, ...(entry.aliases || [])].filter(Boolean));
}

function findCharacterIndex(merged, incomingValues) {
  return merged.findIndex((candidate) =>
    [...characterIdentityValues(candidate)].some((value) => incomingValues.has(value)),
  );
}

function mergeCharacterName(current, normalized) {
  const preserveCurrentName = current.locked === true || current.source === "manual" || current.source === "reference";
  return preserveCurrentName ? current.name : normalized.name || current.name;
}

function mergedCharacterArrayFields(current, normalized, mergedName, chapterId) {
  return {
    identity_key: current.identity_key || normalized.identity_key,
    name: mergedName,
    aliases: normalizeStringArray([
      ...(current.aliases || []),
      ...(normalized.aliases || []),
      current.name !== mergedName ? current.name : null,
      normalized.identity_key !== mergedName ? normalized.identity_key : null,
    ]),
    speech_style: normalizeStringArray([...(current.speech_style || []), ...(normalized.speech_style || [])]),
    sentence_ending_patterns: normalizeStringArray([
      ...(current.sentence_ending_patterns || []),
      ...(normalized.sentence_ending_patterns || []),
    ]),
    addressing_patterns: normalizeStringArray([
      ...(current.addressing_patterns || []),
      ...(normalized.addressing_patterns || []),
    ]),
    title_forms: normalizeStringArray([...(current.title_forms || []), ...(normalized.title_forms || [])]),
    example_lines: mergeExampleLists(current.example_lines, normalized.example_lines, chapterId, 8),
  };
}

function mergeOneCharacter(current, normalized, entry, sourceType, chapterId) {
  const evidence = mergeEvidence(current.evidence, buildIncomingEvidence(entry, sourceType, chapterId));
  const mergedName = mergeCharacterName(current, normalized);
  const source = current.source === "manual" || current.source === "reference" ? current.source : normalized.source;
  const locked = current.locked === true || normalized.locked === true;
  const fields = mergedCharacterArrayFields(current, normalized, mergedName, chapterId);
  return normalizeCharacterKnowledgeEntry({
    ...current,
    ...fields,
    confidence: Math.max(current.confidence || 0, normalized.confidence || 0),
    first_seen_chapter: current.first_seen_chapter || normalized.first_seen_chapter || chapterId || null,
    source,
    locked,
    evidence,
    status: deriveEntryStatus({ locked, source, evidence }),
  });
}

function mergeCharacterEntries(existingEntries, incomingEntries, options = {}) {
  const sourceType = options.sourceType || "self";
  const chapterId = options.chapterId || null;
  const merged = (existingEntries || []).map(normalizeCharacterKnowledgeEntry);

  for (const entry of incomingEntries || []) {
    const normalized = normalizeCharacterKnowledgeEntry({
      ...entry,
      evidence: buildIncomingEvidence(entry, sourceType, chapterId),
    });
    const currentIndex = findCharacterIndex(merged, characterIdentityValues(normalized));
    if (currentIndex < 0) {
      merged.push(normalized);
      continue;
    }
    merged[currentIndex] = mergeOneCharacter(merged[currentIndex], normalized, entry, sourceType, chapterId);
  }

  return merged;
}

function buildSpeechIncomingEvidence(evidence, chapterId) {
  return buildIncomingEvidence(
    {
      confidence: evidence.confidence,
      example_lines: evidence.example_lines || [],
    },
    "self",
    chapterId,
  );
}

function mergeSpeechCharacter(current, evidence, chapterId, mergedEvidence) {
  return normalizeCharacterKnowledgeEntry({
    ...current,
    name: evidence.name,
    speech_style: normalizeStringArray([...(current.speech_style || []), ...(evidence.speech_style || [])]),
    sentence_ending_patterns: normalizeStringArray([
      ...(current.sentence_ending_patterns || []),
      ...(evidence.sentence_ending_patterns || []),
    ]),
    addressing_patterns: normalizeStringArray([
      ...(current.addressing_patterns || []),
      ...(evidence.addressing_patterns || []),
    ]),
    example_lines: mergeExampleLists(current.example_lines, evidence.example_lines || [], chapterId, 8),
    notes: normalizeStringArray([...(current.notes || []), ...(Array.isArray(evidence.notes) ? evidence.notes : [])]),
    confidence: Math.max(current.confidence || 0, Number(evidence.confidence) || 0),
    first_seen_chapter: current.first_seen_chapter || chapterId || null,
    evidence: mergedEvidence,
    status: deriveEntryStatus({
      locked: current.locked === true,
      source: current.source,
      evidence: mergedEvidence,
    }),
  });
}

function defaultSpeechCharacter(evidence, chapterId) {
  return normalizeCharacterKnowledgeEntry({
    name: evidence.name,
    aliases: [],
    title_forms: [],
    speech_style: [],
    sentence_ending_patterns: [],
    addressing_patterns: [],
    first_seen_chapter: chapterId || null,
    example_lines: [],
    notes: [],
    source: "self",
    locked: false,
    status: "draft",
    confidence: Number.isFinite(evidence.confidence) ? evidence.confidence : 0.45,
  });
}

function mergeCharacterSpeechEvidence(existingEntries, evidenceEntries, chapterId = null) {
  const merged = new Map();

  for (const entry of existingEntries || []) {
    const normalized = normalizeCharacterKnowledgeEntry(entry);
    merged.set(normalized.name, normalized);
  }

  for (const evidence of evidenceEntries || []) {
    if (!evidence || typeof evidence !== "object" || !evidence.name) {
      continue;
    }

    const current = merged.get(evidence.name) || defaultSpeechCharacter(evidence, chapterId);
    const incomingEvidence = buildSpeechIncomingEvidence(evidence, chapterId);
    const mergedEvidence = mergeEvidence(current.evidence, incomingEvidence);
    merged.set(evidence.name, mergeSpeechCharacter(current, evidence, chapterId, mergedEvidence));
  }

  return [...merged.values()];
}

function mergeRunTranslationPair(mergedPairs, pairIndex, pair) {
  const key = pairKey(pair);
  if (!pairIndex.has(key)) {
    pair.occurrences = [
      {
        chapterId: pair.chapterId,
        pageName: pair.pageName,
        nodeId: pair.nodeId,
      },
    ];
    pair.chapterIds = [pair.chapterId].filter(Boolean);
    pair.mentionCount = 1;
    mergedPairs.push(pair);
    pairIndex.set(key, mergedPairs.length - 1);
    return 1;
  }
  const index = pairIndex.get(key);
  const current = mergedPairs[index];
  const uniqueOccurrences = mergePairOccurrences(current, pair);
  const chapterIds = [...new Set(uniqueOccurrences.map((entry) => entry.chapterId).filter(Boolean))];
  mergedPairs[index] = buildMergedPair(current, pair, uniqueOccurrences, chapterIds);
  return 0;
}

function mergePairOccurrences(current, pair) {
  const occurrences = [
    ...(current.occurrences || []),
    { chapterId: pair.chapterId, pageName: pair.pageName, nodeId: pair.nodeId },
  ];
  return [
    ...new Map(
      occurrences.map((entry) => [[entry.chapterId, entry.pageName, entry.nodeId].join("::"), entry]),
    ).values(),
  ];
}

function mergeRunTranslationPairs(existingPairs, translationPairs) {
  const mergedPairs = [...existingPairs];
  const pairIndex = new Map(mergedPairs.map((pair, index) => [pairKey(pair), index]));
  let addedPairs = 0;
  for (const pair of translationPairs) {
    addedPairs += mergeRunTranslationPair(mergedPairs, pairIndex, pair);
  }
  return { mergedPairs, addedPairs };
}

function updateRunKnowledgeMetadata(existing, resolvedPaths, projectName, chapterId, now) {
  existing.metadata.schema_version = SCHEMA_VERSION;
  existing.metadata.manga_id = resolvedPaths.mangaId || existing.metadata.manga_id || null;
  existing.metadata.project_name = existing.metadata.project_name || projectName;
  existing.metadata.updated_at = now;
  existing.metadata.last_enriched_at = now;
  existing.metadata.enrichment_mode = "ao";
  existing.metadata.chapter_projects = {
    ...(existing.metadata.chapter_projects || {}),
    ...(chapterId ? { [chapterId]: projectName } : {}),
  };
  existing.metadata.source_projects = normalizeStringArray([
    ...Object.values(existing.metadata.chapter_projects),
    projectName,
  ]);
  if (projectName) {
    existing.metadata.project_name = projectName;
  }
  if (chapterId && !existing.metadata.chapter_ids.includes(chapterId)) {
    existing.metadata.chapter_ids.push(chapterId);
  }
}

function capturePriorKnowledgeState(existing) {
  const terminology = new Map(
    existing.terminology.map((entry) => [
      `${entry.category || ""}\u0000${entry.term || ""}`,
      {
        confidence: Number(entry.confidence) || 0,
        chapters: new Set(entry.evidence?.chapter_ids || []),
      },
    ]),
  );
  const characters = new Map(
    existing.characters.map((entry) => [
      entry.identity_key || entry.name,
      {
        confidence: Number(entry.confidence) || 0,
        chapters: new Set(entry.evidence?.chapter_ids || []),
      },
    ]),
  );
  const styleKeys = new Set(
    existing.style_examples.map((entry) =>
      [entry.chapterId || "", entry.nodeId || "", entry.translation || ""].join("::"),
    ),
  );
  return { terminology, characters, styleKeys };
}

function applyRunTerminologyAndCharacters(existing, enrichment, chapterId) {
  existing.terminology = mergeTerminologyEntries(existing.terminology, enrichment.terminologyEntries, {
    sourceType: "self",
    chapterId,
  });
  existing.characters = mergeCharacterEntries(existing.characters, enrichment.characterEntries, {
    sourceType: "self",
    chapterId,
  });
  existing.characters = mergeCharacterSpeechEvidence(
    existing.characters,
    enrichment.characterSpeechEvidence,
    chapterId,
  );
}

function applyRunStyle(existing, enrichment, learningEvidence, chapterId) {
  existing.style_examples = mergeStyleExampleEntries(
    existing.style_examples,
    [
      ...styleExamplesFromLearningEvidence(learningEvidence.evidence, chapterId),
      ...(enrichment.styleExampleEntries || []),
    ],
    chapterId,
    16,
  );
  if (Array.isArray(enrichment.narrationEvidence) && enrichment.narrationEvidence.length > 0) {
    existing.style_profile = mergeNarrationEvidence(existing.style_profile, enrichment.narrationEvidence, chapterId);
  }
  if (enrichment.styleProfile) {
    existing.style_profile = mergeStyleProfile(existing.style_profile, enrichment.styleProfile, null);
  }
}

function applyRunEnrichment(existing, enrichment, learningEvidence, chapterId) {
  applyRunTerminologyAndCharacters(existing, enrichment, chapterId);
  applyRunStyle(existing, enrichment, learningEvidence, chapterId);
}

function summarizeEntryChanges(entries, previousByKey, keyOf) {
  return entries.reduce(
    (summary, entry) => {
      const previous = previousByKey.get(keyOf(entry));
      if (!previous) {
        summary.added += 1;
        return summary;
      }
      if ((Number(entry.confidence) || 0) > previous.confidence) summary.confidenceRaised += 1;
      if ((entry.evidence?.chapter_ids || []).some((entryChapterId) => !previous.chapters.has(entryChapterId))) {
        summary.coverageExpanded += 1;
      }
      return summary;
    },
    { added: 0, confidenceRaised: 0, coverageExpanded: 0 },
  );
}

function styleExamplesAddedCount(existing, priorStyleKeys) {
  return existing.style_examples.filter(
    (entry) => !priorStyleKeys.has([entry.chapterId || "", entry.nodeId || "", entry.translation || ""].join("::")),
  ).length;
}

function knowledgeConfidenceUpdates(terminologyChanges, characterChanges) {
  return [terminologyChanges, characterChanges].reduce(
    (sum, changes) => sum + changes.added + changes.confidenceRaised + changes.coverageExpanded,
    0,
  );
}

function summarizeRunKnowledgeChanges(existing, priorTerminologyState, priorCharacterState, priorStyleKeys) {
  const terminologyChanges = summarizeEntryChanges(
    existing.terminology,
    priorTerminologyState,
    (entry) => `${entry.category || ""}\u0000${entry.term || ""}`,
  );
  const characterChanges = summarizeEntryChanges(
    existing.characters,
    priorCharacterState,
    (entry) => entry.identity_key || entry.name,
  );
  const styleExamplesAdded = styleExamplesAddedCount(existing, priorStyleKeys);
  const knowledgeChanges = {
    terminology: terminologyChanges,
    characters: characterChanges,
    styleExamplesAdded,
  };
  const confidenceUpdates = knowledgeConfidenceUpdates(terminologyChanges, characterChanges);
  return {
    terminologyChanges,
    characterChanges,
    styleExamplesAdded,
    knowledgeChanges,
    confidenceUpdates,
  };
}

function writeRunJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function buildRunKnowledgeReport(input) {
  return {
      timestamp: input.now,
      schemaVersion: SCHEMA_VERSION,
      enrichmentMode: "ao",
      mangaId: input.resolvedPaths.mangaId || null,
      chapterId: input.chapterId || null,
      totalPairs: input.existing.translation_pairs.length,
      addedPairs: input.addedPairs,
      terminologyCount: input.existing.terminology.length,
      characterCount: input.existing.characters.length,
      notes: input.enrichment.notes || null,
      learningEvidenceCount: input.learningEvidence.evidence.length,
      confidenceUpdates: input.confidenceUpdates,
      knowledgeChanges: input.knowledgeChanges,
  };
}

function writeRunKnowledgeFiles(input) {
  writeRunJsonAtomic(input.resolvedPaths.knowledgeBasePath, input.existing);
  writeRunJsonAtomic(input.resolvedPaths.reportPath, buildRunKnowledgeReport(input));
}

function upsertRunKnowledgeIndexEntry(resolvedPaths, mangaLabel, translatorLabel, chapterId, chapterTitle) {
  if (!resolvedPaths.mangaId) {
    return null;
  }
  return upsertKnowledgeIndexEntry({
    mangaId: resolvedPaths.mangaId,
    translatorId: resolvedPaths.translatorId || null,
    label: mangaLabel,
    translatorLabel,
    knowledgeBasePath: resolvedPaths.knowledgeBasePath,
    reportPath: resolvedPaths.reportPath,
    chapterId,
    chapterTitle,
  });
}

function buildRunResult(input) {
  const { existing, resolvedPaths, chapterId, learningEvidence, enrichment } = input;
  return {
    enrichmentMode: "ao",
    translationPairs: existing.translation_pairs.length,
    characters: existing.characters.length,
    terminology: existing.terminology.length,
    styleExamples: existing.style_examples.length,
    mangaId: resolvedPaths.mangaId,
    translatorId: resolvedPaths.translatorId || null,
    chapterId,
    knowledgeIndexEntry: input.knowledgeIndexEntry,
    output: resolvedPaths.knowledgeBasePath,
    report: resolvedPaths.reportPath,
    learningEvidenceSnapshotPath: input.learningEvidenceSnapshotPath,
    learningEvidenceCount: learningEvidence.evidence.length,
    confidenceUpdates: input.confidenceUpdates,
    knowledgeChanges: input.knowledgeChanges,
    publicationRevisionId: input.publicationRevisionId,
    outcome: enrichment.semanticResult?.outcome || "clean",
    semanticResult: enrichment.semanticResult || null,
  };
}

function skippedKnowledgeEnrichment() {
  return {
    terminologyEntries: [],
    characterEntries: [],
    characterSpeechEvidence: [],
    styleExampleEntries: [],
    narrationEvidence: [],
    styleProfile: null,
    notes: "No selected learning evidence; AO enrichment was skipped.",
  };
}

function buildPreviewNoOpReport(resolvedPaths, chapterId, enrichment, learningEvidence) {
  return {
    timestamp: now,
    schemaVersion: SCHEMA_VERSION,
    enrichmentMode: "ao",
    mangaId: resolvedPaths.mangaId || null,
    chapterId: chapterId || null,
    outcome: "partial",
    noOp: true,
    notes: "AO completed without valid Knowledge evidence; existing Knowledge was preserved.",
    semanticResult: enrichment.semanticResult,
    learningEvidenceCount: learningEvidence.evidence.length,
    confidenceUpdates: 0,
    knowledgeChanges: {
      terminology: { added: 0, confidenceRaised: 0, coverageExpanded: 0 },
      characters: { added: 0, confidenceRaised: 0, coverageExpanded: 0 },
      styleExamplesAdded: 0,
    },
  };
}

function buildPreviewNoOpReturn(resolvedPaths, chapterId, existing, learningEvidence, enrichment, noOpReport) {
  return {
    enrichmentMode: "ao",
    outcome: "partial",
    semanticResult: enrichment.semanticResult,
    translationPairs: existing.translation_pairs.length,
    characters: existing.characters.length,
    terminology: existing.terminology.length,
    styleExamples: existing.style_examples.length,
    mangaId: resolvedPaths.mangaId,
    translatorId: resolvedPaths.translatorId || null,
    chapterId,
    knowledgeIndexEntry: null,
    output: fs.existsSync(resolvedPaths.knowledgeBasePath) ? resolvedPaths.knowledgeBasePath : null,
    report: resolvedPaths.reportPath,
    learningEvidenceSnapshotPath,
    learningEvidenceCount: learningEvidence.evidence.length,
    confidenceUpdates: 0,
    knowledgeChanges: noOpReport.knowledgeChanges,
    publicationRevisionId,
  };
}

function buildMergedPair(current, pair, uniqueOccurrences, chapterIds) {
  return {
    ...current,
    occurrences: uniqueOccurrences,
    mentionCount: uniqueOccurrences.length,
    chapterIds,
    chapterId: chapterIds.length === 1 ? chapterIds[0] : null,
    pageName: uniqueOccurrences.length === 1 ? uniqueOccurrences[0].pageName : null,
    nodeId: uniqueOccurrences.length === 1 ? uniqueOccurrences[0].nodeId : null,
    confidence: Math.min(
      0.99,
      Math.max(current.confidence || 0, pair.confidence || 0) + Math.max(0, chapterIds.length - 1) * 0.02,
    ),
    updatedAt: pair.updatedAt,
  };
}

function applyAndWriteRunKnowledge(existing, context, enrichment) {
  applyRunEnrichment(existing, enrichment, context.learningEvidence, context.chapterId);
  const summaryResult = summarizeRunKnowledgeChanges(
    existing,
    context.priorTerminologyState,
    context.priorCharacterState,
    context.priorStyleKeys,
  );
  writeRunKnowledgeFiles({
    existing,
    resolvedPaths: context.resolvedPaths,
    now: context.now,
    addedPairs: context.addedPairs,
    learningEvidence: context.learningEvidence,
    enrichment,
    knowledgeChanges: summaryResult.knowledgeChanges,
    confidenceUpdates: summaryResult.confidenceUpdates,
    chapterId: context.chapterId,
  });
  return summaryResult;
}

function normalizeKnowledgeRunOptions(options) {
  return {
    mangaId: null,
    translatorId: null,
    mangaLabel: null,
    translatorLabel: null,
    chapterId: null,
    chapterTitle: null,
    jobId: null,
    knowledgeBasePath: null,
    reportPath: null,
    learningEvidenceSnapshotPath: null,
    publicationRevisionId: null,
    ...(options || {}),
  };
}

class KnowledgeModule {
  constructor(client, aoTaskRunner) {
    this.client = client;
    this.aoTaskRunner = aoTaskRunner;
  }

  async preview({
    mangaId = null,
    translatorId = null,
    chapterId = null,
    jobId = null,
    translations = [],
    learningEvidence = null,
  }) {
    const context = this.preparePreviewContext({
      mangaId,
      translatorId,
      chapterId,
      jobId,
      translations,
      learningEvidence,
    });
    const enrichment = await this.runPreviewEnrichment(context);
    if (enrichment.semanticResult?.outcome === "partial" && enrichment.semanticResult.acceptedRecordCount === 0) {
      return this.previewNoOpResult(context, enrichment);
    }
    return this.previewProjectedResult(context, enrichment);
  }

  preparePreviewContext({ mangaId, translatorId, chapterId, jobId, translations, learningEvidence }) {
    const resolvedPaths = resolveKnowledgePaths({ mangaId, translatorId });
    const existing = normalizeExistingKnowledgeBase(
      fs.existsSync(resolvedPaths.knowledgeBasePath)
        ? JSON.parse(fs.readFileSync(resolvedPaths.knowledgeBasePath, "utf8"))
        : null,
      "translation_preview",
    );
    const evidenceRows = learningEvidence?.evidence || translations;
    const translationPairs = translationPairsFromList(evidenceRows, chapterId);
    return {
      mangaId,
      translatorId,
      chapterId,
      jobId,
      translations,
      learningEvidence,
      resolvedPaths,
      existing,
      evidenceRows,
      translationPairs,
    };
  }

  async runPreviewEnrichment(context) {
    if (context.translationPairs.length === 0) {
      return skippedKnowledgeEnrichment();
    }
    return this.aoTaskRunner.runKnowledgeEnrichment({
      jobId: context.jobId,
      mangaId: context.mangaId,
      translatorId: context.translatorId,
      chapterId: context.chapterId,
      translationPairs: context.translationPairs,
      learningEvidence: context.evidenceRows,
      knowledgeBase: {
        terminology: context.existing.terminology,
        characters: context.existing.characters.filter((entry) =>
          context.evidenceRows.some((evidence) => evidence.speakerRef === entry.name),
        ),
        style_profile: context.existing.style_profile,
      },
      styleEvidence: null,
      chapterStyleEvidence: null,
      existingStyleProfile: context.existing.style_profile,
      existingStyleExamples: context.existing.style_examples
        .filter((entry) =>
          context.evidenceRows.some((evidence) => !evidence.textRole || evidence.textRole === entry.type),
        )
        .slice(-6),
    });
  }

  previewNoOpResult(context, enrichment) {
    const { resolvedPaths, chapterId, existing, learningEvidence } = context;
    const noOpReport = buildPreviewNoOpReport(resolvedPaths, chapterId, enrichment, learningEvidence);
    const reportTempPath = `${resolvedPaths.reportPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(reportTempPath, JSON.stringify(noOpReport, null, 2), "utf8");
    fs.renameSync(reportTempPath, resolvedPaths.reportPath);
    return buildPreviewNoOpReturn(resolvedPaths, chapterId, existing, learningEvidence, enrichment, noOpReport);
  }

  previewProjectedResult(context, enrichment) {
    const { existing, evidenceRows, chapterId } = context;
    const projectedTerminology = mergeTerminologyEntries(existing.terminology, enrichment.terminologyEntries, {
      sourceType: "self",
      chapterId,
    });
    const projectedCharacters = mergeCharacterEntries(existing.characters, enrichment.characterEntries, {
      sourceType: "self",
      chapterId,
    });
    return {
      persisted: false,
      translationPairs: context.translationPairs.length,
      delta: enrichment,
      projected: {
        terminology: projectedTerminology.length,
        characters: projectedCharacters.length,
        styleExamples: mergeStyleExampleEntries(
          existing.style_examples,
          [...styleExamplesFromLearningEvidence(evidenceRows, chapterId), ...(enrichment.styleExampleEntries || [])],
          chapterId,
          16,
        ).length,
      },
    };
  }

  buildRunEnrichmentKnowledgeBase(input) {
    const { existing, translationPairs, learningEvidence } = input;
    return {
      terminology: existing.terminology.filter(
        (entry) => Boolean(entry.term) && translationPairs.some((pair) => pair.original.includes(entry.term)),
      ),
      characters: existing.characters.filter((entry) =>
        learningEvidence.evidence.some((evidence) => evidence.speakerRef === entry.name),
      ),
      style_profile: existing.style_profile,
    };
  }

  async runKnowledgeEnrichmentForRun(input) {
    const { jobId, resolvedPaths, chapterId, translationPairs, learningEvidence, existing } = input;
    if (translationPairs.length === 0) return skippedKnowledgeEnrichment();
    return this.aoTaskRunner.runKnowledgeEnrichment({
      jobId,
      mangaId: resolvedPaths.mangaId || null,
      translatorId: resolvedPaths.translatorId || null,
      chapterId,
      translationPairs,
      learningEvidence: learningEvidence.evidence,
      knowledgeBase: this.buildRunEnrichmentKnowledgeBase(input),
      styleEvidence: null,
      chapterStyleEvidence: null,
      existingStyleProfile: existing.style_profile,
      existingStyleExamples: existing.style_examples
        .filter((entry) =>
          learningEvidence.evidence.some((evidence) => !evidence.textRole || evidence.textRole === entry.type),
        )
        .slice(-6),
    });
  }

  async run(options = {}) {
    const context = this.prepareRunContext(options);
    const enrichment = await this.runKnowledgeEnrichmentForRun({
      jobId: context.jobId,
      resolvedPaths: context.resolvedPaths,
      chapterId: context.chapterId,
      translationPairs: context.translationPairs,
      learningEvidence: context.learningEvidence,
      existing: context.existing,
    });
    return this.finalizeRun(context, enrichment);
  }

  resolveRunPaths({ mangaId, translatorId, knowledgeBasePath, reportPath }) {
    if (knowledgeBasePath && reportPath) {
      return {
        mangaId,
        translatorId,
        knowledgeBasePath,
        reportPath,
        mode: "override",
      };
    }
    return resolveKnowledgePaths({ mangaId, translatorId });
  }

  loadRunLearningEvidence({ learningEvidenceSnapshotPath, chapterId, publicationRevisionId }) {
    const learningEvidence = validateLearningEvidenceSnapshot(
      JSON.parse(fs.readFileSync(learningEvidenceSnapshotPath, "utf8")),
    );
    const translationPairs = translationPairsFromList(learningEvidence.evidence, chapterId).map((pair) => ({
      ...pair,
      publicationRevisionId,
    }));
    const projectName = `translation_${learningEvidence.sourceTranslationJobId || "unknown"}`;
    const now = new Date().toISOString();
    return { learningEvidence, translationPairs, projectName, now };
  }

  loadRunExistingKnowledge(resolvedPaths, projectName) {
    ensureDirectory(resolvedPaths.knowledgeBasePath);
    ensureDirectory(resolvedPaths.reportPath);
    return normalizeExistingKnowledgeBase(
      fs.existsSync(resolvedPaths.knowledgeBasePath)
        ? JSON.parse(fs.readFileSync(resolvedPaths.knowledgeBasePath, "utf-8"))
        : null,
      projectName,
    );
  }

  buildRunContext(input) {
    const { priorState, ...rest } = input;
    return {
      ...rest,
      priorTerminologyState: priorState.terminology,
      priorCharacterState: priorState.characters,
      priorStyleKeys: priorState.styleKeys,
    };
  }

  prepareExistingRunState(resolvedPaths, loaded, chapterId) {
    const existing = this.loadRunExistingKnowledge(resolvedPaths, loaded.projectName);
    removeChapterLearningEvidence(existing, chapterId);
    const pairResult = mergeRunTranslationPairs(existing.translation_pairs || [], loaded.translationPairs);
    existing.translation_pairs = assignPairIds(pairResult.mergedPairs);
    updateRunKnowledgeMetadata(existing, resolvedPaths, loaded.projectName, chapterId, loaded.now);
    return {
      existing,
      addedPairs: pairResult.addedPairs,
      priorState: capturePriorKnowledgeState(existing),
    };
  }

  prepareRunContext(options = {}) {
    const input = normalizeKnowledgeRunOptions(options);
    if (!input.learningEvidenceSnapshotPath)
      throw new Error("Knowledge learning requires a Learning Evidence snapshot.");
    const resolvedPaths = this.resolveRunPaths(input);
    const loaded = this.loadRunLearningEvidence(input);
    const prepared = this.prepareExistingRunState(resolvedPaths, loaded, input.chapterId);
    return this.buildRunContext({
      ...input,
      resolvedPaths,
      ...loaded,
      ...prepared,
    });
  }

  finalizeRun(context, enrichment) {
    const existing = context.existing;
    const summaryResult = applyAndWriteRunKnowledge(existing, context, enrichment);
    const knowledgeIndexEntry = upsertRunKnowledgeIndexEntry(
      context.resolvedPaths,
      context.mangaLabel,
      context.translatorLabel,
      context.chapterId,
      context.chapterTitle,
    );
    updateTodoList(paths.todoList);
    return buildRunResult({
      existing,
      resolvedPaths: context.resolvedPaths,
      chapterId: context.chapterId,
      knowledgeIndexEntry,
      learningEvidenceSnapshotPath: context.learningEvidenceSnapshotPath,
      learningEvidence: context.learningEvidence,
      confidenceUpdates: summaryResult.confidenceUpdates,
      knowledgeChanges: summaryResult.knowledgeChanges,
      publicationRevisionId: context.publicationRevisionId,
      enrichment,
    });
  }
}

module.exports = {
  KnowledgeModule,
  assignPairIds,
  defaultKnowledgeBase,
  extractTranslationPairs,
  translationPairsFromList,
  mergeCharacterSpeechEvidence,
  mergeNarrationEvidence,
  mergeStyleExampleEntries,
  styleExamplesFromLearningEvidence,
  mergeStyleProfile,
  mergeCharacterEntries,
  mergeTerminologyEntries,
  normalizeExistingKnowledgeBase,
  normalizeStyleExampleEntry,
  normalizeStyleProfile,
  pairKey,
  deleteChapterLearningData,
  removeChapterLearningEvidence,
};
