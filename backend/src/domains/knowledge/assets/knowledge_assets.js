const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { resolveKnowledgeAssetPaths, resolveKnowledgePaths } = require("../registry/knowledge_paths");

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonOrDefault(filePath, fallbackFactory) {
  if (!fs.existsSync(filePath)) {
    return fallbackFactory();
  }

  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function stableId(prefix, value) {
  const hash = crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 12);
  return `${prefix}_${hash}`;
}

function defaultCanonicalGlossary(mangaId) {
  return {
    metadata: {
      manga_id: mangaId,
      updated_at: new Date().toISOString(),
      source_reference_sets: [],
      source_chapters: [],
      model: {
        terminology: {
          identityLayer: "source_term",
          canonicalLayer: "canonical_translation",
          styleLayer: "rendering_hints",
        },
      },
      policy: {
        priority: ["manual_locked", "reference", "self_inferred", "fallback_free_translation"],
      },
    },
    entries: [],
  };
}

function defaultStoryContext(mangaId) {
  return {
    metadata: {
      manga_id: mangaId,
      updated_at: new Date().toISOString(),
      source_reference_sets: [],
      source_chapters: [],
    },
    global: {
      characters: [],
      terminology: [],
      relationships: [],
      events: [],
      characterStates: [],
      openThreads: [],
    },
    chapters: {},
  };
}

function defaultStoryGraph(mangaId) {
  return {
    metadata: {
      manga_id: mangaId,
      updated_at: new Date().toISOString(),
      source_reference_sets: [],
      source_chapters: [],
      schema_version: 1,
    },
    nodes: [],
    edges: [],
    chapters: {},
  };
}

function defaultSocialGraph(mangaId) {
  return {
    metadata: {
      manga_id: mangaId,
      updated_at: new Date().toISOString(),
      source_reference_sets: [],
      source_chapters: [],
      schema_version: 1,
      derived_from: "story_graph",
    },
    nodes: [],
    edges: [],
    chapters: {},
  };
}

function defaultCandidateTerms(mangaId) {
  return {
    metadata: {
      manga_id: mangaId,
      updated_at: new Date().toISOString(),
      source_reference_sets: [],
      source_chapters: [],
      ranking: {
        primary: "confidence_score",
        secondary: "chapter_count",
        tertiary: "mention_count",
      },
    },
    entries: [],
  };
}

function defaultStyleProfile(mangaId) {
  return {
    metadata: {
      manga_id: mangaId,
      updated_at: new Date().toISOString(),
      source_reference_sets: [],
      source_chapters: [],
    },
    rules: {
      register: "unknown",
      preserveHonorifics: null,
      punctuation: { preferFullWidth: null, ellipsis: null, quoteStyle: null },
      dialogueNarration: {
        dialogueRatio: 0,
        narrationRatio: 0,
        monologueRatio: 0,
      },
      sentenceLength: "unknown",
    },
    confidence: {},
    samples: { dialogue: [], narration: [], monologue: [], honorifics: [] },
  };
}

function defaultStyleEvidence(mangaId) {
  return {
    metadata: {
      manga_id: mangaId,
      updated_at: new Date().toISOString(),
      source_reference_sets: [],
      source_chapters: [],
    },
    chapters: {},
  };
}

function writeJson(filePath, data) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

function loadCanonicalGlossary(mangaId, translatorId = null) {
  const { glossaryPath } = resolveKnowledgeAssetPaths({
    mangaId,
    translatorId,
  });
  return readJsonOrDefault(glossaryPath, () => defaultCanonicalGlossary(mangaId));
}

function loadStoryContext(mangaId, translatorId = null) {
  const { storyContextPath } = resolveKnowledgeAssetPaths({
    mangaId,
    translatorId,
  });
  return readJsonOrDefault(storyContextPath, () => defaultStoryContext(mangaId));
}

function loadCandidateTerms(mangaId, translatorId = null) {
  const { candidateTermsPath } = resolveKnowledgeAssetPaths({
    mangaId,
    translatorId,
  });
  return readJsonOrDefault(candidateTermsPath, () => defaultCandidateTerms(mangaId));
}

function loadStoryGraph(mangaId, translatorId = null) {
  const { storyGraphPath } = resolveKnowledgeAssetPaths({
    mangaId,
    translatorId,
  });
  return readJsonOrDefault(storyGraphPath, () => defaultStoryGraph(mangaId));
}

function loadSocialGraph(mangaId, translatorId = null) {
  const { socialGraphPath } = resolveKnowledgeAssetPaths({
    mangaId,
    translatorId,
  });
  return readJsonOrDefault(socialGraphPath, () => defaultSocialGraph(mangaId));
}

function loadStyleProfile(mangaId, translatorId = null) {
  const { styleProfilePath } = resolveKnowledgeAssetPaths({
    mangaId,
    translatorId,
  });
  return readJsonOrDefault(styleProfilePath, () => defaultStyleProfile(mangaId));
}

function loadStyleEvidence(mangaId, translatorId = null) {
  const { styleEvidencePath } = resolveKnowledgeAssetPaths({
    mangaId,
    translatorId,
  });
  return readJsonOrDefault(styleEvidencePath, () => defaultStyleEvidence(mangaId));
}

function loadTranslationContext(mangaId, translatorId = null) {
  const { translationContextPath } = resolveKnowledgeAssetPaths({
    mangaId,
    translatorId,
  });
  return readJsonOrDefault(translationContextPath, () => ({
    mangaId,
    translatorId,
    chapterId: null,
    glossaryMode: "canonical",
    generatedAt: new Date().toISOString(),
    chapterLocal: {
      chapterId: null,
      characters: [],
      terminology: [],
      keyLines: [],
      referenceSetIds: [],
    },
    mangaGlobal: {
      glossary: [],
      fallbackTerminology: [],
      stableCharacters: [],
      stableTerminology: [],
    },
    styleConstraints: {},
  }));
}

function loadKnowledgeBase(mangaId, translatorId = null) {
  const { knowledgeBasePath } = resolveKnowledgePaths({
    mangaId,
    translatorId,
  });
  return readJsonOrDefault(knowledgeBasePath, () => null);
}

function writeCanonicalGlossary(mangaId, glossary, translatorId = null) {
  const { glossaryPath } = resolveKnowledgeAssetPaths({
    mangaId,
    translatorId,
  });
  return writeJson(glossaryPath, glossary);
}

function writeStoryContext(mangaId, context, translatorId = null) {
  const { storyContextPath } = resolveKnowledgeAssetPaths({
    mangaId,
    translatorId,
  });
  return writeJson(storyContextPath, context);
}

function writeCandidateTerms(mangaId, candidateTerms, translatorId = null) {
  const { candidateTermsPath } = resolveKnowledgeAssetPaths({
    mangaId,
    translatorId,
  });
  return writeJson(candidateTermsPath, candidateTerms);
}

function writeStoryGraph(mangaId, graph, translatorId = null) {
  const { storyGraphPath } = resolveKnowledgeAssetPaths({
    mangaId,
    translatorId,
  });
  return writeJson(storyGraphPath, graph);
}

function writeSocialGraph(mangaId, graph, translatorId = null) {
  const { socialGraphPath } = resolveKnowledgeAssetPaths({
    mangaId,
    translatorId,
  });
  return writeJson(socialGraphPath, graph);
}

function writeStyleProfile(mangaId, profile, translatorId = null) {
  const { styleProfilePath } = resolveKnowledgeAssetPaths({
    mangaId,
    translatorId,
  });
  return writeJson(styleProfilePath, profile);
}

function writeStyleEvidence(mangaId, evidence, translatorId = null) {
  const { styleEvidencePath } = resolveKnowledgeAssetPaths({
    mangaId,
    translatorId,
  });
  return writeJson(styleEvidencePath, evidence);
}

function writeTranslationContext(mangaId, context, translatorId = null) {
  const { translationContextPath } = resolveKnowledgeAssetPaths({
    mangaId,
    translatorId,
  });
  return writeJson(translationContextPath, context);
}

function resolveEntityType(entry, fallbackKind = "term") {
  if (entry.entity_type) {
    return entry.entity_type;
  }
  if (fallbackKind === "character" || entry.kind === "character" || entry.category === "character_name") {
    return "character";
  }
  return "term";
}

function resolveCanonicalForm(entry) {
  return (
    entry.canonical_form ||
    entry.source_term ||
    entry.source_name ||
    entry.term ||
    entry.candidate ||
    entry.name ||
    entry.label ||
    entry.canonical_translation ||
    entry.translation ||
    null
  );
}

function resolveTargetRendering(entry, referenceKind, canonicalTranslation) {
  if (Object.prototype.hasOwnProperty.call(entry, "target_rendering")) {
    return entry.target_rendering ?? null;
  }
  if (referenceKind === "source") {
    return null;
  }
  return canonicalTranslation || entry.translation || null;
}

function normalizeGlossaryCollections(entry) {
  const renderingHints = entry.rendering_hints;
  return {
    source_aliases: [...new Set((Array.isArray(entry.source_aliases) ? entry.source_aliases : []).filter(Boolean))],
    aliases: [...new Set((Array.isArray(entry.aliases) ? entry.aliases : []).filter(Boolean))],
    rendering_hints: renderingHints && typeof renderingHints === "object" && !Array.isArray(renderingHints)
      ? renderingHints : {},
    examples: Array.isArray(entry.examples) ? entry.examples : [],
  };
}

