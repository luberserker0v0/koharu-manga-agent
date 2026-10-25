import type { IngestionKnowledgeReport } from "../../../api/jobs";

type ChapterLike = {
  chapterId: string;
  chapterTitle?: string | null;
  sortOrder?: number | null;
};

type StoryMentionDisplay = {
  title: string;
  details: string;
};

type StoryRelationshipDisplay = {
  title: string;
  evidence: string | null;
  notes: string | null;
};

type StoryEventDisplay = {
  summary: string;
  evidence: string | null;
  notes: string | null;
};

function mapCharacterStates(value: unknown, limit: number): StoryEventDisplay[] {
  if (!Array.isArray(value)) return [];
  return (value as Array<Record<string, unknown>>)
    .map((entry) => {
      const character = typeof entry.character === "string" ? entry.character : "";
      const attribute = typeof entry.attribute === "string" ? entry.attribute : "";
      const stateValue = typeof entry.value === "string" ? entry.value : "";
      return {
        summary: [character, attribute, stateValue].filter(Boolean).join(" -> "),
        evidence: typeof entry.evidenceLine === "string" ? entry.evidenceLine : null,
        notes: typeof entry.translationImpact === "string" ? entry.translationImpact : null,
      };
    })
    .filter((entry) => Boolean(entry.summary))
    .slice(0, limit);
}

function mapOpenThreads(value: unknown, limit: number): StoryEventDisplay[] {
  if (!Array.isArray(value)) return [];
  return (value as Array<Record<string, unknown>>)
    .map((entry) => ({
      summary: typeof entry.summary === "string" ? entry.summary : "",
      evidence: typeof entry.evidenceLine === "string" ? entry.evidenceLine : null,
      notes: typeof entry.translationImpact === "string" ? entry.translationImpact : null,
    }))
    .filter((entry) => Boolean(entry.summary))
    .slice(0, limit);
}

function groupMentions(entries: Array<Record<string, unknown>>) {
  const grouped = new Map<
    string,
    {
      canonicalForm: string;
      surfaceForms: Set<string>;
      entityTypes: Set<string>;
      count: number;
    }
  >();
  for (const entry of entries) {
    const surfaceForm = typeof entry.surfaceForm === "string" ? entry.surfaceForm.trim() : "";
    const canonicalForm = typeof entry.canonicalForm === "string" ? entry.canonicalForm.trim() : "";
    const entityType = typeof entry.entityType === "string" ? entry.entityType.trim() : "";
    const key = canonicalForm || surfaceForm;
    if (!key) continue;
    const current = grouped.get(key) || {
      canonicalForm: canonicalForm || surfaceForm,
      surfaceForms: new Set<string>(),
      entityTypes: new Set<string>(),
      count: 0,
    };
    if (surfaceForm) current.surfaceForms.add(surfaceForm);
    if (entityType) current.entityTypes.add(entityType);
    current.count += 1;
    grouped.set(key, current);
  }
  return [...grouped.values()];
}

function formatMention(entry: {
  canonicalForm: string;
  surfaceForms: Set<string>;
  entityTypes: Set<string>;
  count: number;
}): StoryMentionDisplay {
  const title = `${entry.canonicalForm} × ${entry.count}`;
  const surfaceVariants = [...entry.surfaceForms].filter((value) => value && value !== entry.canonicalForm);
  const parts = [
    entry.entityTypes.size > 0 ? `類型：${[...entry.entityTypes].join("、")}` : null,
    surfaceVariants.length > 0 ? `觀察詞：${surfaceVariants.join("、")}` : null,
  ].filter(Boolean);
  return { title, details: parts.join(" / ") };
}

function aggregateMentionDisplays(entries: Array<Record<string, unknown>>, limit: number) {
  return groupMentions(entries)
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return left.canonicalForm.localeCompare(right.canonicalForm);
    })
    .slice(0, limit)
    .map(formatMention);
}

export function topGlossaryEntries(report: IngestionKnowledgeReport | undefined) {
  const entries = Array.isArray(report?.glossary?.entries) ? report.glossary.entries : [];
  return [...entries]
    .sort((left, right) => {
      const leftConfidence = typeof left?.confidence === "number" ? left.confidence : 0;
      const rightConfidence = typeof right?.confidence === "number" ? right.confidence : 0;
      return rightConfidence - leftConfidence;
    })
    .slice(0, 8) as Array<Record<string, unknown>>;
}

