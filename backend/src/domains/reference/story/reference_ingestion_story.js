function resolveReferenceSourceText(textNode) {
  return String(textNode?.sourceText || textNode?.originalText || textNode?.text || "").trim();
}

function resolveReferenceTranslatedText(textNode) {
  return String(textNode?.translatedText || textNode?.targetText || textNode?.translation || "").trim();
}

function isNoiseReferenceLine(line) {
  const value = String(line || "").trim();
  if (!value) {
    return true;
  }
  if (/manga\d+\.com|manhuagui|bilibili|copyright/i.test(value)) {
    return true;
  }
  if (/(无断转载|無断転載|扫描|掃描|汉化|漢化|翻译组|翻譯組|仅供试看|僅供試看)/u.test(value)) {
    return true;
  }
  if (/^page\s*\d+$/iu.test(value)) {
    return true;
  }
  if (/^[\p{P}\p{S}\s_]+$/u.test(value)) {
    return true;
  }
  if (value.length <= 1) {
    return true;
  }
  if (!/[\p{L}\p{N}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)) {
    return true;
  }
  return false;
}

function collectReferenceLines(texts, { preferTranslated = true, filterNoise = false } = {}) {
  const lines = [];
  for (const page of texts.pages || []) {
    for (const textNode of page.texts || []) {
      const translatedText = resolveReferenceTranslatedText(textNode);
      const sourceText = resolveReferenceSourceText(textNode);
      const primary = preferTranslated ? translatedText || sourceText : sourceText || translatedText;
      const normalized = String(primary || "").trim();
      if (!normalized) {
        continue;
      }
      if (filterNoise && isNoiseReferenceLine(normalized)) {
        continue;
      }
      lines.push(normalized);
    }
  }
  return lines;
}

