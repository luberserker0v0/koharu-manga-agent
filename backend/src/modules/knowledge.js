const fs = require("fs");
const path = require("path");
const { paths } = require("../config");
const { validateLearningEvidenceSnapshot } = require("./learning_evidence");
const {
  resolveKnowledgePaths,
  upsertKnowledgeIndexEntry,
} = require("./knowledge_paths");

const SCHEMA_VERSION = "2.0";

function ensureDirectory(targetFile) {
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
}

function upsertTodoList(todoPath) {
  if (!fs.existsSync(todoPath)) {
    fs.writeFileSync(
      todoPath,
      "# Knowledge Base Tasks\n\n## Pending\n\n## Completed\n\n## Reflection\n"
    );
  }
}

function updateTodoList(todoPath) {
  upsertTodoList(todoPath);
  const content = fs.readFileSync(todoPath, "utf-8");
  const date = new Date().toISOString().split("T")[0];
  let next = content;

  if (!next.includes("- [x] Update knowledge base")) {
    next = next.replace(
      "## Completed\n",
      `## Completed\n- [x] Update knowledge base (${date})\n`
    );
  }

  if (!next.includes("- [ ] Review translation consistency after the update")) {
    next = next.replace(
      "## Reflection\n",
      "## Reflection\n- [ ] Review translation consistency after the update\n"
    );
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
  return (Array.isArray(translations) ? translations : []).filter((entry) =>
    entry && typeof entry.original === "string" && entry.original &&
    typeof entry.translation === "string" && entry.translation
  ).map((entry, index) => ({
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

function defaultKnowledgeBase(projectName = "unknown") {
  const now = new Date().toISOString();
  return {
    metadata: {
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
    },
    translation_pairs: [],
    terminology: [],
    characters: [],
    style_profile: {
      tone: null,
      register: null,
      honorific_policy: [],
      punctuation_policy: [],
      preferred_patterns: [],
      forbidden_patterns: [],
      narration: {
        tone: null,
        register: null,
        preferred_patterns: [],
        forbidden_patterns: [],
        notes: [],
      },
      notes: [],
    },
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

function normalizeStyleProfile(styleProfile) {
  const base = defaultKnowledgeBase().style_profile;
  if (!styleProfile || typeof styleProfile !== "object" || Array.isArray(styleProfile)) {
    return base;
  }

  return {
    tone: styleProfile.tone ?? null,
    register: styleProfile.register ?? null,
    honorific_policy: Array.isArray(styleProfile.honorific_policy)
      ? styleProfile.honorific_policy
      : [],
    punctuation_policy: Array.isArray(styleProfile.punctuation_policy)
      ? styleProfile.punctuation_policy
      : [],
    preferred_patterns: Array.isArray(styleProfile.preferred_patterns)
      ? styleProfile.preferred_patterns
      : [],
    forbidden_patterns: Array.isArray(styleProfile.forbidden_patterns)
      ? styleProfile.forbidden_patterns
      : [],
    narration:
      styleProfile.narration && typeof styleProfile.narration === "object" && !Array.isArray(styleProfile.narration)
        ? {
            tone: styleProfile.narration.tone ?? null,
            register: styleProfile.narration.register ?? null,
            preferred_patterns: Array.isArray(styleProfile.narration.preferred_patterns)
              ? styleProfile.narration.preferred_patterns
              : [],
            forbidden_patterns: Array.isArray(styleProfile.narration.forbidden_patterns)
              ? styleProfile.narration.forbidden_patterns
              : [],
            notes: Array.isArray(styleProfile.narration.notes) ? styleProfile.narration.notes : [],
          }
        : base.narration,
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
    type: entry.type === "narration" ? "narration" : "dialogue",
    pageName: entry.pageName || null,
    nodeId: entry.nodeId || null,
    chapterId: entry.chapterId || fallbackChapterId || null,
    translation,
    reason: entry.reason || null,
  };
}

function mergeStyleExampleEntries(existingEntries, incomingEntries, fallbackChapterId = null, limit = 16) {
  const seen = new Set();
  const merged = [];

  for (const rawEntry of [...(existingEntries || []), ...(incomingEntries || [])]) {
    const entry = normalizeStyleExampleEntry(rawEntry, fallbackChapterId);
    if (!entry) {
      continue;
    }
    const key = [
      entry.type || "",
      entry.chapterId || "",
      entry.pageName || "",
      entry.nodeId || "",
      entry.translation,
    ].join("::");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(entry);
  }

  return merged.slice(-limit);
}

function mergeStyleProfile(existingProfile, incomingProfile, styleEvidence = null) {
  const current = normalizeStyleProfile(existingProfile);
  const incoming = normalizeStyleProfile(incomingProfile);
  const evidenceMetadata =
    styleEvidence && typeof styleEvidence === "object" && styleEvidence.metadata && typeof styleEvidence.metadata === "object"
      ? styleEvidence.metadata
      : null;
  const chapterCoverage = Array.isArray(evidenceMetadata?.source_chapters)
    ? evidenceMetadata.source_chapters.length
    : 0;
  const referenceKindSupport = {};

  if (styleEvidence && typeof styleEvidence === "object" && styleEvidence.chapters && typeof styleEvidence.chapters === "object") {
    for (const chapter of Object.values(styleEvidence.chapters)) {
      if (!chapter || typeof chapter !== "object") {
        continue;
      }
      const kind = chapter.referenceKind || "unknown";
      referenceKindSupport[kind] = (referenceKindSupport[kind] || 0) + 1;
    }
  }

  return normalizeStyleProfile({
    ...current,
    ...incoming,
    tone: incoming.tone || current.tone || null,
    register: incoming.register || current.register || null,
    honorific_policy: normalizeStringArray([
      ...(current.honorific_policy || []),
      ...(incoming.honorific_policy || []),
    ]),
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
    narration: {
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
      notes: normalizeStringArray([
        ...(current.narration?.notes || []),
        ...(incoming.narration?.notes || []),
      ]),
    },
    notes: normalizeStringArray([
      ...(current.notes || []),
      ...(incoming.notes || []),
      chapterCoverage > 0 ? `chapter_coverage:${chapterCoverage}` : null,
      Object.keys(referenceKindSupport).length > 0
        ? `reference_kind_support:${JSON.stringify(referenceKindSupport)}`
        : null,
    ]),
  });
}

function mergeNarrationEvidence(existingProfile, narrationEvidenceEntries, chapterId = null) {
  const current = normalizeStyleProfile(existingProfile);
  let tone = current.narration?.tone || null;
  let register = current.narration?.register || null;
  const preferredPatterns = [...(current.narration?.preferred_patterns || [])];
  const forbiddenPatterns = [...(current.narration?.forbidden_patterns || [])];
  const notes = [...(current.narration?.notes || [])];

  for (const entry of narrationEvidenceEntries || []) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (!tone && entry.tone) {
      tone = entry.tone;
    }
    if (!register && entry.register) {
      register = entry.register;
    }
    preferredPatterns.push(...(Array.isArray(entry.preferred_patterns) ? entry.preferred_patterns : []));
    forbiddenPatterns.push(...(Array.isArray(entry.forbidden_patterns) ? entry.forbidden_patterns : []));
    notes.push(...(Array.isArray(entry.notes) ? entry.notes : []));
    if (chapterId) {
      notes.push(`narration_evidence_chapter:${chapterId}`);
    }
  }

  return normalizeStyleProfile({
    ...current,
    narration: {
      tone,
      register,
      preferred_patterns: normalizeStringArray(preferredPatterns),
      forbidden_patterns: normalizeStringArray(forbiddenPatterns),
      notes: normalizeStringArray(notes),
    },
  });
}

function normalizeExampleList(examples, fallbackChapterId = null) {
  const seen = new Set();
  const output = [];

  for (const example of Array.isArray(examples) ? examples : []) {
    if (!example || typeof example !== "object") {
      continue;
    }
    const normalized = {
      pageName: example.pageName || null,
      nodeId: example.nodeId || null,
      original: example.original || null,
      translation: example.translation || null,
      chapterId: example.chapterId || fallbackChapterId || null,
    };
    if (!normalized.translation) {
      continue;
    }
    const key = [
      normalized.pageName || "",
      normalized.nodeId || "",
      normalized.chapterId || "",
      normalized.translation,
    ].join("::");
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
    [...normalizeExampleList(existingExamples, fallbackChapterId), ...normalizeExampleList(incomingExamples, fallbackChapterId)],
    fallbackChapterId
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

function normalizeEvidence(evidence) {
  const base = emptyEvidence();
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return base;
  }

  return {
    mention_count:
      typeof evidence.mention_count === "number" && Number.isFinite(evidence.mention_count)
        ? evidence.mention_count
        : base.mention_count,
    chapter_ids: normalizeStringArray(evidence.chapter_ids),
    source_counts: {
      self:
        typeof evidence.source_counts?.self === "number" && Number.isFinite(evidence.source_counts.self)
          ? evidence.source_counts.self
          : 0,
      reference:
        typeof evidence.source_counts?.reference === "number" &&
        Number.isFinite(evidence.source_counts.reference)
          ? evidence.source_counts.reference
          : 0,
    },
    high_confidence_hits:
      typeof evidence.high_confidence_hits === "number" &&
      Number.isFinite(evidence.high_confidence_hits)
        ? evidence.high_confidence_hits
        : 0,
    medium_confidence_hits:
      typeof evidence.medium_confidence_hits === "number" &&
      Number.isFinite(evidence.medium_confidence_hits)
        ? evidence.medium_confidence_hits
        : 0,
    score:
      typeof evidence.score === "number" && Number.isFinite(evidence.score)
        ? evidence.score
        : 0,
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
  return Number((mentionCount + chapterCount * 2 + referenceWeight + selfWeight + highWeight + mediumWeight).toFixed(2));
}

function deriveConfidenceFromEvidence(score, explicitConfidence = null) {
  const baseline = 0.45 + Math.min(score, 12) * 0.04;
  const candidate = explicitConfidence && Number.isFinite(explicitConfidence)
    ? Math.max(baseline, explicitConfidence)
    : baseline;
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
  const chapters = new Set(
    [chapterId, ...examples.map((example) => example.chapterId)].filter(Boolean)
  );
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
    (chapterId) => !(current.chapter_ids || []).includes(chapterId)
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
  normalized.confidence = deriveConfidenceFromEvidence(
    normalized.evidence.score,
    normalized.confidence
  );
  return normalized;
}

function normalizeCharacterKnowledgeEntry(entry) {
  const normalized = {
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
  normalized.confidence = deriveConfidenceFromEvidence(
    normalized.evidence.score,
    normalized.confidence
  );
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

function removeChapterLearningEvidence(knowledge, chapterId) {
  if (!chapterId) return knowledge;
  knowledge.translation_pairs = (knowledge.translation_pairs || []).map((pair) => {
    const occurrences = (pair.occurrences || [{ chapterId: pair.chapterId, pageName: pair.pageName, nodeId: pair.nodeId }])
      .filter((entry) => entry.chapterId !== chapterId);
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
  }).filter(Boolean);
  knowledge.style_examples = (knowledge.style_examples || []).filter(
    (entry) => entry.chapterId !== chapterId
  );
  knowledge.terminology = (knowledge.terminology || [])
    .map((entry) =>
      entry.locked === true || entry.source === "manual" || entry.source === "reference"
        ? entry
        : removeChapterEvidenceFromEntry(entry, chapterId, "examples")
    )
    .filter((entry) =>
      entry.locked === true ||
      entry.source === "manual" ||
      entry.source === "reference" ||
      (entry.evidence?.chapter_ids || []).length > 0
    )
    .map(normalizeTerminologyKnowledgeEntry);
  knowledge.characters = (knowledge.characters || [])
    .map((entry) =>
      entry.locked === true || entry.source === "manual" || entry.source === "reference"
        ? entry
        : removeChapterEvidenceFromEntry(entry, chapterId, "example_lines")
    )
    .filter((entry) =>
      entry.locked === true ||
      entry.source === "manual" ||
      entry.source === "reference" ||
      (entry.evidence?.chapter_ids || []).length > 0
    )
    .map(normalizeCharacterKnowledgeEntry);
  if (knowledge.style_profile?.narration?.notes) {
    knowledge.style_profile.narration.notes = knowledge.style_profile.narration.notes.filter(
      (note) => note !== `narration_evidence_chapter:${chapterId}`
    );
  }
  return knowledge;
}

function assignPairIds(pairs) {
  return pairs.map((pair, index) => ({
    ...pair,
    id: pair.id || `pair_${String(index + 1).padStart(6, "0")}`,
    occurrences: pair.occurrences || [{ chapterId: pair.chapterId || null, pageName: pair.pageName || null, nodeId: pair.nodeId || null }],
    mentionCount: pair.mentionCount || pair.occurrences?.length || 1,
    chapterIds: pair.chapterIds || [...new Set([pair.chapterId].filter(Boolean))],
  }));
}

function normalizeExistingKnowledgeBase(existing, projectName = "unknown") {
  if (!existing || typeof existing !== "object") {
    return defaultKnowledgeBase(projectName);
  }

  if (existing.metadata) {
    const merged = {
      ...defaultKnowledgeBase(projectName),
      ...existing,
      metadata: {
        ...defaultKnowledgeBase(projectName).metadata,
        ...existing.metadata,
        schema_version: existing.metadata.schema_version || SCHEMA_VERSION,
      },
    };
    merged.translation_pairs = assignPairIds(
      Array.isArray(existing.translation_pairs) ? existing.translation_pairs : []
    );
    merged.metadata.chapter_ids = Array.isArray(merged.metadata.chapter_ids)
      ? merged.metadata.chapter_ids
      : [];
    merged.metadata.source_projects = Array.isArray(merged.metadata.source_projects)
      ? merged.metadata.source_projects
      : [];
    merged.terminology = normalizeInferenceArray(existing.terminology).map(
      normalizeTerminologyKnowledgeEntry
    );
    merged.characters = normalizeInferenceArray(existing.characters).map(
      normalizeCharacterKnowledgeEntry
    );
    merged.style_profile = normalizeStyleProfile(existing.style_profile);
    merged.style_examples = normalizeInferenceArray(existing.style_examples);
    return merged;
  }

  const migrated = defaultKnowledgeBase(existing.project_name || projectName);
  migrated.metadata.project_name = existing.project_name || projectName;
  migrated.metadata.source = existing.source || "self";
  migrated.metadata.created_at = existing.created_at || migrated.metadata.created_at;
  migrated.metadata.updated_at = existing.updated_at || migrated.metadata.updated_at;
  migrated.metadata.last_enriched_at =
    existing.updated_at || migrated.metadata.last_enriched_at;
  migrated.translation_pairs = assignPairIds(
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
      : []
  );
  migrated.terminology = normalizeInferenceArray(existing.terminology).map(
    normalizeTerminologyKnowledgeEntry
  );
  migrated.characters = normalizeInferenceArray(existing.characters).map(
    normalizeCharacterKnowledgeEntry
  );
  migrated.style_profile = normalizeStyleProfile(existing.style_profile);
  migrated.style_examples = normalizeInferenceArray(existing.style_examples);
  return migrated;
}

function mergeTerminologyEntries(existingEntries, incomingEntries, options = {}) {
  const sourceType = options.sourceType || "self";
  const chapterId = options.chapterId || null;
  const merged = new Map();
  for (const entry of existingEntries || []) {
    const normalized = normalizeTerminologyKnowledgeEntry(entry);
    const key = `${normalized.category || ""}::${normalized.translation || normalized.term || ""}`;
    merged.set(key, normalized);
  }

  for (const entry of incomingEntries || []) {
    const normalized = normalizeTerminologyKnowledgeEntry({
      ...entry,
      evidence: buildIncomingEvidence(entry, sourceType, chapterId),
    });
    const key = `${normalized.category || ""}::${normalized.translation || normalized.term || ""}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, normalized);
      continue;
    }
    const evidence = mergeEvidence(current.evidence, buildIncomingEvidence(entry, sourceType, chapterId));
    merged.set(key, normalizeTerminologyKnowledgeEntry({
      ...current,
      term: current.term || normalized.term,
      translation: current.translation || normalized.translation,
      category: current.category || normalized.category,
      notes: current.notes || normalized.notes,
      aliases: normalizeStringArray([
        ...(current.aliases || []),
        ...(normalized.aliases || []),
        normalized.term,
      ]),
      examples: mergeExampleLists(current.examples, normalized.examples, chapterId, 8),
      source:
        current.source === "manual" || current.source === "reference"
          ? current.source
          : normalized.source,
      locked: current.locked === true || normalized.locked === true,
      evidence,
      confidence: Math.max(current.confidence || 0, normalized.confidence || 0),
      status: deriveEntryStatus({
        locked: current.locked === true || normalized.locked === true,
        source:
          current.source === "manual" || current.source === "reference"
            ? current.source
            : normalized.source,
        evidence,
      }),
    }));
  }

  return [...merged.values()];
}

function mergeCharacterEntries(existingEntries, incomingEntries, options = {}) {
  const sourceType = options.sourceType || "self";
  const chapterId = options.chapterId || null;
  const merged = new Map();
  for (const entry of existingEntries || []) {
    const normalized = normalizeCharacterKnowledgeEntry(entry);
    merged.set(normalized.name, normalized);
  }

  for (const entry of incomingEntries || []) {
    const normalized = normalizeCharacterKnowledgeEntry({
      ...entry,
      evidence: buildIncomingEvidence(entry, sourceType, chapterId),
    });
    const current = merged.get(normalized.name);
    if (!current) {
      merged.set(normalized.name, normalized);
      continue;
    }
    const evidence = mergeEvidence(current.evidence, buildIncomingEvidence(entry, sourceType, chapterId));
      merged.set(normalized.name, normalizeCharacterKnowledgeEntry({
        ...current,
        aliases: normalizeStringArray([...(current.aliases || []), ...(normalized.aliases || [])]),
        speech_style: normalizeStringArray([
          ...(current.speech_style || []),
          ...(normalized.speech_style || []),
        ]),
        sentence_ending_patterns: normalizeStringArray([
          ...(current.sentence_ending_patterns || []),
          ...(normalized.sentence_ending_patterns || []),
        ]),
        addressing_patterns: normalizeStringArray([
          ...(current.addressing_patterns || []),
          ...(normalized.addressing_patterns || []),
        ]),
        title_forms: normalizeStringArray([
          ...(current.title_forms || []),
          ...(normalized.title_forms || []),
        ]),
        example_lines: mergeExampleLists(
        current.example_lines,
        normalized.example_lines,
        chapterId,
        8
      ),
      confidence: Math.max(current.confidence || 0, normalized.confidence || 0),
      first_seen_chapter:
        current.first_seen_chapter || normalized.first_seen_chapter || chapterId || null,
      source:
        current.source === "manual" || current.source === "reference"
          ? current.source
          : normalized.source,
      locked: current.locked === true || normalized.locked === true,
      evidence,
      status: deriveEntryStatus({
        locked: current.locked === true || normalized.locked === true,
        source:
          current.source === "manual" || current.source === "reference"
            ? current.source
            : normalized.source,
        evidence,
      }),
    }));
  }

  return [...merged.values()];
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

    const current = merged.get(evidence.name) || normalizeCharacterKnowledgeEntry({
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
    const incomingEvidence = buildIncomingEvidence(
      {
        confidence: evidence.confidence,
        example_lines: evidence.example_lines || [],
      },
      "self",
      chapterId
    );
    const mergedEvidence = mergeEvidence(current.evidence, incomingEvidence);

    merged.set(
      evidence.name,
      normalizeCharacterKnowledgeEntry({
        ...current,
        name: evidence.name,
        speech_style: normalizeStringArray([
          ...(current.speech_style || []),
          ...(evidence.speech_style || []),
        ]),
        sentence_ending_patterns: normalizeStringArray([
          ...(current.sentence_ending_patterns || []),
          ...(evidence.sentence_ending_patterns || []),
        ]),
        addressing_patterns: normalizeStringArray([
          ...(current.addressing_patterns || []),
          ...(evidence.addressing_patterns || []),
        ]),
        example_lines: mergeExampleLists(
          current.example_lines,
          evidence.example_lines || [],
          chapterId,
          8
        ),
        notes: normalizeStringArray([
          ...(current.notes || []),
          ...(Array.isArray(evidence.notes) ? evidence.notes : []),
        ]),
        confidence: Math.max(current.confidence || 0, Number(evidence.confidence) || 0),
        first_seen_chapter: current.first_seen_chapter || chapterId || null,
        evidence: mergedEvidence,
        status: deriveEntryStatus({
          locked: current.locked === true,
          source: current.source,
          evidence: mergedEvidence,
        }),
      })
    );
  }

  return [...merged.values()];
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
    const resolvedPaths = resolveKnowledgePaths({ mangaId, translatorId });
    const existing = normalizeExistingKnowledgeBase(
      fs.existsSync(resolvedPaths.knowledgeBasePath)
        ? JSON.parse(fs.readFileSync(resolvedPaths.knowledgeBasePath, "utf8"))
        : null,
      "translation_preview"
    );
    const evidenceRows = learningEvidence?.evidence || translations;
    const translationPairs = translationPairsFromList(evidenceRows, chapterId);
    const enrichment = translationPairs.length > 0 ? await this.aoTaskRunner.runKnowledgeEnrichment({
      jobId,
      mangaId,
      translatorId,
      chapterId,
      translationPairs,
      learningEvidence: evidenceRows,
      knowledgeBase: {
        terminology: existing.terminology,
        characters: existing.characters.filter((entry) => evidenceRows.some((evidence) => evidence.speakerRef === entry.name)),
        style_profile: existing.style_profile,
      },
      styleEvidence: null,
      chapterStyleEvidence: null,
      existingStyleProfile: existing.style_profile,
      existingStyleExamples: existing.style_examples.filter((entry) =>
        evidenceRows.some((evidence) => !evidence.textRole || evidence.textRole === entry.type)
      ).slice(-6),
    }) : {
      terminologyEntries: [],
      characterEntries: [],
      characterSpeechEvidence: [],
      styleExampleEntries: [],
      narrationEvidence: [],
      styleProfile: null,
      notes: "No selected learning evidence; AO enrichment was skipped.",
    };

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
      translationPairs: translationPairs.length,
      delta: enrichment,
      projected: {
        terminology: projectedTerminology.length,
        characters: projectedCharacters.length,
        styleExamples: mergeStyleExampleEntries(existing.style_examples, enrichment.styleExampleEntries, chapterId, 16).length,
      },
    };
  }

  async run({
    baseUrl,
    mangaId = null,
    translatorId = null,
    mangaLabel = null,
    translatorLabel = null,
    chapterId = null,
    chapterTitle = null,
    jobId = null,
    knowledgeBasePath = null,
    reportPath = null,
    learningEvidenceSnapshotPath = null,
    publicationRevisionId = null,
  }) {
    if (!learningEvidenceSnapshotPath) {
      throw new Error("Knowledge learning requires a Learning Evidence snapshot.");
    }
    const resolvedPaths =
      knowledgeBasePath && reportPath
        ? {
            mangaId,
            translatorId,
            knowledgeBasePath,
            reportPath,
            mode: "override",
          }
        : resolveKnowledgePaths({ mangaId, translatorId });
    const learningEvidence = validateLearningEvidenceSnapshot(
      JSON.parse(fs.readFileSync(learningEvidenceSnapshotPath, "utf8"))
    );
    const translationPairs = translationPairsFromList(learningEvidence.evidence, chapterId).map((pair) => ({
      ...pair,
      publicationRevisionId,
    }));
    const projectName = `translation_${learningEvidence.sourceTranslationJobId || "unknown"}`;
    const now = new Date().toISOString();

    ensureDirectory(resolvedPaths.knowledgeBasePath);
    ensureDirectory(resolvedPaths.reportPath);

    const existing = normalizeExistingKnowledgeBase(
      fs.existsSync(resolvedPaths.knowledgeBasePath)
        ? JSON.parse(fs.readFileSync(resolvedPaths.knowledgeBasePath, "utf-8"))
        : null,
      projectName
    );
    removeChapterLearningEvidence(existing, chapterId);
    const mergedPairs = [...(existing.translation_pairs || [])];
    const pairIndex = new Map(mergedPairs.map((pair, index) => [pairKey(pair), index]));
    let addedPairs = 0;
    for (const pair of translationPairs) {
      const key = pairKey(pair);
      if (!pairIndex.has(key)) {
        pair.occurrences = [{ chapterId: pair.chapterId, pageName: pair.pageName, nodeId: pair.nodeId }];
        pair.chapterIds = [pair.chapterId].filter(Boolean);
        pair.mentionCount = 1;
        mergedPairs.push(pair);
        pairIndex.set(key, mergedPairs.length - 1);
        addedPairs += 1;
      } else {
        const index = pairIndex.get(key);
        const current = mergedPairs[index];
        const occurrences = [...(current.occurrences || []), {
          chapterId: pair.chapterId, pageName: pair.pageName, nodeId: pair.nodeId,
        }];
        const uniqueOccurrences = [...new Map(occurrences.map((entry) => [
          [entry.chapterId, entry.pageName, entry.nodeId].join("::"), entry,
        ])).values()];
        const chapterIds = [...new Set(uniqueOccurrences.map((entry) => entry.chapterId).filter(Boolean))];
        mergedPairs[index] = {
          ...current,
          occurrences: uniqueOccurrences,
          mentionCount: uniqueOccurrences.length,
          chapterIds,
          chapterId: chapterIds.length === 1 ? chapterIds[0] : null,
          pageName: uniqueOccurrences.length === 1 ? uniqueOccurrences[0].pageName : null,
          nodeId: uniqueOccurrences.length === 1 ? uniqueOccurrences[0].nodeId : null,
          confidence: Math.min(0.99, Math.max(current.confidence || 0, pair.confidence || 0) + Math.max(0, chapterIds.length - 1) * 0.02),
          updatedAt: pair.updatedAt,
        };
      }
    }

    existing.translation_pairs = assignPairIds(mergedPairs);
    existing.metadata.schema_version = SCHEMA_VERSION;
    existing.metadata.manga_id = resolvedPaths.mangaId || existing.metadata.manga_id || null;
    existing.metadata.project_name =
      existing.metadata.project_name || projectName;
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

    const priorConfidenceByTerm = new Map(existing.terminology.map((entry) => [
      `${entry.term || ""}\u0000${entry.translation || ""}`,
      Number(entry.confidence) || 0,
    ]));
    const enrichment = translationPairs.length > 0 ? await this.aoTaskRunner.runKnowledgeEnrichment({
      jobId,
      mangaId: resolvedPaths.mangaId || null,
      translatorId: resolvedPaths.translatorId || null,
      chapterId,
      translationPairs,
      learningEvidence: learningEvidence.evidence,
      knowledgeBase: {
        terminology: existing.terminology.filter((entry) =>
          Boolean(entry.term) && translationPairs.some((pair) => pair.original.includes(entry.term))
        ),
        characters: existing.characters.filter((entry) =>
          learningEvidence.evidence.some((evidence) => evidence.speakerRef === entry.name)
        ),
        style_profile: existing.style_profile,
      },
      styleEvidence: null,
      chapterStyleEvidence: null,
      existingStyleProfile: existing.style_profile,
      existingStyleExamples: existing.style_examples.filter((entry) =>
        learningEvidence.evidence.some((evidence) => !evidence.textRole || evidence.textRole === entry.type)
      ).slice(-6),
    }) : {
      terminologyEntries: [],
      characterEntries: [],
      characterSpeechEvidence: [],
      styleExampleEntries: [],
      narrationEvidence: [],
      styleProfile: null,
      notes: "No selected learning evidence; AO enrichment was skipped.",
    };

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
      chapterId
    );
    existing.style_examples = mergeStyleExampleEntries(
      existing.style_examples,
      enrichment.styleExampleEntries,
      chapterId,
      16
    );
    if (Array.isArray(enrichment.narrationEvidence) && enrichment.narrationEvidence.length > 0) {
      existing.style_profile = mergeNarrationEvidence(
        existing.style_profile,
        enrichment.narrationEvidence,
        chapterId
      );
    }
    if (enrichment.styleProfile) {
      existing.style_profile = mergeStyleProfile(
        existing.style_profile,
        enrichment.styleProfile,
        null
      );
    }
    const confidenceUpdates = existing.terminology.filter((entry) => {
      const previous = priorConfidenceByTerm.get(`${entry.term || ""}\u0000${entry.translation || ""}`);
      return previous !== undefined && (Number(entry.confidence) || 0) > previous;
    }).length;

    const knowledgePayload = JSON.stringify(existing, null, 2);
    const knowledgeTempPath = `${resolvedPaths.knowledgeBasePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(knowledgeTempPath, knowledgePayload, "utf8");
    fs.renameSync(knowledgeTempPath, resolvedPaths.knowledgeBasePath);
    const reportPayload = JSON.stringify(
        {
          timestamp: now,
          schemaVersion: SCHEMA_VERSION,
          enrichmentMode: "ao",
          mangaId: resolvedPaths.mangaId || null,
          chapterId: chapterId || null,
          totalPairs: existing.translation_pairs.length,
          addedPairs,
          terminologyCount: existing.terminology.length,
          characterCount: existing.characters.length,
          notes: enrichment.notes || null,
          learningEvidenceCount: learningEvidence.evidence.length,
          confidenceUpdates,
        },
        null,
        2
      );
    const reportTempPath = `${resolvedPaths.reportPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(reportTempPath, reportPayload, "utf8");
    fs.renameSync(reportTempPath, resolvedPaths.reportPath);

    let knowledgeIndexEntry = null;
    if (resolvedPaths.mangaId) {
      knowledgeIndexEntry = upsertKnowledgeIndexEntry({
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

    updateTodoList(paths.todoList);

    return {
      enrichmentMode: "ao",
      translationPairs: existing.translation_pairs.length,
      characters: existing.characters.length,
      terminology: existing.terminology.length,
      styleExamples: existing.style_examples.length,
      mangaId: resolvedPaths.mangaId,
      translatorId: resolvedPaths.translatorId || null,
      chapterId,
      knowledgeIndexEntry,
      output: resolvedPaths.knowledgeBasePath,
      report: resolvedPaths.reportPath,
      learningEvidenceSnapshotPath,
      learningEvidenceCount: learningEvidence.evidence.length,
      confidenceUpdates,
      publicationRevisionId,
    };
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
  mergeStyleProfile,
  mergeCharacterEntries,
  mergeTerminologyEntries,
  normalizeExistingKnowledgeBase,
  normalizeStyleExampleEntry,
  normalizeStyleProfile,
  pairKey,
  removeChapterLearningEvidence,
};