export function topCandidateEntries(report: IngestionKnowledgeReport | undefined) {
  const entries = Array.isArray(report?.candidateTerms?.entries) ? report.candidateTerms.entries : [];
  return [...entries]
    .filter((entry) => entry?.status !== "rejected")
    .sort((left, right) => {
      const leftConfidence = typeof left?.confidence_score === "number" ? left.confidence_score : 0;
      const rightConfidence = typeof right?.confidence_score === "number" ? right.confidence_score : 0;
      if (rightConfidence !== leftConfidence) return rightConfidence - leftConfidence;
      const leftChapters = typeof left?.chapter_count === "number" ? left.chapter_count : 0;
      const rightChapters = typeof right?.chapter_count === "number" ? right.chapter_count : 0;
      if (rightChapters !== leftChapters) return rightChapters - leftChapters;
      const leftMentions = typeof left?.mention_count === "number" ? left.mention_count : 0;
      const rightMentions = typeof right?.mention_count === "number" ? right.mention_count : 0;
      return rightMentions - leftMentions;
    })
    .slice(0, 10) as Array<Record<string, unknown>>;
}

export function narrationStyleSummary(report: IngestionKnowledgeReport | undefined) {
  const profile =
    report?.styleProfile && typeof report.styleProfile === "object"
      ? (report.styleProfile as Record<string, unknown>)
      : null;
  const narration =
    profile?.narration && typeof profile.narration === "object" ? (profile.narration as Record<string, unknown>) : null;

  return {
    tone: typeof narration?.tone === "string" ? narration.tone : null,
    register: typeof narration?.register === "string" ? narration.register : null,
    preferredPatterns: Array.isArray(narration?.preferred_patterns)
      ? (narration.preferred_patterns as string[]).filter(Boolean).slice(0, 6)
      : [],
    forbiddenPatterns: Array.isArray(narration?.forbidden_patterns)
      ? (narration.forbidden_patterns as string[]).filter(Boolean).slice(0, 6)
      : [],
    notes: Array.isArray(narration?.notes) ? (narration.notes as string[]).filter(Boolean).slice(0, 6) : [],
  };
}

export function globalStyleSummary(report: IngestionKnowledgeReport | undefined) {
  const profile =
    report?.styleProfile && typeof report.styleProfile === "object"
      ? (report.styleProfile as Record<string, unknown>)
      : null;

  return {
    tone: typeof profile?.tone === "string" ? profile.tone : null,
    register: typeof profile?.register === "string" ? profile.register : null,
    preferredPatterns: Array.isArray(profile?.preferred_patterns)
      ? (profile.preferred_patterns as string[]).filter(Boolean).slice(0, 6)
      : [],
    forbiddenPatterns: Array.isArray(profile?.forbidden_patterns)
      ? (profile.forbidden_patterns as string[]).filter(Boolean).slice(0, 6)
      : [],
  };
}

function styleEvidenceChapters(report: IngestionKnowledgeReport | undefined) {
  const styleEvidence =
    report?.styleEvidence && typeof report.styleEvidence === "object"
      ? (report.styleEvidence as Record<string, unknown>)
      : null;
  return styleEvidence?.chapters && typeof styleEvidence.chapters === "object"
    ? Object.values(styleEvidence.chapters as Record<string, unknown>)
    : [];
}

export function styleExampleEntries(report: IngestionKnowledgeReport | undefined, type: "dialogue" | "narration") {
  const key = type === "narration" ? "narrationSamples" : "dialogueSamples";
  const samples: Array<Record<string, unknown>> = [];
  for (const chapter of styleEvidenceChapters(report)) {
    const items =
      chapter && typeof chapter === "object" && Array.isArray((chapter as Record<string, unknown>)[key])
        ? ((chapter as Record<string, unknown>)[key] as string[])
        : [];
    for (const translation of items) {
      if (typeof translation !== "string" || !translation.trim()) continue;
      samples.push({ type, translation });
      if (samples.length >= 6) return samples;
    }
  }
  return samples;
}