function normalizeStoryLine(line) {
  return String(line || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEventDedupKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectEventAnchors(entry) {
  const parts = [
    String(entry?.summary || "").trim(),
    String(entry?.evidenceLine || "").trim(),
    ...(Array.isArray(entry?.participants) ? entry.participants.map((value) => String(value || "").trim()) : []),
  ].filter(Boolean);
  return normalizeEventDedupKey(parts.join(" "));
}

function filterStoryEvents(entries = []) {
  const deduped = [];
  const seen = new Set();

  for (const entry of entries || []) {
    const summary = String(entry?.summary || "").trim();
    const evidenceLine = String(entry?.evidenceLine || "").trim();
    if (!summary) {
      continue;
    }
    const key = collectEventAnchors({ ...entry, summary, evidenceLine }) || `${summary}::${evidenceLine}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({
      ...entry,
      summary,
      evidenceLine,
    });
  }

  return deduped.sort((left, right) => (right.confidence || 0) - (left.confidence || 0)).slice(0, 4);
}

function collectCharacterAliases(entry) {
  return [
    ...(Array.isArray(entry.aliases) ? entry.aliases : []),
    ...(Array.isArray(entry.title_forms) ? entry.title_forms : []),
    ...(Array.isArray(entry.titleForms) ? entry.titleForms : []),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function buildNormalizedCharacterEntry(entry, current) {
  const aliases = collectCharacterAliases(entry);
  const titleForms = [
    ...(Array.isArray(entry.title_forms) ? entry.title_forms : []),
    ...(Array.isArray(entry.titleForms) ? entry.titleForms : []),
  ].filter(Boolean);
  return {
    ...entry,
    name: String(entry.name || entry.source_name || entry.source_term || "").trim(),
    aliases: [...new Set(aliases)],
    title_forms: [...new Set(titleForms)],
    confidence: Math.max(entry.confidence || 0, current?.confidence || 0),
    mentionCount: Math.max(
      current?.mentionCount || 0,
      Array.isArray(entry.example_lines) ? entry.example_lines.length : 0,
    ),
  };
}

function normalizeChapterCharacterEntries(extractedCharacterEntries) {
  const merged = new Map();
  for (const entry of extractedCharacterEntries || []) {
    const name = String(entry.name || entry.source_name || entry.source_term || "").trim();
    if (!name) continue;
    const current = merged.get(name);
    const next = buildNormalizedCharacterEntry({ ...entry, name }, current);
    merged.set(name, current ? { ...current, ...next } : next);
  }
  return [...merged.values()].sort((left, right) => (right.mentionCount || 0) - (left.mentionCount || 0));
}

function normalizeObservedMentionEntries(entries = []) {
  return (entries || [])
    .map((entry) => ({
      entityType: String(entry?.entityType || "term").trim() || "term",
      surfaceForm: String(entry?.surfaceForm || "").trim(),
      canonicalForm: String(entry?.canonicalForm || "").trim(),
      pageName: entry?.pageName || null,
      nodeId: entry?.nodeId || null,
      confidence: Number.isFinite(entry?.confidence) ? entry.confidence : null,
      evidenceLine: String(entry?.evidenceLine || "").trim(),
      notes: entry?.notes || "",
      textRole: entry?.textRole || null,
      styleChannel: entry?.styleChannel || null,
      speakerRef: entry?.speakerRef || null,
    }))
    .filter((entry) => entry.surfaceForm || entry.canonicalForm || entry.evidenceLine);
}

function buildObservedRelationEvidences(entry) {
  if (!Array.isArray(entry?.evidences)) return [];
  return entry.evidences
    .map((evidence) => ({
      pageName: evidence?.pageName || null,
      nodeId: evidence?.nodeId || null,
      evidenceLine: String(evidence?.evidenceLine || "").trim(),
      textRole: evidence?.textRole || null,
    }))
    .filter((evidence) => evidence.pageName && evidence.nodeId && evidence.evidenceLine);
}

function buildObservedRelationEntry(entry) {
  const subject = String(entry?.subject || "").trim() || null;
  const object = String(entry?.object || "").trim() || null;
  const relationType = String(entry?.relationType || "related_to").trim() || "related_to";
  const evidences = buildObservedRelationEvidences(entry);
  return {
    term: relationType,
    relationType,
    subject,
    object,
    subjectCandidates: subject ? [subject] : [],
    objectCandidates: object ? [object] : [],
    summary:
      subject || object
        ? `${subject || "?"} / ${object || "?"} :: ${relationType}`
        : String(entry?.evidenceLine || "").trim(),
    evidenceLine: String(entry?.evidenceLine || "").trim(),
    evidences,
    confidence: Number.isFinite(entry?.confidence) ? entry.confidence : null,
    notes: entry?.notes || "",
    pageName: entry?.pageName || null,
    nodeId: entry?.nodeId || null,
    textRole: entry?.textRole || null,
    styleChannel: entry?.styleChannel || null,
    speakerRef: entry?.speakerRef || null,
  };
}

function normalizeObservedRelationEntries(entries = []) {
  return (entries || [])
    .map((entry) => buildObservedRelationEntry(entry))
    .filter((entry) => entry.evidenceLine || entry.subject || entry.object);
}

function normalizeObservedEventEntries(entries = []) {
  return (entries || [])
    .map((entry) => ({
      summary: String(entry?.summary || "").trim(),
      evidenceLine: String(entry?.evidenceLine || "").trim(),
      evidences: Array.isArray(entry?.evidences)
        ? entry.evidences
            .map((evidence) => ({
              pageName: evidence?.pageName || null,
              nodeId: evidence?.nodeId || null,
              evidenceLine: String(evidence?.evidenceLine || "").trim(),
              textRole: evidence?.textRole || null,
            }))
            .filter((evidence) => evidence.pageName && evidence.nodeId && evidence.evidenceLine)
        : [],
      confidence: Number.isFinite(entry?.confidence) ? entry.confidence : null,
      pageName: entry?.pageName || null,
      nodeId: entry?.nodeId || null,
      participants: Array.isArray(entry?.participants) ? entry.participants.filter(Boolean) : [],
      notes: entry?.notes || "",
      textRole: entry?.textRole || null,
      styleChannel: entry?.styleChannel || null,
      speakerRef: entry?.speakerRef || null,
    }))
    .filter((entry) => entry.summary);
}

function normalizeObservedKeyLineEntries(entries = []) {
  return (entries || [])
    .map((entry) => ({
      text: String(entry?.text || "").trim(),
      kind: String(entry?.kind || "terminology").trim() || "terminology",
      confidence: Number.isFinite(entry?.confidence) ? entry.confidence : null,
      pageName: entry?.pageName || null,
      nodeId: entry?.nodeId || null,
      notes: entry?.notes || "",
      textRole: entry?.textRole || null,
      styleChannel: entry?.styleChannel || null,
      speakerRef: entry?.speakerRef || null,
    }))
    .filter((entry) => entry.text);
}

function getGlossaryEntries(glossary) {
  return Array.isArray(glossary?.entries) ? glossary.entries : [];
}

function getCandidateEntries(candidateTerms) {
  return Array.isArray(candidateTerms?.entries) ? candidateTerms.entries : [];
}

function getStoryChapters(storyContext) {
  if (!storyContext?.chapters || typeof storyContext.chapters !== "object") return [];
  return Object.entries(storyContext.chapters).map(([chapterKey, chapter]) => ({
    chapterKey,
    ...chapter,
  }));
}

function countAcceptedGlossary(glossaryEntries) {
  return {
    acceptedTerminology: glossaryEntries.filter((entry) => entry.category !== "character_name").length,
    acceptedCharacters: glossaryEntries.filter((entry) => entry.category === "character_name").length,
  };
}

function countCandidateTerms(candidateEntries) {
  return {
    candidateTerminology: candidateEntries.filter(
      (entry) => (entry.kind === "term" || entry.entity_type === "term") && entry.status === "candidate",
    ).length,
    candidateCharacters: candidateEntries.filter(
      (entry) => (entry.kind === "character" || entry.entity_type === "character") && entry.status === "candidate",
    ).length,
    rejectedEntries: candidateEntries.filter((entry) => entry.status === "rejected").length,
  };
}

function buildStorySummary(storyChapters) {
  return storyChapters.reduce(
    (summary, chapter) => {
      summary.chapters.push({
        chapterId: chapter.chapterId || null,
        referenceSetIds: Array.isArray(chapter.referenceSetIds) ? chapter.referenceSetIds : [],
        characterCount: Array.isArray(chapter.characters) ? chapter.characters.length : 0,
        terminologyCount: Array.isArray(chapter.terminology) ? chapter.terminology.length : 0,
        mentionCount: Array.isArray(chapter.mentions) ? chapter.mentions.length : 0,
        relationshipCount: Array.isArray(chapter.relationships) ? chapter.relationships.length : 0,
        eventCount: Array.isArray(chapter.events) ? chapter.events.length : 0,
        keyLineCount: Array.isArray(chapter.keyLines) ? chapter.keyLines.length : 0,
      });
      summary.mentions += Array.isArray(chapter.mentions) ? chapter.mentions.length : 0;
      summary.relationships += Array.isArray(chapter.relationships) ? chapter.relationships.length : 0;
      summary.events += Array.isArray(chapter.events) ? chapter.events.length : 0;
      summary.keyLines += Array.isArray(chapter.keyLines) ? chapter.keyLines.length : 0;
      return summary;
    },
    { chapters: [], mentions: 0, relationships: 0, events: 0, keyLines: 0 },
  );
}

function buildStyleCounts(styleEvidence) {
  const hasChapters = styleEvidence?.chapters && typeof styleEvidence.chapters === "object";
  const chapters = hasChapters ? Object.values(styleEvidence.chapters) : [];
  const styleChapterCount = hasChapters ? Object.keys(styleEvidence.chapters).length : 0;
  const dialogueSamples = chapters.reduce((count, chapter) => {
    const samples =
      chapter && typeof chapter === "object" && Array.isArray(chapter.dialogueSamples) ? chapter.dialogueSamples : [];
    return count + samples.filter(Boolean).length;
  }, 0);
  const narrationSamples = chapters.reduce((count, chapter) => {
    const samples =
      chapter && typeof chapter === "object" && Array.isArray(chapter.narrationSamples) ? chapter.narrationSamples : [];
    return count + samples.filter(Boolean).length;
  }, 0);
  return { styleChapterCount, dialogueSamples, narrationSamples };
}

function buildSourceStatsObject(rawLineCount, cleanLineCount) {
  return {
    rawLineCount,
    cleanLineCount,
    filteredNoiseCount: Math.max(0, rawLineCount - cleanLineCount),
  };
}

function buildObservationSummaryObject(chapterObservation) {
  if (!chapterObservation) return null;
  return {
    revisionId: chapterObservation.revisionId,
    nodeCount: chapterObservation.coverage?.observedNodes || chapterObservation.nodes?.length || 0,
    mentionCount: chapterObservation.mentions?.length || 0,
    storyCueCount: chapterObservation.storyCues?.length || 0,
    coverage: chapterObservation.coverage || null,
  };
}

function buildLatestRunObject({
  referenceSetId,
  chapterId,
  chapterTitle,
  manifestLabel,
  referenceKind,
  analysisDepth,
  rawLineCount,
  cleanLineCount,
  candidateSummary,
  chapterObservation,
}) {
  return {
    referenceSetId,
    chapterId: chapterId || null,
    chapterTitle: chapterTitle || null,
    manifestLabel: manifestLabel || null,
    referenceKind,
    analysisDepth,
    sourceStats: buildSourceStatsObject(rawLineCount, cleanLineCount),
    candidateSummary,
    observationRevisionId: chapterObservation?.revisionId || null,
  };
}

function buildAggregateSummaryObject(input) {
  const { glossaryEntries, accepted, candidateCounts, storyChapters, storySummary,
    referenceKind, styleCounts, styleProfile, chapterObservation } = input;
  return {
    glossaryEntries: glossaryEntries.length,
    acceptedTerminology: accepted.acceptedTerminology,
    acceptedCharacters: accepted.acceptedCharacters,
    candidateTerms: candidateCounts.candidateTerminology,
    candidateCharacters: candidateCounts.candidateCharacters,
    rejectedEntries: candidateCounts.rejectedEntries,
    storyChapters: storyChapters.length,
    storyMentions: referenceKind === "source" ? storySummary.mentions : 0,
    storyRelationships: referenceKind === "source" ? storySummary.relationships : 0,
    storyEvents: referenceKind === "source" ? storySummary.events : 0,
    storyKeyLines: referenceKind === "source" ? storySummary.keyLines : 0,
    styleEvidenceChapters: styleCounts.styleChapterCount,
    styleDialogueSamples: styleCounts.dialogueSamples,
    styleNarrationSamples: styleCounts.narrationSamples,
    styleRuleKeys:
      styleProfile?.rules && typeof styleProfile.rules === "object" ? Object.keys(styleProfile.rules).length : 0,
    observationNodes: chapterObservation?.coverage?.observedNodes || chapterObservation?.nodes?.length || 0,
    observationMentions: chapterObservation?.mentions?.length || 0,
    observationStoryCues: chapterObservation?.storyCues?.length || 0,
  };
}

function collectReportMetrics(input) {
  const glossaryEntries = getGlossaryEntries(input.glossary);
  const candidateEntries = getCandidateEntries(input.candidateTerms);
  const storyChapters = getStoryChapters(input.storyContext);
  return {
    glossaryEntries,
    accepted: countAcceptedGlossary(glossaryEntries),
    candidateCounts: countCandidateTerms(candidateEntries),
    storyChapters,
    storySummary: buildStorySummary(storyChapters),
    styleCounts: buildStyleCounts(input.styleEvidence),
  };
}

function reportIdentity(input) {
  return {
    generatedAt: new Date().toISOString(),
    kind: "reference_ingestion_summary",
    referenceSetId: input.referenceSetId,
    mangaId: input.mangaId,
    translatorId: input.translatorId || null,
    chapterId: input.chapterId || null,
    chapterTitle: input.chapterTitle || null,
    manifestLabel: input.manifestLabel || null,
    referenceKind: input.referenceKind,
    useForTerminology: input.useForTerminology,
    useForStyle: input.useForStyle,
    analysisDepth: input.analysisDepth,
  };
}

function buildReferenceIngestionReport(options) {
  const input = { analysisDepth: "quick_read", referenceKind: "translator", glossary: null,
    candidateTerms: null, storyContext: null, styleEvidence: null, styleProfile: null,
    chapterObservation: null, ...options };
  const metrics = collectReportMetrics(input);
  return {
    ...reportIdentity(input),
    sourceStats: buildSourceStatsObject(input.rawLineCount, input.cleanLineCount),
    observationSummary: buildObservationSummaryObject(input.chapterObservation),
    candidateSummary: input.candidateSummary,
    latestRun: buildLatestRunObject(input),
    aggregateSummary: buildAggregateSummaryObject({ ...metrics, ...input }),
    chapterSummaries: metrics.storySummary.chapters,
  };
}

function buildStoryContextCharacters(enrichedCharacterEntries, referenceKind) {
  return enrichedCharacterEntries.map((entry) => ({
    name: entry.name,
    entityType: entry.entity_type || "character",
    referenceKind: entry.reference_kind || referenceKind || null,
    aliases: Array.isArray(entry.aliases) ? entry.aliases.filter(Boolean) : [],
    titleForms: Array.isArray(entry.title_forms) ? entry.title_forms.filter(Boolean) : [],
    canonicalForm:
      entry.canonical_form ||
      (referenceKind === "source"
        ? entry.source_name || entry.source_term || entry.name
        : entry.source_name || entry.name),
    targetRendering: Object.prototype.hasOwnProperty.call(entry, "target_rendering")
      ? entry.target_rendering
      : referenceKind === "source"
        ? null
        : entry.name || null,
    confidence: entry.confidence,
  }));
}

function buildStoryContextTerminology(termEntries) {
  return termEntries.map((entry) => ({
    term: entry.canonical_translation,
    sourceTerm: entry.source_term || null,
    entityType: entry.entity_type || "term",
    referenceKind: entry.reference_kind || null,
    canonicalForm: entry.canonical_form || entry.source_term || entry.canonical_translation || null,
    targetRendering: Object.prototype.hasOwnProperty.call(entry, "target_rendering") ? entry.target_rendering : null,
    category: entry.category,
    confidence: entry.confidence,
  }));
}

function buildStoryContextChapter(options) {
  const { chapterId, referenceSetId, referenceKind, termEntries, characterEntries, extractedEvidence = null } = options;
  const enrichedCharacterEntries = normalizeChapterCharacterEntries(characterEntries);
  const observedMentions = normalizeObservedMentionEntries(extractedEvidence?.observedMentions || []);
  const observedRelations = normalizeObservedRelationEntries(extractedEvidence?.observedRelations || []);
  const observedEvents = normalizeObservedEventEntries(extractedEvidence?.observedEvents || []);
  const observedKeyLines = normalizeObservedKeyLineEntries(extractedEvidence?.keyLines || []);
  const keyLines = observedKeyLines.map((entry) => entry.text);
  const events = filterStoryEvents(observedEvents);
  const relationships = observedRelations;
  return {
    chapterId: chapterId || null,
    referenceSetIds: [referenceSetId],
    characters: buildStoryContextCharacters(enrichedCharacterEntries, referenceKind),
    terminology: buildStoryContextTerminology(termEntries),
    events,
    relationships,
    keyLines,
    mentions: observedMentions,
    characterStates: Array.isArray(extractedEvidence?.characterStates) ? extractedEvidence.characterStates : [],
    openThreads: Array.isArray(extractedEvidence?.openThreads) ? extractedEvidence.openThreads : [],
    storyDeltaNotes: extractedEvidence?.storyDeltaNotes || "",
  };
}

function buildTranslatorContextCharacters(characterEntries, referenceKind) {
  return characterEntries.map((entry) => ({
    name: entry.name,
    entityType: entry.entity_type || "character",
    referenceKind: entry.reference_kind || referenceKind || null,
    aliases: Array.isArray(entry.aliases) ? entry.aliases.filter(Boolean) : [],
    titleForms: Array.isArray(entry.title_forms) ? entry.title_forms.filter(Boolean) : [],
    canonicalForm: entry.canonical_form || entry.source_name || entry.source_term || entry.name || null,
    targetRendering: Object.prototype.hasOwnProperty.call(entry, "target_rendering")
      ? entry.target_rendering
      : entry.name || null,
    confidence: entry.confidence,
  }));
}

function buildTranslatorContextTerminology(termEntries) {
  return termEntries.map((entry) => ({
    term: entry.canonical_translation,
    sourceTerm: entry.source_term || null,
    entityType: entry.entity_type || "term",
    referenceKind: entry.reference_kind || null,
    canonicalForm: entry.canonical_form || entry.source_term || entry.canonical_translation || null,
    targetRendering: Object.prototype.hasOwnProperty.call(entry, "target_rendering") ? entry.target_rendering : null,
    category: entry.category,
    confidence: entry.confidence,
  }));
}

function buildTranslatorReferenceContextChapter(
  chapterId,
  referenceSetId,
  referenceKind,
  termEntries,
  characterEntries,
) {
  return {
    chapterId: chapterId || null,
    referenceSetIds: [referenceSetId],
    characters: buildTranslatorContextCharacters(characterEntries, referenceKind),
    terminology: buildTranslatorContextTerminology(termEntries),
    events: [],
    relationships: [],
    keyLines: [],
    mentions: [],
  };
}

module.exports = {
  buildReferenceIngestionReport,
  buildStoryContextChapter,
  buildTranslatorReferenceContextChapter,
  collectReferenceLines,
  resolveReferenceSourceText,
  resolveReferenceTranslatedText,
};