function normalizeGlossaryMetadata(entry) {
  return {
    category: entry.category || "general_term",
    source: entry.source || "reference",
    locked: entry.locked === true,
    updated_at: entry.updated_at || new Date().toISOString(),
    confidence: entry.confidence ?? null,
    provenance: entry.provenance || {},
  };
}

function normalizeGlossaryEntry(entry) {
  const sourceTerm = entry.source_term ?? null;
  const canonicalTranslation = entry.canonical_translation;
  const referenceKind = entry.reference_kind || null;
  const entityType = resolveEntityType(entry);
  const canonicalForm = resolveCanonicalForm(entry);
  const targetRendering = resolveTargetRendering(entry, referenceKind, canonicalTranslation);
  const identityKey =
    entry.identity_key ||
    stableId(
      "term_identity",
      `${entry.category || "general_term"}::${sourceTerm || canonicalForm || canonicalTranslation || ""}`,
    );
  return {
    term_id:
      entry.term_id ||
      stableId("term", `${entry.category || "general_term"}::${canonicalForm || canonicalTranslation}`),
    identity_key: identityKey,
    entity_type: entityType,
    reference_kind: referenceKind,
    source_term: sourceTerm,
    canonical_form: canonicalForm,
    target_rendering: targetRendering,
    canonical_translation: canonicalTranslation,
    ...normalizeGlossaryCollections(entry),
    ...normalizeGlossaryMetadata(entry),
  };
}

function glossaryEntryKey(entry) {
  return `${entry.category || "general_term"}::${entry.source_term || entry.canonical_form || entry.canonical_translation || ""}`;
}

function candidateEntryKey(entry) {
  return `${entry.kind || "term"}::${entry.source_term || entry.observed_form || entry.canonical_form || entry.canonical_translation || entry.label || ""}`;
}

function isTargetOnlyCandidate(entry, referenceKind) {
  const evidenceNotes = (Array.isArray(entry.evidence) ? entry.evidence : []).map((item) => item?.note || "").join(" ");
  return (
    entry.alignment_status === "target_only" ||
    (referenceKind === "translator" &&
      /target[_ -]?only|without confirmed source alignment/i.test(
        `${entry.notes || entry.reason || ""} ${evidenceNotes}`,
      ))
  );
}

function resolveCandidateLexicalValues(entry, isTargetOnly) {
  const observedForm =
    entry.observed_form ||
    entry.target_rendering ||
    entry.candidate ||
    entry.name ||
    entry.label ||
    entry.translation ||
    entry.canonical_translation ||
    entry.term ||
    null;
  const sourceTerm = isTargetOnly
    ? null
    : entry.source_term || entry.source_name || entry.term || entry.candidate || entry.name || entry.label || null;
  const canonicalTranslation = isTargetOnly
    ? null
    : entry.canonical_translation || entry.translation || entry.name || entry.term || entry.candidate || sourceTerm;
  const kind = entry.kind || (entry.name || entry.source_name ? "character" : "term");
  const status = entry.status || entry.candidate_status || "candidate";
  return { observedForm, sourceTerm, canonicalTranslation, kind, status };
}

function resolveCandidateEvidence(entry, chapterId, referenceSetId, status, now) {
  const chapterIds = [
    ...new Set([...(Array.isArray(entry.chapter_ids) ? entry.chapter_ids : []), chapterId].filter(Boolean)),
  ];
  const referenceSetIds = [
    ...new Set(
      [...(Array.isArray(entry.reference_set_ids) ? entry.reference_set_ids : []), referenceSetId].filter(Boolean),
    ),
  ];
  const mentions = Number.isFinite(entry.mention_count) ? entry.mention_count : 1;
  const evidence = Array.isArray(entry.evidence)
    ? entry.evidence.filter(Boolean)
    : [
        {
          referenceSetId: referenceSetId || null,
          chapterId: chapterId || null,
          status,
          confidence: Number.isFinite(entry.confidence) ? entry.confidence : 0.5,
          note: entry.notes || entry.reason || "",
          observedAt: now,
        },
      ];
  return { chapterIds, referenceSetIds, mentions, evidence };
}

function resolveCandidateStatistics(entry, status, chapterIds) {
  const acceptedCount = Number.isFinite(entry.accepted_count) ? entry.accepted_count : status === "accepted" ? 1 : 0;
  const rejectedCount = Number.isFinite(entry.rejected_count) ? entry.rejected_count : status === "rejected" ? 1 : 0;
  const candidateCount = Number.isFinite(entry.candidate_count)
    ? entry.candidate_count
    : status === "candidate"
      ? 1
      : 0;
  const chapterCount = Number.isFinite(entry.chapter_count) ? entry.chapter_count : chapterIds.length;
  const confidenceScore = Number.isFinite(entry.confidence_score)
    ? entry.confidence_score
    : Number.isFinite(entry.confidence)
      ? entry.confidence
      : 0.5;
  return { acceptedCount, rejectedCount, candidateCount, chapterCount, confidenceScore };
}

function resolveCandidateRendering(entry, lexical, referenceKind, isTargetOnly) {
  const { sourceTerm, canonicalTranslation, kind, observedForm } = lexical;
  const entityType = resolveEntityType(entry, kind);
  const canonicalForm = isTargetOnly
    ? null
    : resolveCanonicalForm({
        ...entry,
        source_term: sourceTerm,
        canonical_translation: canonicalTranslation,
      });
  const targetRendering = resolveTargetRendering(
    {
      ...entry,
      source_term: sourceTerm,
      canonical_translation: canonicalTranslation,
    },
    referenceKind,
    canonicalTranslation,
  );
  const resolvedTargetRendering = isTargetOnly ? observedForm : targetRendering;
  return { entityType, canonicalForm, resolvedTargetRendering };
}

function buildCandidateIdentity(entry, lexical, rendering, referenceKind, isTargetOnly) {
  const { sourceTerm, observedForm, canonicalTranslation, kind, status } = lexical;
  const { entityType, canonicalForm, resolvedTargetRendering } = rendering;
  return {
    candidate_id:
      entry.candidate_id ||
      stableId("candidate", `${kind}::${sourceTerm || observedForm || canonicalForm || canonicalTranslation || ""}`),
    kind,
    entity_type: entityType,
    reference_kind: referenceKind,
    alignment_status: isTargetOnly ? "target_only" : entry.alignment_status || "aligned",
    status,
    source_term: sourceTerm,
    observed_form: isTargetOnly ? observedForm : entry.observed_form || null,
    canonical_form: canonicalForm,
    target_rendering: resolvedTargetRendering,
    canonical_translation: canonicalTranslation,
    category: entry.category || (kind === "character" ? "character_name" : "general_term"),
    aliases: [...new Set((Array.isArray(entry.aliases) ? entry.aliases : []).filter(Boolean))],
    title_forms: [...new Set((Array.isArray(entry.title_forms) ? entry.title_forms : []).filter(Boolean))],
  };
}

function buildCandidateHistory(entry, evidenceValues, statistics, now) {
  const { chapterIds, referenceSetIds, mentions, evidence } = evidenceValues;
  const { acceptedCount, rejectedCount, candidateCount, chapterCount, confidenceScore } = statistics;
  return {
    confidence_score: confidenceScore,
    mention_count: mentions,
    chapter_count: chapterCount,
    accepted_count: acceptedCount,
    candidate_count: candidateCount,
    rejected_count: rejectedCount,
    first_seen_chapter: entry.first_seen_chapter || chapterIds[0] || null,
    last_seen_chapter: entry.last_seen_chapter || chapterIds[chapterIds.length - 1] || null,
    chapter_ids: chapterIds,
    reference_set_ids: referenceSetIds,
    notes: entry.notes || entry.reason || "",
    evidence: evidence.slice(-12),
    updated_at: entry.updated_at || now,
  };
}

function normalizeCandidateTermEntry(entry, { chapterId = null, referenceSetId = null } = {}) {
  const now = new Date().toISOString();
  const referenceKind = entry.reference_kind || null;
  const isTargetOnly = isTargetOnlyCandidate(entry, referenceKind);
  const lexical = resolveCandidateLexicalValues(entry, isTargetOnly);
  const evidence = resolveCandidateEvidence(entry, chapterId, referenceSetId, lexical.status, now);
  const statistics = resolveCandidateStatistics(entry, lexical.status, evidence.chapterIds);
  const rendering = resolveCandidateRendering(entry, lexical, referenceKind, isTargetOnly);
  return {
    ...buildCandidateIdentity(entry, lexical, rendering, referenceKind, isTargetOnly),
    ...buildCandidateHistory(entry, evidence, statistics, now),
  };
}

function deriveCandidateConfidence(current, incoming) {
  const acceptedWeight = ((current.accepted_count || 0) + (incoming.accepted_count || 0)) * 0.08;
  const candidateWeight = ((current.candidate_count || 0) + (incoming.candidate_count || 0)) * 0.04;
  const repeatedChapterWeight =
    Math.max(new Set([...(current.chapter_ids || []), ...(incoming.chapter_ids || [])]).size - 1, 0) * 0.05;
  const rejectedPenalty = ((current.rejected_count || 0) + (incoming.rejected_count || 0)) * 0.12;
  const base = Math.max(current.confidence_score || 0, incoming.confidence_score || 0, 0.35);
  const next = base + acceptedWeight + candidateWeight + repeatedChapterWeight - rejectedPenalty;
  return Number(Math.max(0, Math.min(0.99, next)).toFixed(4));
}