export function styleEvidenceCharacterEntries(report: IngestionKnowledgeReport | undefined) {
  const seen = new Set<string>();
  const collected: Array<Record<string, unknown>> = [];
  for (const chapter of styleEvidenceChapters(report)) {
    const items =
      chapter && typeof chapter === "object" && Array.isArray((chapter as Record<string, unknown>).characterSpeech)
        ? ((chapter as Record<string, unknown>).characterSpeech as Array<Record<string, unknown>>)
        : [];
    for (const item of items) {
      const name = typeof item.name === "string" ? item.name : "";
      if (!name || seen.has(name)) continue;
      seen.add(name);
      collected.push(item);
      if (collected.length >= 8) return collected;
    }
  }
  return collected;
}

export function describeCharacterSpeech(entry: Record<string, unknown>) {
  const name = typeof entry.name === "string" ? entry.name : "未知角色";
  const speechStyle = Array.isArray(entry.speech_style) ? (entry.speech_style as string[]).filter(Boolean) : [];
  const endings = Array.isArray(entry.sentence_ending_patterns)
    ? (entry.sentence_ending_patterns as string[]).filter(Boolean)
    : [];
  const addressing = Array.isArray(entry.addressing_patterns)
    ? (entry.addressing_patterns as string[]).filter(Boolean)
    : [];
  const parts = [
    speechStyle.length > 0 ? `語氣：${speechStyle.join("、")}` : null,
    endings.length > 0 ? `句尾：${endings.join("、")}` : null,
    addressing.length > 0 ? `稱呼：${addressing.join("、")}` : null,
  ].filter(Boolean);
  return { title: name, details: parts.join(" / ") };
}

function styleEvidenceEntries(report: IngestionKnowledgeReport | undefined) {
  const styleEvidence =
    report?.styleEvidence && typeof report.styleEvidence === "object"
      ? (report.styleEvidence as Record<string, unknown>)
      : null;
  return styleEvidence?.chapters && typeof styleEvidence.chapters === "object"
    ? Object.entries(styleEvidence.chapters as Record<string, unknown>)
    : [];
}

function styleChapterEvidenceSummary(chapter: Record<string, unknown>) {
  const registerEvidence = Array.isArray(chapter.registerEvidence)
    ? (chapter.registerEvidence as Array<Record<string, unknown>>)
    : [];
  const punctuationEvidence = Array.isArray(chapter.punctuationEvidence)
    ? (chapter.punctuationEvidence as Array<Record<string, unknown>>)
    : [];
  const honorificEvidence = Array.isArray(chapter.honorificEvidence)
    ? (chapter.honorificEvidence as Array<Record<string, unknown>>)
    : [];
  const dominantRegister =
    registerEvidence.length > 0 && typeof registerEvidence[0]?.register === "string"
      ? String(registerEvidence[0].register)
      : null;
  const confidenceValues = [
    ...registerEvidence.map((entry) => (typeof entry.confidence === "number" ? entry.confidence : null)),
    ...punctuationEvidence.map((entry) => (typeof entry.confidence === "number" ? entry.confidence : null)),
    ...honorificEvidence.map((entry) => (typeof entry.confidence === "number" ? entry.confidence : null)),
  ].filter((value): value is number => value !== null);
  const confidence =
    confidenceValues.length > 0
      ? Math.round((confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length) * 100)
      : null;
  return { dominantRegister, confidence };
}

function chapterArray<T>(chapter: Record<string, unknown>, key: string, limit: number) {
  return Array.isArray(chapter[key]) ? (chapter[key] as T[]).filter(Boolean).slice(0, limit) : [];
}

function styleEvidenceChapterBase(
  chapterKey: string,
  rawChapter: unknown,
  report: IngestionKnowledgeReport | undefined,
) {
  const chapter = rawChapter && typeof rawChapter === "object" ? (rawChapter as Record<string, unknown>) : {};
  const ratios =
    Array.isArray(chapter.dialogueNarrationEvidence) && chapter.dialogueNarrationEvidence.length > 0
      ? (chapter.dialogueNarrationEvidence[0] as Record<string, unknown>)
      : {};
  const dialogueRatio = typeof ratios.dialogueRatio === "number" ? Math.round(ratios.dialogueRatio * 100) : null;
  const narrationRatio = typeof ratios.narrationRatio === "number" ? Math.round(ratios.narrationRatio * 100) : null;
  const dialogueSamples = chapterArray<string>(chapter, "dialogueSamples", 3);
  const narrationSamples = chapterArray<string>(chapter, "narrationSamples", 3);
  const characterSpeech = chapterArray<Record<string, unknown>>(chapter, "characterSpeech", 4);
  const referenceKind =
    typeof chapter.referenceKind === "string" ? chapter.referenceKind : report?.referenceKind || "translator";
  return {
    chapter,
    chapterKey,
    dialogueRatio,
    narrationRatio,
    dialogueSamples,
    narrationSamples,
    characterSpeech,
    referenceKind,
  };
}

