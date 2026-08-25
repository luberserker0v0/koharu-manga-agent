function resolveReferenceSourceText(textNode) {
  return String(textNode?.sourceText || textNode?.originalText || textNode?.text || "").trim();
}

function resolveReferenceTranslatedText(textNode) {
  return String(
    textNode?.translatedText || textNode?.targetText || textNode?.translation || ""
  ).trim();
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
  return String(line || "").replace(/\s+/g, " ").trim();
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

  return deduped
    .sort((left, right) => (right.confidence || 0) - (left.confidence || 0))
    .slice(0, 4);
}

function normalizeChapterCharacterEntries(extractedCharacterEntries) {
  const merged = new Map();

  for (const entry of extractedCharacterEntries || []) {
    const name = String(entry.name || entry.source_name || entry.source_term || "").trim();
    if (!name) {
      continue;
    }
    const aliases = [
      ...(Array.isArray(entry.aliases) ? entry.aliases : []),
      ...(Array.isArray(entry.title_forms) ? entry.title_forms : []),
      ...(Array.isArray(entry.titleForms) ? entry.titleForms : []),
    ]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    const current = merged.get(name);
    const next = {
      ...entry,
      name,
      aliases: [...new Set(aliases)],
      title_forms: [...new Set([
        ...(Array.isArray(entry.title_forms) ? entry.title_forms : []),
        ...(Array.isArray(entry.titleForms) ? entry.titleForms : []),
      ].filter(Boolean))],
      confidence: Math.max(entry.confidence || 0, current?.confidence || 0),
      mentionCount: Math.max(
        current?.mentionCount || 0,
        Array.isArray(entry.example_lines) ? entry.example_lines.length : 0
      ),
    };
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

function normalizeObservedRelationEntries(entries = []) {
  return (entries || [])
    .map((entry) => ({
      term: String(entry?.relationType || "related_to").trim() || "related_to",
      relationType: String(entry?.relationType || "related_to").trim() || "related_to",
      subject: String(entry?.subject || "").trim() || null,
      object: String(entry?.object || "").trim() || null,
      subjectCandidates: String(entry?.subject || "").trim() ? [String(entry.subject).trim()] : [],
      objectCandidates: String(entry?.object || "").trim() ? [String(entry.object).trim()] : [],
      summary:
        String(entry?.subject || "").trim() || String(entry?.object || "").trim()
          ? `${String(entry?.subject || "").trim() || "?"} / ${String(entry?.object || "").trim() || "?"} :: ${String(entry?.relationType || "related_to").trim() || "related_to"}`
          : String(entry?.evidenceLine || "").trim(),
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
      notes: entry?.notes || "",
      pageName: entry?.pageName || null,
      nodeId: entry?.nodeId || null,
      textRole: entry?.textRole || null,
      styleChannel: entry?.styleChannel || null,
      speakerRef: entry?.speakerRef || null,
    }))
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

function buildReferenceIngestionReport({
  referenceSetId,
  mangaId,
  translatorId,
  chapterId,
  chapterTitle,
  manifestLabel,
  useForTerminology,
  useForStyle,
  analysisDepth = "quick_read",
  rawLineCount,
  cleanLineCount,
  candidateSummary,
  referenceKind = "translator",
  glossary = null,
  candidateTerms = null,
  storyContext = null,
  styleEvidence = null,
  styleProfile = null,
  chapterObservation = null,
}) {
  const glossaryEntries = Array.isArray(glossary?.entries) ? glossary.entries : [];
  const candidateEntries = Array.isArray(candidateTerms?.entries) ? candidateTerms.entries : [];
  const storyChapters =
    storyContext?.chapters && typeof storyContext.chapters === "object"
      ? Object.entries(storyContext.chapters).map(([chapterKey, chapter]) => ({
          chapterKey,
          ...chapter,
        }))
      : [];
  const acceptedTerminology = glossaryEntries.filter((entry) => entry.category !== "character_name");
  const acceptedCharacters = glossaryEntries.filter((entry) => entry.category === "character_name");
  const candidateTerminology = candidateEntries.filter(
    (entry) => (entry.kind === "term" || entry.entity_type === "term") && entry.status === "candidate"
  );
  const candidateCharacters = candidateEntries.filter(
    (entry) =>
      (entry.kind === "character" || entry.entity_type === "character") && entry.status === "candidate"
  );
  const rejectedEntries = candidateEntries.filter((entry) => entry.status === "rejected");
  const storySummary = storyChapters.reduce(
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
    {
      chapters: [],
      mentions: 0,
      relationships: 0,
      events: 0,
      keyLines: 0,
    }
  );
  const styleChapterCount =
    styleEvidence?.chapters && typeof styleEvidence.chapters === "object"
      ? Object.keys(styleEvidence.chapters).length
      : 0;
  const styleChapterEntries =
    styleEvidence?.chapters && typeof styleEvidence.chapters === "object"
      ? Object.values(styleEvidence.chapters)
      : [];
  const styleDialogueSamples = styleChapterEntries.reduce((count, chapter) => {
    const samples =
      chapter && typeof chapter === "object" && Array.isArray(chapter.dialogueSamples)
        ? chapter.dialogueSamples
        : [];
    return count + samples.filter(Boolean).length;
  }, 0);
  const styleNarrationSamples = styleChapterEntries.reduce((count, chapter) => {
    const samples =
      chapter && typeof chapter === "object" && Array.isArray(chapter.narrationSamples)
        ? chapter.narrationSamples
        : [];
    return count + samples.filter(Boolean).length;
  }, 0);

  return {
    generatedAt: new Date().toISOString(),
    kind: "reference_ingestion_summary",
    referenceSetId,
    mangaId,
    translatorId: translatorId || null,
    chapterId: chapterId || null,
    chapterTitle: chapterTitle || null,
    manifestLabel: manifestLabel || null,
    referenceKind,
    useForTerminology,
    useForStyle,
    analysisDepth,
    sourceStats: {
      rawLineCount,
      cleanLineCount,
      filteredNoiseCount: Math.max(0, rawLineCount - cleanLineCount),
    },
    observationSummary: chapterObservation
      ? {
          revisionId: chapterObservation.revisionId,
          nodeCount: chapterObservation.coverage?.observedNodes || chapterObservation.nodes?.length || 0,
          mentionCount: chapterObservation.mentions?.length || 0,
          storyCueCount: chapterObservation.storyCues?.length || 0,
          coverage: chapterObservation.coverage || null,
        }
      : null,
    candidateSummary,
    latestRun: {
      referenceSetId,
      chapterId: chapterId || null,
      chapterTitle: chapterTitle || null,
      manifestLabel: manifestLabel || null,
      referenceKind,
      analysisDepth,
      sourceStats: {
        rawLineCount,
        cleanLineCount,
        filteredNoiseCount: Math.max(0, rawLineCount - cleanLineCount),
      },
      candidateSummary,
      observationRevisionId: chapterObservation?.revisionId || null,
    },
    aggregateSummary: {
      glossaryEntries: glossaryEntries.length,
      acceptedTerminology: acceptedTerminology.length,
      acceptedCharacters: acceptedCharacters.length,
      candidateTerms: candidateTerminology.length,
      candidateCharacters: candidateCharacters.length,
      rejectedEntries: rejectedEntries.length,
      storyChapters: storyChapters.length,
      storyMentions: referenceKind === "source" ? storySummary.mentions : 0,
      storyRelationships: referenceKind === "source" ? storySummary.relationships : 0,
      storyEvents: referenceKind === "source" ? storySummary.events : 0,
      storyKeyLines: referenceKind === "source" ? storySummary.keyLines : 0,
      styleEvidenceChapters: styleChapterCount,
      styleDialogueSamples,
      styleNarrationSamples,
      styleRuleKeys:
        styleProfile?.rules && typeof styleProfile.rules === "object"
          ? Object.keys(styleProfile.rules).length
          : 0,
      observationNodes: chapterObservation?.coverage?.observedNodes || chapterObservation?.nodes?.length || 0,
      observationMentions: chapterObservation?.mentions?.length || 0,
      observationStoryCues: chapterObservation?.storyCues?.length || 0,
    },
    chapterSummaries: storySummary.chapters,
  };
}

function buildStoryContextChapter(
  chapterId,
  referenceSetId,
  referenceKind,
  termEntries,
  characterEntries,
  texts,
  existingGlossary = null,
  existingStoryContext = null,
  extractedEvidence = null,
  contentLanguage = null
) {
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
    characters: enrichedCharacterEntries.map((entry) => ({
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
      targetRendering:
        Object.prototype.hasOwnProperty.call(entry, "target_rendering")
          ? entry.target_rendering
          : referenceKind === "source"
            ? null
            : entry.name || null,
      confidence: entry.confidence,
    })),
    terminology: termEntries.map((entry) => ({
      term: entry.canonical_translation,
      sourceTerm: entry.source_term || null,
      entityType: entry.entity_type || "term",
      referenceKind: entry.reference_kind || null,
      canonicalForm: entry.canonical_form || entry.source_term || entry.canonical_translation || null,
      targetRendering:
        Object.prototype.hasOwnProperty.call(entry, "target_rendering") ? entry.target_rendering : null,
      category: entry.category,
      confidence: entry.confidence,
    })),
    events,
    relationships,
    keyLines,
    mentions: observedMentions,
    characterStates: Array.isArray(extractedEvidence?.characterStates)
      ? extractedEvidence.characterStates
      : [],
    openThreads: Array.isArray(extractedEvidence?.openThreads)
      ? extractedEvidence.openThreads
      : [],
    storyDeltaNotes: extractedEvidence?.storyDeltaNotes || "",
  };
}

function buildTranslatorReferenceContextChapter(
  chapterId,
  referenceSetId,
  referenceKind,
  termEntries,
  characterEntries
) {
  return {
    chapterId: chapterId || null,
    referenceSetIds: [referenceSetId],
    characters: characterEntries.map((entry) => ({
      name: entry.name,
      entityType: entry.entity_type || "character",
      referenceKind: entry.reference_kind || referenceKind || null,
      aliases: Array.isArray(entry.aliases) ? entry.aliases.filter(Boolean) : [],
      titleForms: Array.isArray(entry.title_forms) ? entry.title_forms.filter(Boolean) : [],
      canonicalForm: entry.canonical_form || entry.source_name || entry.source_term || entry.name || null,
      targetRendering:
        Object.prototype.hasOwnProperty.call(entry, "target_rendering")
          ? entry.target_rendering
          : entry.name || null,
      confidence: entry.confidence,
    })),
    terminology: termEntries.map((entry) => ({
      term: entry.canonical_translation,
      sourceTerm: entry.source_term || null,
      entityType: entry.entity_type || "term",
      referenceKind: entry.reference_kind || null,
      canonicalForm: entry.canonical_form || entry.source_term || entry.canonical_translation || null,
      targetRendering:
        Object.prototype.hasOwnProperty.call(entry, "target_rendering") ? entry.target_rendering : null,
      category: entry.category,
      confidence: entry.confidence,
    })),
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