function mergeCandidateCounts(current, normalized) {
  const accepted = (current.accepted_count || 0) + (normalized.accepted_count || 0);
  const candidate = (current.candidate_count || 0) + (normalized.candidate_count || 0);
  const rejected = (current.rejected_count || 0) + (normalized.rejected_count || 0);
  const status = accepted > 0 ? "accepted" : candidate > 0 ? "candidate" : rejected > 0 ? "rejected" : current.status;
  return { accepted, candidate, rejected, status };
}

function mergeCandidateIdentity(current, normalized, counts) {
  const currentRendering = current.target_rendering !== undefined ? current.target_rendering : null;
  return {
    kind: current.kind || normalized.kind,
    entity_type: current.entity_type || normalized.entity_type,
    reference_kind: current.reference_kind || normalized.reference_kind || null,
    alignment_status: current.alignment_status === "aligned" || normalized.alignment_status === "aligned"
      ? "aligned" : "target_only",
    status: counts.status,
    source_term: current.source_term || normalized.source_term || null,
    observed_form: normalized.observed_form || current.observed_form || null,
    canonical_form: normalized.canonical_form || current.canonical_form || current.source_term || normalized.source_term || null,
    target_rendering: normalized.target_rendering !== undefined ? normalized.target_rendering : currentRendering,
    canonical_translation: normalized.canonical_translation || current.canonical_translation,
    category: normalized.category || current.category,
    aliases: [...new Set([...(current.aliases || []), ...(normalized.aliases || [])])],
    title_forms: [...new Set([...(current.title_forms || []), ...(normalized.title_forms || [])])],
  };
}

function mergeCandidateHistory(current, normalized, counts, chapterIds, referenceSetIds, now) {
  return {
    mention_count: (current.mention_count || 0) + (normalized.mention_count || 0),
    chapter_count: chapterIds.length,
    accepted_count: counts.accepted,
    candidate_count: counts.candidate,
    rejected_count: counts.rejected,
    first_seen_chapter: current.first_seen_chapter || normalized.first_seen_chapter || null,
    last_seen_chapter: normalized.last_seen_chapter || current.last_seen_chapter || null,
    chapter_ids: chapterIds,
    reference_set_ids: referenceSetIds,
    notes: [current.notes, normalized.notes].filter(Boolean).join("\n").trim(),
    evidence: [...(current.evidence || []), ...(normalized.evidence || [])].slice(-20),
    updated_at: now,
  };
}

function mergeCandidateTermPair(current, normalized, now) {
  const chapterIds = [...new Set([...(current.chapter_ids || []), ...(normalized.chapter_ids || [])])];
  const referenceSetIds = [...new Set([...(current.reference_set_ids || []), ...(normalized.reference_set_ids || [])])];
  const counts = mergeCandidateCounts(current, normalized);
  const next = {
    ...current,
    ...mergeCandidateIdentity(current, normalized, counts),
    ...mergeCandidateHistory(current, normalized, counts, chapterIds, referenceSetIds, now),
  };
  next.confidence_score = deriveCandidateConfidence(current, next);
  return next;
}

function buildCandidateTermsResult(existingCandidates, merged, now, chapterId, referenceSetId) {
  const entries = [...merged.values()].sort((left, right) => {
    if ((right.confidence_score || 0) !== (left.confidence_score || 0))
      return (right.confidence_score || 0) - (left.confidence_score || 0);
    if ((right.chapter_count || 0) !== (left.chapter_count || 0))
      return (right.chapter_count || 0) - (left.chapter_count || 0);
    if ((right.mention_count || 0) !== (left.mention_count || 0))
      return (right.mention_count || 0) - (left.mention_count || 0);
    return String(left.source_term || left.observed_form || left.canonical_translation || "").localeCompare(
      String(right.source_term || right.observed_form || right.canonical_translation || ""),
    );
  });
  return {
    metadata: {
      ...existingCandidates.metadata,
      updated_at: now,
      source_reference_sets: [
        ...new Set([...(existingCandidates.metadata?.source_reference_sets || []), referenceSetId].filter(Boolean)),
      ],
      source_chapters: chapterId
        ? [...new Set([...(existingCandidates.metadata?.source_chapters || []), chapterId])]
        : existingCandidates.metadata?.source_chapters || [],
    },
    entries,
  };
}

function mergeCandidateTerms(existingCandidates, candidateEntries, chapterId, referenceSetId) {
  const now = new Date().toISOString();
  const merged = new Map();
  for (const entry of existingCandidates.entries || []) {
    const normalized = normalizeCandidateTermEntry(entry);
    merged.set(candidateEntryKey(normalized), normalized);
  }
  for (const entry of candidateEntries) {
    const normalized = normalizeCandidateTermEntry(entry, {
      chapterId,
      referenceSetId,
    });
    const key = candidateEntryKey(normalized);
    if (!merged.has(key)) {
      merged.set(key, normalized);
      continue;
    }
    const current = merged.get(key);
    merged.set(key, mergeCandidateTermPair(current, normalized, now));
  }
  return buildCandidateTermsResult(existingCandidates, merged, now, chapterId, referenceSetId);
}

function mergeGlossaryAliases(current, normalized) {
  return [...new Set([
    current.canonical_translation,
    ...(current.aliases || []),
    normalized.canonical_translation,
    ...(normalized.aliases || []),
  ])].filter(Boolean);
}

function resolveMergedTargetRendering(current, normalized) {
  if (normalized.target_rendering !== undefined) return normalized.target_rendering;
  return current.target_rendering !== undefined ? current.target_rendering : null;
}

function mergeCanonicalGlossaryEntry(current, normalized, now, referenceSetId, chapterId) {
  if (current.locked || current.source === "manual") {
    return { ...current, aliases: mergeGlossaryAliases(current, normalized), updated_at: now };
  }
  return {
    ...current,
    identity_key: current.identity_key || normalized.identity_key,
    entity_type: current.entity_type || normalized.entity_type,
    reference_kind: current.reference_kind || normalized.reference_kind || null,
    source_term: current.source_term || normalized.source_term || null,
    canonical_form:
      normalized.canonical_form || current.canonical_form || current.source_term || normalized.source_term || null,
    target_rendering: resolveMergedTargetRendering(current, normalized),
    source_aliases: [...new Set([...(current.source_aliases || []), ...(normalized.source_aliases || [])])],
    canonical_translation: normalized.canonical_translation,
    aliases: mergeGlossaryAliases(current, normalized),
    rendering_hints: {
      ...(current.rendering_hints || {}),
      ...(normalized.rendering_hints || {}),
    },
    source: normalized.source,
    updated_at: now,
    confidence: Math.max(current.confidence || 0, normalized.confidence || 0) || null,
    examples: [...(current.examples || []), ...(normalized.examples || [])].slice(-5),
    provenance: { referenceSetId, chapterId: chapterId || null },
  };
}

function buildCanonicalGlossaryResult(existingGlossary, merged, now, chapterId, referenceSetId) {
  return {
    metadata: {
      ...existingGlossary.metadata,
      updated_at: now,
      source_reference_sets: [
        ...new Set([...(existingGlossary.metadata?.source_reference_sets || []), referenceSetId]),
      ],
      source_chapters: chapterId
        ? [...new Set([...(existingGlossary.metadata?.source_chapters || []), chapterId])]
        : existingGlossary.metadata?.source_chapters || [],
    },
    entries: [...merged.values()].sort((left, right) =>
      String(left.canonical_translation).localeCompare(String(right.canonical_translation)),
    ),
  };
}

function mergeCanonicalGlossary(existingGlossary, candidateEntries, chapterId, referenceSetId) {
  const merged = new Map();
  const now = new Date().toISOString();
  for (const entry of existingGlossary.entries || []) {
    const normalized = normalizeGlossaryEntry(entry);
    merged.set(glossaryEntryKey(normalized), normalized);
  }
  for (const entry of candidateEntries) {
    const normalized = normalizeGlossaryEntry(entry);
    const key = glossaryEntryKey(normalized);
    if (!merged.has(key)) {
      merged.set(key, normalized);
      continue;
    }
    const current = merged.get(key);
    merged.set(key, mergeCanonicalGlossaryEntry(current, normalized, now, referenceSetId, chapterId));
  }
  return buildCanonicalGlossaryResult(existingGlossary, merged, now, chapterId, referenceSetId);
}
function buildStoryContextChapter(currentChapter, incomingContext, chapterId, referenceSetId, now) {
  return {
    ...currentChapter,
    chapterId: chapterId || currentChapter.chapterId || null,
    referenceSetIds: [...new Set([...(currentChapter.referenceSetIds || []), referenceSetId])],
    characters: incomingContext.characters,
    terminology: incomingContext.terminology,
    mentions: incomingContext.mentions || [],
    events: incomingContext.events || [],
    relationships: incomingContext.relationships || [],
    keyLines: incomingContext.keyLines || [],
    characterStates: incomingContext.characterStates || [],
    openThreads: incomingContext.openThreads || [],
    storyDeltaNotes: incomingContext.storyDeltaNotes || "",
    updatedAt: now,
  };
}

function globalStoryEntries(existingContext, incomingContext, key) {
  return [...(existingContext.global?.[key] || []), ...(incomingContext[key] || [])];
}