function toStyleEvidenceChapter(chapterKey: string, rawChapter: unknown, report: IngestionKnowledgeReport | undefined) {
  const base = styleEvidenceChapterBase(chapterKey, rawChapter, report);
  const { dominantRegister, confidence } = styleChapterEvidenceSummary(base.chapter);
  return {
    chapterKey: base.chapterKey,
    chapterId: typeof base.chapter.chapterId === "string" ? base.chapter.chapterId : base.chapterKey,
    referenceKind: base.referenceKind,
    dialogueRatio: base.dialogueRatio,
    narrationRatio: base.narrationRatio,
    dominantRegister,
    confidence,
    dialogueSamples: base.dialogueSamples,
    narrationSamples: base.narrationSamples,
    characterSpeech: base.characterSpeech,
  };
}

export function styleEvidenceChapterEntries(report: IngestionKnowledgeReport | undefined) {
  return styleEvidenceEntries(report).map(([chapterKey, rawChapter]) =>
    toStyleEvidenceChapter(chapterKey, rawChapter, report),
  );
}

export function resolveChapterDisplayTitle(chapterId: string | null | undefined, chapters: ChapterLike[] = []) {
  if (!chapterId) return null;
  const matched = chapters.find((entry) => entry.chapterId === chapterId) || null;
  if (!matched) return chapterId;
  return matched.chapterTitle?.trim() || matched.chapterId;
}

export function styleSummaryTitle(referenceKind: "source" | "translator" = "translator") {
  return referenceKind === "source" ? "敘事與風格證據摘要" : "翻譯風格摘要";
}

function globalCharacterEntries(report: IngestionKnowledgeReport | undefined) {
  const global =
    report?.storyContext &&
    typeof report.storyContext === "object" &&
    (report.storyContext as Record<string, unknown>).global &&
    typeof (report.storyContext as Record<string, unknown>).global === "object"
      ? ((report.storyContext as Record<string, unknown>).global as Record<string, unknown>)
      : null;
  if (!global || !Array.isArray(global.characters)) return [];
  return global.characters.filter((entry) => typeof entry?.name === "string");
}

export function topCharacterEntries(report: IngestionKnowledgeReport | undefined) {
  const glossaryEntries = Array.isArray(report?.glossary?.entries) ? report.glossary.entries : [];
  const acceptedCharacters = glossaryEntries.filter((entry) => entry?.category === "character_name");

  if (acceptedCharacters.length > 0) {
    return [...acceptedCharacters]
      .sort((left, right) => {
        const leftConfidence = typeof left?.confidence === "number" ? left.confidence : 0;
        const rightConfidence = typeof right?.confidence === "number" ? right.confidence : 0;
        return rightConfidence - leftConfidence;
      })
      .slice(0, 8) as Array<Record<string, unknown>>;
  }

  return [...globalCharacterEntries(report)]
    .sort((left, right) => {
      const leftConfidence = typeof left?.confidence === "number" ? left.confidence : 0;
      const rightConfidence = typeof right?.confidence === "number" ? right.confidence : 0;
      return rightConfidence - leftConfidence;
    })
    .slice(0, 8);
}

function storyChapterMap(chapters: ChapterLike[]) {
  return new Map(chapters.map((chapter) => [chapter.chapterId, chapter]));
}

function storyChapters(report: IngestionKnowledgeReport | undefined) {
  const storyContext =
    report?.storyContext && typeof report.storyContext === "object"
      ? (report.storyContext as Record<string, unknown>)
      : null;
  return storyContext?.chapters && typeof storyContext.chapters === "object"
    ? Object.values(storyContext.chapters as Record<string, unknown>)
    : [];
}

function toAnalyzedChapter(entry: unknown, chapterMap: Map<string, ChapterLike>) {
  const chapterRecord = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
  const chapterId =
    typeof chapterRecord.chapterId === "string" && chapterRecord.chapterId.length > 0 ? chapterRecord.chapterId : null;
  const chapterMeta = chapterId ? chapterMap.get(chapterId) : undefined;
  const characterCount = Array.isArray(chapterRecord.characters) ? chapterRecord.characters.length : 0;
  const terminologyCount = Array.isArray(chapterRecord.terminology) ? chapterRecord.terminology.length : 0;
  const title =
    chapterMeta?.chapterTitle && chapterMeta.chapterTitle.trim().length > 0
      ? chapterMeta.chapterTitle.trim()
      : chapterId || "未命名章節";
  const sortOrder = typeof chapterMeta?.sortOrder === "number" ? chapterMeta.sortOrder : Number.MAX_SAFE_INTEGER;
  return {
    chapterId: chapterId || title,
    title,
    sortOrder,
    characterCount,
    terminologyCount,
  };
}

export function analyzedChapterEntries(report: IngestionKnowledgeReport | undefined, chapters: ChapterLike[] = []) {
  const chapterMap = storyChapterMap(chapters);
  return storyChapters(report)
    .map((entry) => toAnalyzedChapter(entry, chapterMap))
    .sort((left, right) => {
      if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
      return left.title.localeCompare(right.title);
    })
    .slice(0, 12);
}

export function storyChapterSummaries(report: IngestionKnowledgeReport | undefined, chapters: ChapterLike[] = []) {
  return analyzedChapterEntries(report, chapters).map((entry) => ({
    chapterId: entry.chapterId,
    characterCount: entry.characterCount,
    terminologyCount: entry.terminologyCount,
  }));
}

function globalRecord(report: IngestionKnowledgeReport | undefined) {
  const storyContext =
    report?.storyContext && typeof report.storyContext === "object"
      ? (report.storyContext as Record<string, unknown>)
      : null;
  return storyContext?.global && typeof storyContext.global === "object"
    ? (storyContext.global as Record<string, unknown>)
    : null;
}

function globalNames(value: unknown, field: string) {
  if (!Array.isArray(value)) return [];
  return (value as Array<Record<string, unknown>>)
    .map((entry) => (typeof entry[field] === "string" ? (entry[field] as string) : null))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 12);
}

function globalTermName(entry: Record<string, unknown>) {
  if (typeof entry.term === "string") return entry.term;
  if (typeof entry.canonicalForm === "string") return entry.canonicalForm;
  if (typeof entry.canonical_translation === "string") return entry.canonical_translation;
  return null;
}

function globalTerminology(global: Record<string, unknown> | null) {
  if (!global || !Array.isArray(global.terminology)) return [];
  return (global.terminology as Array<Record<string, unknown>>)
    .map(globalTermName)
    .filter((value): value is string => Boolean(value))
    .slice(0, 12);
}

function toRelationshipDisplay(entry: Record<string, unknown>): StoryRelationshipDisplay | null {
  const subject = typeof entry.subject === "string" ? entry.subject : "";
  const relationType = typeof entry.relationType === "string" ? entry.relationType : "";
  const object = typeof entry.object === "string" ? entry.object : "";
  if (!subject || !object || relationType === "has_role") return null;
  const evidence = typeof entry.evidenceLine === "string" ? entry.evidenceLine : null;
  const notes = typeof entry.notes === "string" ? entry.notes : null;
  const title = [subject || "?", relationType || "related_to", object || "?"].join(" -> ");
  return { title, evidence, notes };
}

function globalRelationships(global: Record<string, unknown> | null) {
  if (!global || !Array.isArray(global.relationships)) return [];
  return (global.relationships as Array<Record<string, unknown>>)
    .map(toRelationshipDisplay)
    .filter((value): value is StoryRelationshipDisplay => Boolean(value && value.title))
    .slice(0, 12);
}

function globalEvents(global: Record<string, unknown> | null) {
  if (!global || !Array.isArray(global.events)) return [];
  return (global.events as Array<Record<string, unknown>>)
    .map((entry) => ({
      summary: typeof entry.summary === "string" ? entry.summary : "",
      evidence: typeof entry.evidenceLine === "string" ? entry.evidenceLine : null,
      notes: typeof entry.notes === "string" ? entry.notes : null,
    }))
    .filter((value): value is StoryEventDisplay => Boolean(value.summary))
    .slice(0, 8);
}