function normalizeStoryEventText(value) {
  return String(value || "").toLowerCase()
    .replace(/[^\\p{L}\\p{N}\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}]+/gu, " ")
    .replace(/\\s+/g, " ").trim();
}

function storyEventKey(entry) {
  return [normalizeStoryEventText(entry.evidenceLine), normalizeStoryEventText(entry.summary)].join("::");
}

function storyMentionKey(entry) {
  return [entry.entityType, entry.surfaceForm, entry.canonicalForm, entry.evidenceLine]
    .map((value) => String(value || "")).join("::");
}

function buildStoryContextGlobal(existingContext, incomingContext) {
  return {
    characters: uniqueByName(globalStoryEntries(existingContext, incomingContext, "characters")),
    terminology: uniqueByTerm(globalStoryEntries(existingContext, incomingContext, "terminology")),
    relationships: uniqueStoryItems(
      globalStoryEntries(existingContext, incomingContext, "relationships"),
      (entry) => [entry.relationType || entry.type || "related_to", entry.subject || "", entry.object || ""].join("::"),
    ),
    events: uniqueStoryItems(globalStoryEntries(existingContext, incomingContext, "events"), storyEventKey),
    mentions: uniqueStoryItems(globalStoryEntries(existingContext, incomingContext, "mentions"), storyMentionKey),
    keyLines: uniqueStoryItems(globalStoryEntries(existingContext, incomingContext, "keyLines"),
      (entry) => (typeof entry === "string" ? entry : String(entry?.text || ""))),
    characterStates: uniqueStoryItems(globalStoryEntries(existingContext, incomingContext, "characterStates"),
      (entry) => `${entry.character || ""}::${entry.attribute || ""}::${entry.value || ""}`),
    openThreads: uniqueStoryItems(globalStoryEntries(existingContext, incomingContext, "openThreads"),
      (entry) => String(entry.summary || "")),
  };
}
function buildStoryContextResult(existingContext, chapters, now, chapterId, referenceSetId, global) {
  return {
    metadata: {
      ...existingContext.metadata,
      updated_at: now,
      source_reference_sets: [...new Set([...(existingContext.metadata?.source_reference_sets || []), referenceSetId])],
      source_chapters: chapterId
        ? [...new Set([...(existingContext.metadata?.source_chapters || []), chapterId])]
        : existingContext.metadata?.source_chapters || [],
    },
    global,
    chapters,
  };
}

function mergeStoryContext(existingContext, incomingContext, chapterKey, chapterId, referenceSetId) {
  const now = new Date().toISOString();
  const chapters = { ...(existingContext.chapters || {}) };
  const currentChapter = chapters[chapterKey] || {
    chapterId: chapterId || null,
    referenceSetIds: [],
    characters: [],
    terminology: [],
    mentions: [],
    events: [],
    relationships: [],
    keyLines: [],
    characterStates: [],
    openThreads: [],
    updatedAt: now,
  };
  chapters[chapterKey] = buildStoryContextChapter(currentChapter, incomingContext, chapterId, referenceSetId, now);
  return buildStoryContextResult(
    existingContext,
    chapters,
    now,
    chapterId,
    referenceSetId,
    buildStoryContextGlobal(existingContext, incomingContext),
  );
}
function normalizeNodeName(value) {
  return String(value || "").trim();
}

function normalizeNodeType(value) {
  return value === "event" || value === "place" || value === "organization" || value === "term" ? value : "character";
}

function buildStoryGraphNodeId(nodeType, canonicalName) {
  return stableId("graph_node", `${nodeType}::${canonicalName}`);
}

function buildStoryGraphEdgeId(sourceNodeId, relationType, targetNodeId) {
  return stableId("graph_edge", `${sourceNodeId}::${relationType}::${targetNodeId || "none"}`);
}

function normalizeIdentityKey(value) {
  return normalizeNodeName(value)
    .replace(/\([^)]*\)|（[^）]*）/gu, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLocaleLowerCase();
}

function isUsableIdentity(value) {
  const key = normalizeIdentityKey(value);
  return Boolean(key) && !new Set(["?", "unknown", "null", "undefined", "不明", "未詳"]).has(key);
}

function processStoryGraphCharacters(chapterContext, upsertNode, characterNodes) {
  for (const entry of chapterContext.characters || []) {
    const canonicalName = entry.name || entry.canonicalForm || entry.sourceTerm;
    const node = upsertNode(
      "character",
      canonicalName,
      { entity_type: entry.entityType || "character" },
      {
        aliases: entry.aliases || entry.title_forms || [],
        sourceTerms: [entry.canonicalForm, entry.sourceTerm].filter(Boolean),
        confidence: entry.confidence,
      },
    );
    if (node) characterNodes.set(node.canonical_name, node);
  }
}

function processStoryGraphTerms(chapterContext, upsertNode, termNodes) {
  for (const entry of chapterContext.terminology || []) {
    const canonicalName = entry.canonicalForm || entry.term || entry.sourceTerm;
    const node = upsertNode(
      "term",
      canonicalName,
      { category: entry.category || "general_term" },
      {
        sourceTerms: [entry.sourceTerm, entry.term].filter(Boolean),
        confidence: entry.confidence,
      },
    );
    if (node) termNodes.set(node.canonical_name, node);
  }
}

function mentionNodeExtra(mention) {
  return {
    aliases: [mention.surfaceForm].filter(Boolean),
    sourceTerms: [mention.surfaceForm, mention.canonicalForm].filter(Boolean),
    confidence: mention.confidence,
  };
}

function isCharacterMentionType(entityType) {
  return entityType === "character" || entityType === "title_form" || entityType === "role";
}

function resolveMentionNode(mention, entityType, canonicalForm, operations) {
  if (isCharacterMentionType(entityType)) {
    return operations.resolveCharacterNodeByName(canonicalForm)
      || operations.upsertNode("character", canonicalForm, { entity_type: entityType || "character" }, mentionNodeExtra(mention));
  }
  const nodeType = entityType === "location" ? "place" : entityType === "organization" ? "organization" : "term";
  return operations.resolveTermNodeByName(canonicalForm)
    || operations.upsertNode(nodeType, canonicalForm, { entity_type: entityType || "term" }, mentionNodeExtra(mention));
}

function indexMentionNode(node, entityType, canonicalForm, operations) {
  if (!node) return;
  if (isCharacterMentionType(entityType)) operations.characterNodes.set(node.canonical_name, node);
  else if (node.node_type === "term") operations.termNodes.set(node.canonical_name, node);
  operations.mentionNodeCache.set(`${entityType}::${canonicalForm}`, node);
}

function processStoryGraphMentions(chapterContext, operations) {
  const mentions = Array.isArray(chapterContext.mentions) ? chapterContext.mentions : [];
  for (const mention of mentions) {
    const entityType = normalizeNodeName(mention.entityType);
    const canonicalForm = mention.canonicalForm || mention.surfaceForm;
    if (!canonicalForm) continue;
    const node = resolveMentionNode(mention, entityType, canonicalForm, operations);
    indexMentionNode(node, entityType, canonicalForm, operations);
  }
}

function processStoryGraphEvents(
  chapterContext,
  upsertNode,
  addEdge,
  resolveCharacterNodeByName,
  buildGraphEvidences,
  chapterId,
) {
  for (const event of chapterContext.events || []) {
    const summary = normalizeNodeName(event.summary);
    if (!summary) continue;
    const eventNode = upsertNode("event", summary, { chapter_id: chapterId || null }, { confidence: event.confidence });
    if (!eventNode) continue;
    if (Array.isArray(event.participants)) {
      for (const participant of event.participants) {
        const participantNode = resolveCharacterNodeByName(participant);
        if (!participantNode) continue;
        addEdge(
          participantNode.node_id,
          "appears_in_event",
          eventNode.node_id,
          buildGraphEvidences(event, summary, event.confidence || null),
        );
      }
    }
  }
}

function resolveRelationshipCharacter(name, relationship, operations) {
  if (!isUsableIdentity(name)) return null;
  return operations.resolveCharacterNodeByName(name) || operations.upsertNode(
    "character",
    name,
    { entity_type: "character", identity_status: "provisional" },
    { sourceTerms: [name], confidence: Math.min(relationship.confidence || 0.65, 0.72) },
  );
}

function applyStoryGraphRelationship(relationship, operations) {
  const relationName = normalizeNodeName(relationship.term);
  if (!relationName) return;
  const summary = normalizeNodeName(relationship.summary);
  const relationType = normalizeNodeName(relationship.relationType);
  const subjectNode = resolveRelationshipCharacter(normalizeNodeName(relationship.subject), relationship, operations);
  const objectNode = resolveRelationshipCharacter(normalizeNodeName(relationship.object), relationship, operations);
  if (subjectNode) operations.characterNodes.set(subjectNode.canonical_name, subjectNode);
  if (objectNode) operations.characterNodes.set(objectNode.canonical_name, objectNode);
  if (relationType === "has_role") {
    if (subjectNode) operations.addRoleAttribute(subjectNode, relationName);
    return;
  }
  if (subjectNode && objectNode && relationType) {
    const evidence = operations.buildGraphEvidences(relationship, summary, 0.72);
    operations.addEdge(subjectNode.node_id, relationType, objectNode.node_id, evidence);
  }
}

function processStoryGraphRelationships(chapterContext, operations) {
  for (const relationship of chapterContext.relationships || []) {
    applyStoryGraphRelationship(relationship, operations);
  }
}

function updateStoryGraphNode(existing, state, attributes, extra) {
  existing.aliases = [...new Set([...(existing.aliases || []), ...(extra.aliases || [])].filter(Boolean))];
  existing.source_terms = [...new Set(
    [...(existing.source_terms || []), ...(extra.sourceTerms || [])].filter(Boolean),
  )];
  existing.confidence = Math.max(existing.confidence || 0, extra.confidence || 0);
  existing.reference_kinds = [...new Set([...(existing.reference_kinds || []), state.referenceKind])];
  existing.last_seen_chapter = state.chapterId || existing.last_seen_chapter || null;
  existing.evidence_count = (existing.evidence_count || 1) + 1;
  existing.attributes = { ...(existing.attributes || {}), ...attributes };
  return existing;
}

function createStoryGraphNode(state, normalizedType, normalizedName, attributes, extra) {
  return {
    node_id: buildStoryGraphNodeId(normalizedType, normalizedName),
    node_type: normalizedType,
    canonical_name: normalizedName,
    aliases: [...new Set((extra.aliases || []).filter(Boolean))],
    source_terms: [...new Set((extra.sourceTerms || []).filter(Boolean))],
    confidence: extra.confidence || null,
    first_seen_chapter: state.chapterId || null,
    last_seen_chapter: state.chapterId || null,
    reference_kinds: [state.referenceKind],
    evidence_count: 1,
    attributes,
    updated_at: state.now,
  };
}

function upsertStoryGraphNode(state, nodeType, canonicalName, attributes = {}, extra = {}) {
  const normalizedType = normalizeNodeType(nodeType);
  const normalizedName = normalizeNodeName(canonicalName);
  if (!normalizedName) return null;
  const key = `${normalizedType}::${normalizedName}`;
  if (state.nodeByKey.has(key)) {
    return updateStoryGraphNode(state.nodeByKey.get(key), state, attributes, extra);
  }
  const node = createStoryGraphNode(state, normalizedType, normalizedName, attributes, extra);
  state.nodeByKey.set(key, node);
  state.nodes.push(node);
  return node;
}

function mergeStoryGraphEdgeEvidence(existing, evidences) {
  const evidenceByKey = new Map(
    [...(existing.evidences || []), ...evidences].map((entry) => [
      `${entry?.pageName || ""}::${entry?.nodeId || ""}::${entry?.line || ""}`,
      entry,
    ]),
  );
  existing.evidences = [...evidenceByKey.values()];
  existing.evidence_count = existing.evidences.length || 1;
  existing.confidence = Math.max(
    existing.confidence || 0,
    ...evidences.map((entry) => entry?.confidence || 0),
  ) || null;
}

function createStoryGraphEdge(state, edgeId, sourceNodeId, relationType, targetNodeId, evidences) {
  return {
    edge_id: edgeId,
    source_node_id: sourceNodeId,
    target_node_id: targetNodeId || null,
    relation_type: relationType,
    confidence: evidences.reduce((highest, entry) => Math.max(highest, entry?.confidence || 0), 0) || null,
    evidence_count: evidences.length || 1,
    first_seen_chapter: state.chapterId || null,
    last_seen_chapter: state.chapterId || null,
    reference_kinds: [state.referenceKind],
    evidences,
    updated_at: state.now,
  };
}

function addStoryGraphEdge(state, sourceNodeId, relationType, targetNodeId, evidence) {
  if (!sourceNodeId || !relationType) return;
  const edgeId = buildStoryGraphEdgeId(sourceNodeId, relationType, targetNodeId || null);
  const evidences = (Array.isArray(evidence) ? evidence : evidence ? [evidence] : []).filter(Boolean);
  const existing = state.edgeById.get(edgeId);
  if (existing) return mergeStoryGraphEdgeEvidence(existing, evidences);
  const nextEdge = createStoryGraphEdge(state, edgeId, sourceNodeId, relationType, targetNodeId, evidences);
  state.edgeById.set(edgeId, nextEdge);
  state.edges.push(nextEdge);
}

function addStoryGraphNodeRole(node, roleName) {
  if (!node || !roleName) return;
  const currentAttributes = node.attributes && typeof node.attributes === "object" ? node.attributes : {};
  const currentRoles = Array.isArray(currentAttributes.roles) ? currentAttributes.roles : [];
  node.attributes = {
    ...currentAttributes,
    roles: [...new Set([...currentRoles, roleName].filter(Boolean))],
  };
}