export function storyContextGlobalSummary(report: IngestionKnowledgeReport | undefined) {
  const global = globalRecord(report);
  const characters = globalNames(global?.characters, "name");
  const terminology = globalTerminology(global);
  const relationships = globalRelationships(global);
  const mentions = Array.isArray(global?.mentions)
    ? aggregateMentionDisplays(global?.mentions as Array<Record<string, unknown>>, 12)
    : [];
  const events = globalEvents(global);
  const characterStates = mapCharacterStates(global?.characterStates, 12);
  const openThreads = mapOpenThreads(global?.openThreads, 8);
  return {
    characters,
    terminology,
    relationships,
    mentions,
    events,
    characterStates,
    openThreads,
  };
}

function toChapterRelationship(entry: Record<string, unknown>): StoryRelationshipDisplay | null {
  const subject = typeof entry.subject === "string" ? entry.subject : "";
  const relationType = typeof entry.relationType === "string" ? entry.relationType : "";
  const object = typeof entry.object === "string" ? entry.object : "";
  if (!subject || !object || relationType === "has_role") return null;
  const evidence = typeof entry.evidenceLine === "string" ? entry.evidenceLine : null;
  const notes = typeof entry.notes === "string" ? entry.notes : null;
  const title = [subject || "?", relationType || "related_to", object || "?"].join(" -> ");
  return { title, evidence, notes };
}

function toChapterEvent(entry: Record<string, unknown>): StoryEventDisplay {
  return {
    summary: typeof entry.summary === "string" ? entry.summary : "",
    evidence: typeof entry.evidenceLine === "string" ? entry.evidenceLine : null,
    notes: typeof entry.notes === "string" ? entry.notes : null,
  };
}

function chapterCharacters(chapterRecord: Record<string, unknown>) {
  if (!Array.isArray(chapterRecord.characters)) return [];
  return (chapterRecord.characters as Array<Record<string, unknown>>)
    .map((item) => (typeof item.name === "string" ? item.name : null))
    .filter((value): value is string => Boolean(value))
    .slice(0, 8);
}

function chapterTerminology(chapterRecord: Record<string, unknown>) {
  if (!Array.isArray(chapterRecord.terminology)) return [];
  return (chapterRecord.terminology as Array<Record<string, unknown>>)
    .map((item) =>
      typeof item.term === "string" ? item.term : typeof item.canonicalForm === "string" ? item.canonicalForm : null,
    )
    .filter((value): value is string => Boolean(value))
    .slice(0, 8);
}

function chapterRelationships(chapterRecord: Record<string, unknown>) {
  if (!Array.isArray(chapterRecord.relationships)) return [];
  return (chapterRecord.relationships as Array<Record<string, unknown>>)
    .map(toChapterRelationship)
    .filter((value): value is StoryRelationshipDisplay => Boolean(value && value.title))
    .slice(0, 8);
}

function chapterMentions(chapterRecord: Record<string, unknown>) {
  if (!Array.isArray(chapterRecord.mentions)) return [];
  return aggregateMentionDisplays(chapterRecord.mentions as Array<Record<string, unknown>>, 8);
}

function chapterEvents(chapterRecord: Record<string, unknown>) {
  if (!Array.isArray(chapterRecord.events)) return [];
  return (chapterRecord.events as Array<Record<string, unknown>>)
    .map(toChapterEvent)
    .filter((value): value is StoryEventDisplay => Boolean(value.summary))
    .slice(0, 4);
}

function chapterKeyLines(chapterRecord: Record<string, unknown>) {
  if (!Array.isArray(chapterRecord.keyLines)) return [];
  return (chapterRecord.keyLines as string[]).filter(Boolean).slice(0, 5);
}