function resolveStoryGraphCharacterNode(characterNodes, value) {
  const needle = normalizeNodeName(value);
  const needleKey = normalizeIdentityKey(needle);
  if (!needleKey) return null;
  const candidates = [...characterNodes.values()].filter((node) => {
    const identityKeys = [node.canonical_name, ...(node.aliases || []), ...(node.source_terms || [])]
      .map(normalizeIdentityKey)
      .filter(Boolean);
    return identityKeys.some((key) => key === needleKey);
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function buildStoryGraphEvidences(entry, fallbackLine, fallbackConfidence, chapterId, referenceSetId) {
  const source =
    Array.isArray(entry?.evidences) && entry.evidences.length > 0
      ? entry.evidences
      : [
          {
            pageName: entry?.pageName || null,
            nodeId: entry?.nodeId || null,
            evidenceLine: entry?.evidenceLine || fallbackLine,
            textRole: entry?.textRole || null,
          },
        ];
  return source
    .map((item) => ({
      chapterId: chapterId || null,
      referenceSetId,
      pageName: item?.pageName || null,
      nodeId: item?.nodeId || null,
      line: normalizeNodeName(item?.evidenceLine) || fallbackLine,
      textRole: item?.textRole || null,
      confidence: entry?.confidence ?? fallbackConfidence,
    }))
    .filter((item) => item.line);
}

function resolveStoryGraphTermNode(termNodes, value) {
  const needle = normalizeNodeName(value);
  if (!needle) return null;
  return (
    termNodes.get(needle) ||
    [...termNodes.values()].find(
      (node) =>
        node.canonical_name === needle ||
        (node.aliases || []).includes(needle) ||
        (node.source_terms || []).includes(needle),
    ) ||
    null
  );
}

function buildStoryGraphResult(mangaId, chapterId, referenceSetId, now, nodes, edges) {
  return {
    metadata: {
      manga_id: mangaId,
      updated_at: now,
      source_reference_sets: [referenceSetId],
      source_chapters: chapterId ? [chapterId] : [],
      schema_version: 1,
    },
    nodes,
    edges,
    chapters: {
      [chapterId || "__global__"]: {
        chapterId: chapterId || null,
        referenceSetIds: [referenceSetId],
        nodeIds: nodes.map((node) => node.node_id),
        edgeIds: edges.map((edge) => edge.edge_id),
        updatedAt: now,
      },
    },
  };
}

function createStoryGraphState({ mangaId, chapterId, referenceSetId, referenceKind }, now) {
  return {
    mangaId,
    chapterId,
    referenceSetId,
    referenceKind,
    now,
    nodes: [],
    edges: [],
    nodeByKey: new Map(),
    edgeById: new Map(),
  };
}

function createStoryGraphOperations(state) {
  const characterNodes = new Map();
  const termNodes = new Map();
  return {
    characterNodes,
    termNodes,
    mentionNodeCache: new Map(),
    upsertNode: (type, name, attributes = {}, extra = {}) =>
      upsertStoryGraphNode(state, type, name, attributes, extra),
    addEdge: (sourceId, relationType, targetId, evidence) =>
      addStoryGraphEdge(state, sourceId, relationType, targetId, evidence),
    addRoleAttribute: addStoryGraphNodeRole,
    resolveCharacterNodeByName: (value) => resolveStoryGraphCharacterNode(characterNodes, value),
    resolveTermNodeByName: (value) => resolveStoryGraphTermNode(termNodes, value),
    buildGraphEvidences: (entry, line, confidence) =>
      buildStoryGraphEvidences(entry, line, confidence, state.chapterId, state.referenceSetId),
  };
}

function populateStoryGraph(chapterContext, operations, chapterId) {
  processStoryGraphCharacters(chapterContext, operations.upsertNode, operations.characterNodes);
  processStoryGraphTerms(chapterContext, operations.upsertNode, operations.termNodes);
  processStoryGraphMentions(chapterContext, operations);
  processStoryGraphEvents(
    chapterContext,
    operations.upsertNode,
    operations.addEdge,
    operations.resolveCharacterNodeByName,
    operations.buildGraphEvidences,
    chapterId,
  );
  processStoryGraphRelationships(chapterContext, operations);
}

function createStoryGraphFromContext({ mangaId, chapterId, referenceSetId, referenceKind = "source", chapterContext }) {
  const now = new Date().toISOString();
  const state = createStoryGraphState({ mangaId, chapterId, referenceSetId, referenceKind }, now);
  populateStoryGraph(chapterContext, createStoryGraphOperations(state), chapterId);
  return buildStoryGraphResult(mangaId, chapterId, referenceSetId, now, state.nodes, state.edges);
}

function mergeStoryGraphNodes(nodes, existingGraph, incomingGraph, now) {
  const nodeKey = (entry) => `${entry.node_type || "character"}::${entry.canonical_name || ""}`;
  for (const entry of existingGraph.nodes || []) nodes.set(nodeKey(entry), { ...entry });
  for (const entry of incomingGraph.nodes || []) {
    const key = nodeKey(entry);
    const current = nodes.get(key);
    if (!current) {
      nodes.set(key, { ...entry, updated_at: now });
      continue;
    }
    nodes.set(key, {
      ...current,
      aliases: [...new Set([...(current.aliases || []), ...(entry.aliases || [])])],
      source_terms: [...new Set([...(current.source_terms || []), ...(entry.source_terms || [])])],
      confidence: Math.max(current.confidence || 0, entry.confidence || 0) || null,
      first_seen_chapter: current.first_seen_chapter || entry.first_seen_chapter || null,
      last_seen_chapter: entry.last_seen_chapter || current.last_seen_chapter || null,
      reference_kinds: [...new Set([...(current.reference_kinds || []), ...(entry.reference_kinds || [])])],
      evidence_count: Math.max(current.evidence_count || 1, 1) + (entry.evidence_count || 1),
      attributes: {
        ...(current.attributes || {}),
        ...(entry.attributes || {}),
      },
      updated_at: now,
    });
  }
}

function mergeStoryGraphEdges(edges, existingGraph, incomingGraph, now) {
  const edgeKey = (entry) =>
    `${entry.source_node_id || ""}::${entry.relation_type || ""}::${entry.target_node_id || ""}`;
  for (const entry of existingGraph.edges || []) edges.set(edgeKey(entry), { ...entry });
  for (const entry of incomingGraph.edges || []) {
    const key = edgeKey(entry);
    const current = edges.get(key);
    if (!current) {
      edges.set(key, { ...entry, updated_at: now });
      continue;
    }
    const mergedEvidences = [...(current.evidences || []), ...(entry.evidences || [])].slice(-20);
    const evidenceCount = (current.evidence_count || 1) + (entry.evidence_count || 1);
    const chapterIds = new Set(mergedEvidences.map((evidence) => evidence && evidence.chapterId).filter(Boolean));
    const boostedConfidence =
      Math.max(current.confidence || 0, entry.confidence || 0) + Math.min(0.2, chapterIds.size * 0.04);
    edges.set(key, {
      ...current,
      confidence: Number(Math.min(0.99, boostedConfidence).toFixed(4)),
      evidence_count: evidenceCount,
      first_seen_chapter: current.first_seen_chapter || entry.first_seen_chapter || null,
      last_seen_chapter: entry.last_seen_chapter || current.last_seen_chapter || null,
      reference_kinds: [...new Set([...(current.reference_kinds || []), ...(entry.reference_kinds || [])])],
      evidences: mergedEvidences,
      updated_at: now,
    });
  }
}

function mergedStoryGraphChapter(existingGraph, incomingGraph, chapterId, referenceSetId, now) {
  const key = chapterId || "__global__";
  const existing = (existingGraph.chapters || {})[key] || {};
  const incoming = (incomingGraph.chapters || {})[key] || {};
  return {
    chapterId: chapterId || null,
    referenceSetIds: [...new Set([...(existing.referenceSetIds || []), ...(incoming.referenceSetIds || [])])],
    nodeIds: incomingGraph.nodes.map((node) => node.node_id),
    edgeIds: incomingGraph.edges.map((edge) => edge.edge_id),
    updatedAt: now,
  };
}

function sortedStoryGraphValues(values, key) {
  return [...values.values()].sort((left, right) => String(left[key] || "").localeCompare(String(right[key] || "")));
}

function buildStoryGraphMergeResult(existingGraph, incomingGraph, nodes, edges, chapterId, referenceSetId, now) {
  const chapterKey = chapterId || "__global__";
  return {
    metadata: {
      ...existingGraph.metadata,
      updated_at: now,
      source_reference_sets: [...new Set([...(existingGraph.metadata?.source_reference_sets || []), referenceSetId])],
      source_chapters: chapterId
        ? [...new Set([...(existingGraph.metadata?.source_chapters || []), chapterId])]
        : existingGraph.metadata?.source_chapters || [],
      schema_version: 1,
    },
    nodes: sortedStoryGraphValues(nodes, "canonical_name"),
    edges: sortedStoryGraphValues(edges, "relation_type"),
    chapters: {
      ...(existingGraph.chapters || {}),
      ...(incomingGraph.chapters || {}),
      [chapterKey]: mergedStoryGraphChapter(existingGraph, incomingGraph, chapterId, referenceSetId, now),
    },
  };
}

function mergeStoryGraph(existingGraph, incomingGraph, chapterId, referenceSetId) {
  const now = new Date().toISOString();
  const nodes = new Map();
  const edges = new Map();
  mergeStoryGraphNodes(nodes, existingGraph, incomingGraph, now);
  mergeStoryGraphEdges(edges, existingGraph, incomingGraph, now);
  return buildStoryGraphMergeResult(existingGraph, incomingGraph, nodes, edges, chapterId, referenceSetId, now);
}
function buildSocialNodes(storyNodes, now) {
  const socialNodeMap = new Map();
  for (const node of storyNodes.filter((entry) => entry.node_type === "character")) {
    socialNodeMap.set(node.node_id, {
      node_id: node.node_id,
      node_type: "character",
      canonical_name: node.canonical_name,
      aliases: node.aliases || [],
      source_terms: node.source_terms || [],
      confidence: node.confidence || null,
      first_seen_chapter: node.first_seen_chapter || null,
      last_seen_chapter: node.last_seen_chapter || null,
      reference_kinds: node.reference_kinds || [],
      evidence_count: node.evidence_count || 1,
      attributes: node.attributes || {},
      updated_at: now,
    });
  }
  return socialNodeMap;
}

function resolveSocialEdge(edge, storyNodeMap) {
  const sourceNode = storyNodeMap.get(edge.source_node_id);
  const targetNode = edge.target_node_id ? storyNodeMap.get(edge.target_node_id) : null;
  if (sourceNode?.node_type !== "character" || targetNode?.node_type !== "character" || !edge.relation_type) return null;
  return { sourceNode, targetNode, relationType: edge.relation_type };
}

function createSocialEdge(edge, resolved, socialEdgeId, chapterId, now) {
  const evidence = Array.isArray(edge.evidences) ? edge.evidences : [];
  return {
    edge_id: socialEdgeId, source_node_id: resolved.sourceNode.node_id,
    target_node_id: resolved.targetNode.node_id, relation_type: resolved.relationType,
    confidence: edge.confidence || null, evidence_count: evidence.length || edge.evidence_count || 1,
    first_seen_chapter: edge.first_seen_chapter || chapterId || null,
    last_seen_chapter: edge.last_seen_chapter || chapterId || null,
    reference_kinds: edge.reference_kinds || [], evidences: evidence.slice(-20), updated_at: now,
  };
}

function mergeSocialEdge(existing, edge, now) {
  const incoming = Array.isArray(edge.evidences) ? edge.evidences : [];
  return {
    ...existing,
    confidence: Math.max(existing.confidence || 0, edge.confidence || 0) || null,
    evidence_count: (existing.evidence_count || 0) + (incoming.length || edge.evidence_count || 1),
    last_seen_chapter: edge.last_seen_chapter || existing.last_seen_chapter || null,
    reference_kinds: [...new Set([...(existing.reference_kinds || []), ...(edge.reference_kinds || [])])],
    evidences: [...(existing.evidences || []), ...incoming].slice(-20),
    updated_at: now,
  };
}

function processSocialEdges(storyEdges, storyNodeMap, socialEdgeMap, chapterId, now) {
  for (const edge of storyEdges) {
    const resolved = resolveSocialEdge(edge, storyNodeMap);
    if (!resolved) continue;
    const socialEdgeId = buildStoryGraphEdgeId(
      resolved.sourceNode.node_id, resolved.relationType, resolved.targetNode.node_id,
    );
    const existing = socialEdgeMap.get(socialEdgeId);
    const next = existing ? mergeSocialEdge(existing, edge, now) : createSocialEdge(edge, resolved, socialEdgeId, chapterId, now);
    socialEdgeMap.set(socialEdgeId, next);
  }
}

function buildSocialGraphResult(storyGraph, socialNodeMap, socialEdgeMap, mangaId, chapterId, referenceSetId, now) {
  return {
    metadata: {
      manga_id: mangaId || storyGraph?.metadata?.manga_id || null,
      updated_at: now,
      source_reference_sets: [
        ...new Set(
          [...(storyGraph?.metadata?.source_reference_sets || []).filter(Boolean), referenceSetId].filter(Boolean),
        ),
      ],
      source_chapters: [
        ...new Set([...(storyGraph?.metadata?.source_chapters || []).filter(Boolean), chapterId].filter(Boolean)),
      ],
      schema_version: 1,
      derived_from: "story_graph",
    },
    nodes: [...socialNodeMap.values()].sort((left, right) =>
      String(left.canonical_name || "").localeCompare(String(right.canonical_name || "")),
    ),
    edges: [...socialEdgeMap.values()].sort((left, right) =>
      String(left.relation_type || "").localeCompare(String(right.relation_type || "")),
    ),
    chapters: { ...(storyGraph?.chapters || {}) },
  };
}

function deriveSocialGraphFromStoryGraph(storyGraph, { mangaId, chapterId = null, referenceSetId = null } = {}) {
  const now = new Date().toISOString();
  const storyNodes = Array.isArray(storyGraph?.nodes) ? storyGraph.nodes : [];
  const storyEdges = Array.isArray(storyGraph?.edges) ? storyGraph.edges : [];
  const storyNodeMap = new Map(storyNodes.map((node) => [node.node_id, node]));
  const socialNodeMap = buildSocialNodes(storyNodes, now);
  const socialEdgeMap = new Map();
  processSocialEdges(storyEdges, storyNodeMap, socialEdgeMap, chapterId, now);
  return buildSocialGraphResult(storyGraph, socialNodeMap, socialEdgeMap, mangaId, chapterId, referenceSetId, now);
}
function finiteNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function collectStyleVotes(chapters, evidenceKey, valueKey) {
  const votes = new Map();
  let totalSampleSize = 0;
  for (const chapter of chapters) {
    const evidence = Array.isArray(chapter?.[evidenceKey]) ? chapter[evidenceKey][0] : null;
    if (!evidence || evidence[valueKey] === undefined || evidence[valueKey] === null) continue;
    const sampleSize = Math.max(1, finiteNumber(evidence.sampleSize, 1));
    const confidence = Math.max(0, Math.min(1, finiteNumber(evidence.confidence, 0)));
    totalSampleSize += sampleSize;
    const key = JSON.stringify(evidence[valueKey]);
    const current = votes.get(key) || {
      value: evidence[valueKey],
      weight: 0,
      chapters: 0,
    };
    current.weight += confidence * sampleSize;
    if (confidence > 0) current.chapters += 1;
    votes.set(key, current);
  }
  return { votes, totalSampleSize };
}

function aggregateStyleChoice(
  chapters,
  evidenceKey,
  valueKey,
  { minimumConfidence = 0.6, minimumSupportingChapters = 2 } = {},
) {
  const { votes, totalSampleSize } = collectStyleVotes(chapters, evidenceKey, valueKey);
  const winner = [...votes.values()].sort((left, right) => right.weight - left.weight)[0] || null;
  const score = winner && totalSampleSize > 0 ? winner.weight / totalSampleSize : 0;
  const resolved = Boolean(winner && score >= minimumConfidence && winner.chapters >= minimumSupportingChapters);
  return {
    value: resolved ? winner.value : null,
    score: Number(score.toFixed(4)),
    supportChapters: winner?.chapters || 0,
    totalChapters: chapters.length,
    sampleSize: totalSampleSize,
    resolved,
  };
}

function aggregateDialogueNarration(chapters) {
  const totals = { dialogueRatio: 0, narrationRatio: 0, monologueRatio: 0 };
  let totalWeight = 0;
  for (const chapter of chapters) {
    const evidence = Array.isArray(chapter?.dialogueNarrationEvidence) ? chapter.dialogueNarrationEvidence[0] : null;
    if (!evidence) continue;
    const weight = Math.max(1, finiteNumber(evidence.sampleSize, 1));
    totalWeight += weight;
    for (const key of Object.keys(totals)) totals[key] += finiteNumber(evidence[key], 0) * weight;
  }
  return {
    rules: Object.fromEntries(
      Object.entries(totals).map(([key, value]) => [
        key,
        totalWeight > 0 ? Number((value / totalWeight).toFixed(4)) : 0,
      ]),
    ),
    confidence: {
      method: "sample_size_weighted_mean",
      chapterCount: chapters.length,
      sampleSize: totalWeight,
      resolved: totalWeight > 0,
    },
  };
}

function collectStyleSamples(chapters, key, limit = 10) {
  return [...new Set(
    chapters.flatMap((chapter) => (Array.isArray(chapter?.[key]) ? chapter[key] : [])),
  )].slice(-limit);
}

function buildStyleRules(register, honorifics, fullWidth, dialogueNarration) {
  return {
    register: register.value || "unknown",
    preserveHonorifics: honorifics.value,
    punctuation: { preferFullWidth: fullWidth.value, ellipsis: null, quoteStyle: null },
    dialogueNarration: dialogueNarration.rules,
    sentenceLength: "unknown",
  };
}

function buildStyleProfileContent(chapters) {
  const register = aggregateStyleChoice(chapters, "registerEvidence", "register");
  const honorifics = aggregateStyleChoice(chapters, "honorificEvidence", "preserveHonorifics");
  const fullWidth = aggregateStyleChoice(chapters, "punctuationEvidence", "preferFullWidth");
  const dialogueNarration = aggregateDialogueNarration(chapters);
  return {
    rules: buildStyleRules(register, honorifics, fullWidth, dialogueNarration),
    confidence: {
      register,
      preserveHonorifics: honorifics,
      punctuation: { preferFullWidth: fullWidth },
      dialogueNarration: dialogueNarration.confidence,
    },
    samples: {
      dialogue: collectStyleSamples(chapters, "dialogueSamples"),
      narration: collectStyleSamples(chapters, "narrationSamples"),
      monologue: collectStyleSamples(chapters, "monologueSamples"),
      honorifics: [],
    },
  };
}

function buildStyleProfileFromEvidence(mangaId, styleEvidence) {
  const chapters = Object.values(styleEvidence?.chapters || {}).filter(
    (chapter) => chapter?.referenceKind === "translator" && chapter?.targetStyleAllowed === true,
  );
  return {
    metadata: {
      manga_id: mangaId,
      updated_at: new Date().toISOString(),
      source_reference_sets: styleEvidence?.metadata?.source_reference_sets || [],
      source_chapters: styleEvidence?.metadata?.source_chapters || [],
    },
    ...buildStyleProfileContent(chapters),
  };
}

function defaultStyleEvidenceChapter(chapterId, referenceKind, now) {
  return {
    chapterId: chapterId || null, referenceKind, referenceSetIds: [],
    targetStyleAllowed: referenceKind === "translator", registerEvidence: [], punctuationEvidence: [],
    honorificEvidence: [], dialogueNarrationEvidence: [], dialogueSamples: [], narrationSamples: [],
    monologueSamples: [], characterSpeech: [], notes: [], updatedAt: now,
  };
}

function mergeStyleEvidenceChapter(current, incoming, chapterId, referenceSetId, referenceKind, now) {
  return {
    ...current,
    chapterId: chapterId || current.chapterId || null,
    referenceKind: current.referenceKind || referenceKind,
    referenceSetIds: [...new Set([...(current.referenceSetIds || []), referenceSetId])],
    targetStyleAllowed: current.targetStyleAllowed === true || incoming.targetStyleAllowed === true,
    registerEvidence: [...(incoming.registerEvidence || [])].slice(-8),
    punctuationEvidence: [...(incoming.punctuationEvidence || [])].slice(-8),
    honorificEvidence: [...(incoming.honorificEvidence || [])].slice(-8),
    dialogueNarrationEvidence: [...(incoming.dialogueNarrationEvidence || [])].slice(-8),
    dialogueSamples: [...new Set(incoming.dialogueSamples || [])].slice(0, 8),
    narrationSamples: [...new Set(incoming.narrationSamples || [])].slice(0, 8),
    monologueSamples: [...new Set(incoming.monologueSamples || [])].slice(0, 8),
    characterSpeech: Array.isArray(incoming.characterSpeech) ? incoming.characterSpeech.slice(0, 12) : [],
    notes: [...new Set(incoming.notes || [])].slice(0, 12),
    updatedAt: now,
  };
}

function mergeStyleEvidenceMetadata(existing, chapterId, referenceSetId, now) {
  return {
    ...existing,
    updated_at: now,
    source_reference_sets: [...new Set([...(existing?.source_reference_sets || []), referenceSetId])],
    source_chapters: chapterId
      ? [...new Set([...(existing?.source_chapters || []), chapterId])]
      : existing?.source_chapters || [],
  };
}

function mergeStyleEvidence(
  existingEvidence,
  incomingEvidence,
  chapterId,
  referenceSetId,
  referenceKind = "translator",
) {
  const now = new Date().toISOString();
  const chapters = { ...(existingEvidence.chapters || {}) };
  const chapterKey = chapterId || "__global__";
  const current = chapters[chapterKey] || defaultStyleEvidenceChapter(chapterId, referenceKind, now);
  chapters[chapterKey] = mergeStyleEvidenceChapter(
    current, incomingEvidence, chapterId, referenceSetId, referenceKind, now,
  );
  return {
    metadata: mergeStyleEvidenceMetadata(existingEvidence.metadata, chapterId, referenceSetId, now),
    chapters,
  };
}

function uniqueByName(entries) {
  const seen = new Set();
  const output = [];
  for (const entry of entries) {
    const key = entry && entry.name;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(entry);
  }
  return output;
}

function uniqueByTerm(entries) {
  const seen = new Set();
  const output = [];
  for (const entry of entries) {
    const key =
      (entry && (entry.sourceTerm || entry.source_term || entry.term)) ||
      (entry && entry.canonical_form) ||
      (entry && entry.canonical_translation);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(entry);
  }
  return output;
}

function uniqueStoryItems(entries, keyBuilder) {
  const seen = new Set();
  const output = [];
  for (const entry of entries || []) {
    const key = keyBuilder(entry || {});
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(entry);
  }
  return output;
}

function loadKnowledgeBaseForFallback(mangaId, translatorId = null) {
  const { knowledgeBasePath } = resolveKnowledgePaths({
    mangaId,
    translatorId,
  });
  if (!mangaId || !fs.existsSync(knowledgeBasePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(knowledgeBasePath, "utf-8"));
}

function selectTranslationGlossaryEntries(glossary, glossaryMode) {
  if (glossaryMode === "canonical") return glossary.entries || [];
  if (glossaryMode === "reference_only") {
    return (glossary.entries || []).filter((entry) => entry.source === "reference");
  }
  return [];
}

function inferTranslationTerminology(fallbackKnowledge, glossaryEntries, glossaryMode) {
  if (glossaryMode === "disabled") return [];
  return ((fallbackKnowledge && fallbackKnowledge.terminology) || []).filter(
    (entry) => !glossaryEntries.some(
      (glossaryEntry) => glossaryEntry.canonical_translation === entry.translation
        || glossaryEntry.canonical_translation === entry.term,
    ),
  );
}

function mapChapterTermIdentity(entry) {
  const sourceTerm = entry.sourceTerm || entry.source_term || entry.term || null;
  const canonicalForm = entry.canonicalForm || entry.canonical_form || sourceTerm;
  const targetRendering = Object.prototype.hasOwnProperty.call(entry || {}, "targetRendering")
    ? entry.targetRendering
    : Object.prototype.hasOwnProperty.call(entry || {}, "target_rendering")
      ? entry.target_rendering
      : entry.canonicalTranslation || entry.canonical_translation || entry.term || null;
  return {
    sourceTerm,
    canonicalForm,
    targetRendering,
    canonicalTranslation: entry.canonicalTranslation || entry.canonical_translation || entry.term || null,
    category: entry.category || null,
  };
}

function buildChapterLocalContext(chapterLocal, chapterId) {
  if (!chapterLocal) {
    return { chapterId: chapterId || null, characters: [], terminology: [], keyLines: [], referenceSetIds: [], terminologyIdentityMap: [] };
  }
  return {
    chapterId: chapterLocal.chapterId,
    characters: chapterLocal.characters || [],
    terminology: chapterLocal.terminology || [],
    keyLines: chapterLocal.keyLines || [],
    referenceSetIds: chapterLocal.referenceSetIds || [],
    terminologyIdentityMap: (chapterLocal.terminology || []).map(mapChapterTermIdentity),
  };
}

function mapGlossaryIdentityEntry(entry) {
  return {
    identityKey: entry.identity_key || null,
    entityType: entry.entity_type || null,
    referenceKind: entry.reference_kind || null,
    sourceTerm: entry.source_term || null,
    canonicalForm: entry.canonical_form || entry.source_term || entry.canonical_translation || null,
    sourceAliases: entry.source_aliases || [],
    category: entry.category || null,
  };
}

function mapGlossaryCanonicalEntry(entry) {
  return {
    identityKey: entry.identity_key || null,
    entityType: entry.entity_type || null,
    referenceKind: entry.reference_kind || null,
    canonicalForm: entry.canonical_form || entry.source_term || entry.canonical_translation || null,
    targetRendering: Object.prototype.hasOwnProperty.call(entry || {}, "target_rendering")
      ? entry.target_rendering
      : entry.canonical_translation || null,
    canonicalTranslation: entry.canonical_translation || null,
    aliases: entry.aliases || [],
    locked: entry.locked === true,
  };
}

function summarizeStyleEvidence(styleEvidence) {
  const metadata = styleEvidence && typeof styleEvidence === "object" ? styleEvidence.metadata : null;
  if (!metadata || typeof metadata !== "object") return null;
  return {
    chapters: Array.isArray(metadata.source_chapters) ? metadata.source_chapters.length : 0,
    referenceSets: Array.isArray(metadata.source_reference_sets) ? metadata.source_reference_sets.length : 0,
  };
}

function buildMangaGlobalContext(glossaryEntries, inferredTerminology, storyContext, styleProfile, styleEvidence) {
  return {
    glossary: glossaryEntries,
    fallbackTerminology: inferredTerminology,
    stableCharacters: storyContext.global?.characters || [],
    stableTerminology: storyContext.global?.terminology || [],
    identityLayer: { terminology: glossaryEntries.map(mapGlossaryIdentityEntry) },
    canonicalLayer: { terminology: glossaryEntries.map(mapGlossaryCanonicalEntry) },
    styleRenderingLayer: {
      terminology: glossaryEntries.map((entry) => ({
        identityKey: entry.identity_key || null,
        renderingHints: entry.rendering_hints || {},
      })),
      constraints: styleProfile.rules || {},
      evidenceSummary: summarizeStyleEvidence(styleEvidence),
    },
  };
}

function buildTranslationContext({ mangaId, translatorId = null, chapterId = null, glossaryMode = "canonical" }) {
  if (!mangaId) return null;
  const glossary = loadCanonicalGlossary(mangaId, translatorId);
  const storyContext = loadStoryContext(mangaId, translatorId);
  const styleProfile = loadStyleProfile(mangaId, translatorId);
  const styleEvidence = loadStyleEvidence(mangaId, translatorId);
  const fallbackKnowledge = loadKnowledgeBaseForFallback(mangaId, translatorId);
  const chapterLocal = storyContext.chapters[chapterId || "__global__"] || null;
  const glossaryEntries = selectTranslationGlossaryEntries(glossary, glossaryMode);
  const inferredTerminology = inferTranslationTerminology(fallbackKnowledge, glossaryEntries, glossaryMode);
  return {
    mangaId,
    translatorId,
    chapterId: chapterId || null,
    glossaryMode,
    generatedAt: new Date().toISOString(),
    chapterLocal: buildChapterLocalContext(chapterLocal, chapterId),
    mangaGlobal: buildMangaGlobalContext(
      glossaryEntries, inferredTerminology, storyContext, styleProfile, styleEvidence,
    ),
    styleConstraints: styleProfile.rules || {},
  };
}
function appendPromptEntries(lines, title, entries, limit, formatter) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  lines.push(title);
  for (const entry of entries.slice(0, limit)) lines.push(formatter(entry));
}

function glossaryPromptLine(entry) {
  const aliases = entry.aliases?.length ? ` (aliases: ${entry.aliases.join(", ")})` : "";
  return `- [${entry.category}] ${entry.source_term || entry.canonical_translation} => ${entry.canonical_translation}${aliases}`;
}

function appendTranslationPromptSections(lines, context) {
  appendPromptEntries(lines, "Canonical glossary:", context.mangaGlobal.glossary, 40, glossaryPromptLine);
  appendPromptEntries(lines, "Term identity layer:", context.mangaGlobal.identityLayer?.terminology, 20,
    (entry) => `- ${entry.sourceTerm || "(unknown)"} [${entry.category || "general_term"}]`);
  appendPromptEntries(lines, "Fallback inferred terminology:", context.mangaGlobal.fallbackTerminology, 20,
    (entry) => `- ${entry.translation || entry.term}`);
  appendPromptEntries(lines, "Chapter-local characters:", context.chapterLocal.characters, 20,
    (entry) => `- ${entry.name}`);
  appendPromptEntries(lines, "Chapter-local term mappings:", context.chapterLocal.terminologyIdentityMap, 20,
    (entry) => `- ${entry.sourceTerm || "(unknown)"} => ${entry.canonicalTranslation || "(unset)"}`);
  appendPromptEntries(lines, "Recent chapter context lines:", context.chapterLocal.keyLines, 8,
    (line) => `- ${line}`);
}

function appendStylePrompt(lines, style) {
  lines.push("Style constraints:");
  if (style.register && style.register !== "unknown") lines.push(`- register: ${style.register}`);
  if (typeof style.preserveHonorifics === "boolean") {
    lines.push(`- preserve honorifics: ${style.preserveHonorifics ? "yes" : "no"}`);
  }
  const punctuation = style.punctuation;
  if (!punctuation || !Object.values(punctuation).some((value) => value !== null && value !== undefined)) return;
  lines.push(
    `- punctuation: full-width=${punctuation.preferFullWidth ?? "unknown"}, ellipsis=${punctuation.ellipsis || "default"}, quoteStyle=${punctuation.quoteStyle || "unknown"}`,
  );
}

function formatTranslationSystemPrompt(context) {
  if (!context) return null;
  const lines = [
    "You are translating a manga chapter into Traditional Chinese.",
    "Follow the canonical glossary first, then preserve chapter-local context, then follow the style constraints.",
  ];
  appendTranslationPromptSections(lines, context);
  appendStylePrompt(lines, context.styleConstraints || {});
  return lines.join("\\n");
}
module.exports = {
  buildTranslationContext,
  defaultCanonicalGlossary,
  defaultCandidateTerms,
  defaultStyleEvidence,
  defaultStoryContext,
  defaultStoryGraph,
  defaultSocialGraph,
  defaultStyleProfile,
  formatTranslationSystemPrompt,
  loadCanonicalGlossary,
  loadCandidateTerms,
  loadKnowledgeBase,
  loadStyleEvidence,
  loadStoryContext,
  loadStoryGraph,
  loadSocialGraph,
  loadStyleProfile,
  loadTranslationContext,
  mergeCanonicalGlossary,
  mergeCandidateTerms,
  mergeStyleEvidence,
  mergeStoryContext,
  mergeStoryGraph,
  buildStyleProfileFromEvidence,
  createStoryGraphFromContext,
  deriveSocialGraphFromStoryGraph,
  normalizeGlossaryEntry,
  stableId,
  writeCanonicalGlossary,
  writeCandidateTerms,
  writeStyleEvidence,
  writeStoryContext,
  writeStoryGraph,
  writeSocialGraph,
  writeStyleProfile,
  writeTranslationContext,
};