function toStoryChapterDetail(entry: unknown, chapterMap: Map<string, ChapterLike>) {
  const chapterRecord = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
  const chapterId =
    typeof chapterRecord.chapterId === "string" && chapterRecord.chapterId.length > 0 ? chapterRecord.chapterId : null;
  const chapterMeta = chapterId ? chapterMap.get(chapterId) : undefined;
  const title =
    chapterMeta?.chapterTitle && chapterMeta.chapterTitle.trim().length > 0
      ? chapterMeta.chapterTitle.trim()
      : chapterId || "未命名章節";
  const sortOrder = typeof chapterMeta?.sortOrder === "number" ? chapterMeta.sortOrder : Number.MAX_SAFE_INTEGER;
  return {
    chapterId: chapterId || title,
    title,
    sortOrder,
    characters: chapterCharacters(chapterRecord),
    terminology: chapterTerminology(chapterRecord),
    mentions: chapterMentions(chapterRecord),
    relationships: chapterRelationships(chapterRecord),
    events: chapterEvents(chapterRecord),
    keyLines: chapterKeyLines(chapterRecord),
    characterStates: mapCharacterStates(chapterRecord.characterStates, 6),
    openThreads: mapOpenThreads(chapterRecord.openThreads, 4),
  };
}

export function storyContextChapterDetails(report: IngestionKnowledgeReport | undefined, chapters: ChapterLike[] = []) {
  const chapterMap = storyChapterMap(chapters);
  return storyChapters(report)
    .map((entry) => toStoryChapterDetail(entry, chapterMap))
    .sort((left, right) => {
      if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
      return left.title.localeCompare(right.title);
    });
}

function formatObservedConfidence(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return `${Math.round(value * 100)}%`;
}

function observedSource(entry: Record<string, unknown>) {
  if (typeof entry.source_term === "string") return entry.source_term;
  if (typeof entry.source === "string") return entry.source;
  if (typeof entry.term === "string") return entry.term;
  if (typeof entry.key === "string") return entry.key;
  if (typeof entry.name === "string") return entry.name;
  return null;
}

function observedCanonical(entry: Record<string, unknown>, source: string | null) {
  if (typeof entry.canonical_form === "string") return entry.canonical_form;
  if (typeof entry.canonicalForm === "string") return entry.canonicalForm;
  return source;
}

function observedTarget(entry: Record<string, unknown>) {
  if (typeof entry.target_rendering === "string") return entry.target_rendering;
  if (typeof entry.targetRendering === "string") return entry.targetRendering;
  if (typeof entry.canonical_translation === "string") return entry.canonical_translation;
  if (typeof entry.translation === "string") return entry.translation;
  return null;
}

function observedConfidence(entry: Record<string, unknown>) {
  return formatObservedConfidence(entry.confidence) || formatObservedConfidence(entry.confidence_score);
}

function observedChapterCount(entry: Record<string, unknown>) {
  return typeof entry.chapter_count === "number" && entry.chapter_count > 0 ? `${entry.chapter_count} 話` : null;
}

function describeObservedSourceEntry(
  source: string | null,
  canonicalForm: string | null,
  targetRendering: string | null,
  confidence: string | null,
  chapterCount: string | null,
) {
  return {
    title: canonicalForm || source || targetRendering || null,
    details: [
      source && canonicalForm && source !== canonicalForm ? `觀察詞：${source}` : null,
      confidence,
      chapterCount,
    ]
      .filter(Boolean)
      .join(" / "),
  };
}

function describeObservedTranslatorEntry(
  source: string | null,
  canonicalForm: string | null,
  targetRendering: string | null,
  confidence: string | null,
  chapterCount: string | null,
  status: string | null,
) {
  return {
    title:
      source && targetRendering
        ? `${source} -> ${targetRendering}`
        : targetRendering || canonicalForm || source || null,
    details: [
      canonicalForm && targetRendering && canonicalForm !== targetRendering ? `正規化：${canonicalForm}` : null,
      status === "candidate" ? "待確認" : null,
      confidence,
      chapterCount,
    ]
      .filter(Boolean)
      .join(" / "),
  };
}

export function describeObservedEntryV2(
  entry: Record<string, unknown>,
  referenceKind: "source" | "translator" = "translator",
) {
  const source = observedSource(entry);
  const canonicalForm = observedCanonical(entry, source);
  const targetRendering = observedTarget(entry);
  const confidence = observedConfidence(entry);
  const chapterCount = observedChapterCount(entry);
  const status = typeof entry.status === "string" && entry.status.length > 0 ? entry.status : null;
  if (referenceKind === "source") {
    return describeObservedSourceEntry(source, canonicalForm, targetRendering, confidence, chapterCount);
  }
  return describeObservedTranslatorEntry(source, canonicalForm, targetRendering, confidence, chapterCount, status);
}
