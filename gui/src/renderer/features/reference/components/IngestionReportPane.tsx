import { SectionCard } from "../../shared/components/SectionCard";
import type {
  IngestionKnowledgeReport,
  MangaSeriesSummary,
  ReferenceSetSummary,
  TranslatorProfileSummary,
} from "../../../api/jobs";
import {
  describeCharacterSpeech,
  describeObservedEntryV2,
  globalStyleSummary,
  narrationStyleSummary,
  resolveChapterDisplayTitle,
  storyContextChapterDetails,
  storyContextGlobalSummary,
  storyChapterSummaries,
  styleEvidenceChapterEntries,
  styleEvidenceCharacterEntries,
  styleExampleEntries,
  topCandidateEntries,
  topCharacterEntries,
  topGlossaryEntries,
} from "../formatters/ingestionReport";
import type { ReferenceMangaOption, ReferenceTranslatorOption } from "../types";
import { useLanguageStore } from "../../../stores/language_store";

type IngestionReportPaneProps = {
  embedded?: boolean;
  mangaSeriesLoading: boolean;
  mangaSeriesError: boolean;
  mangaSeriesOptions: ReferenceMangaOption[];
  referenceSets: ReferenceSetSummary[];
  selectedReportMangaId: string;
  selectedReportTranslatorId: string;
  setSelectedReportMangaId: (value: string) => void;
  setSelectedReportTranslatorId: (value: string) => void;
  ingestionReportLoading: boolean;
  ingestionReportError: boolean;
  ingestionReportData?: IngestionKnowledgeReport;
  deleteIngestionPending: boolean;
  deleteExtractionPending: boolean;
  deleteReferencePending: boolean;
  worklistReferenceSetIds: string[];
  addReferenceSetToWorklist: (referenceSet: ReferenceSetSummary) => void;
  addReferenceSetsToWorklist: (referenceSets: ReferenceSetSummary[]) => void;
  confirmDeleteExtraction: (referenceSet: ReferenceSetSummary) => Promise<void>;
  confirmDeleteReference: (referenceSet: ReferenceSetSummary) => Promise<void>;
  confirmDeleteIngestion: (manga: MangaSeriesSummary, translator: TranslatorProfileSummary) => Promise<void>;
};

function observedFallbackLabel(entry: Record<string, unknown>) {
  if (typeof entry.name === "string") return entry.name;
  if (typeof entry.source_term === "string") return entry.source_term;
  return null;
}

function renderObservedList(
  entries: Array<Record<string, unknown>>,
  referenceKind: "source" | "translator",
  emptyText = "無",
) {
  if (entries.length === 0) {
    return <p className="muted-text">{emptyText}</p>;
  }

  return (
    <ul className="artifact-list">
      {entries.map((entry, index) => {
        const summary = describeObservedEntryV2(entry, referenceKind);
        const fallbackLabel = observedFallbackLabel(entry);
        if (!summary.title && !fallbackLabel) {
          return null;
        }
        return (
          <li key={`${referenceKind}-observed-${index}`} className="artifact-item">
            <div>{summary.title || fallbackLabel}</div>
            {summary.details ? <div className="job-subtext">{summary.details}</div> : null}
          </li>
        );
      })}
    </ul>
  );
}

function SummaryMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <strong>{label}</strong>
      <span>{String(value)}</span>
    </div>
  );
}

function renderStoryMentions(entries: Array<{ title: string; details?: string }>, emptyText = "無") {
  if (entries.length === 0) {
    return <p className="muted-text">{emptyText}</p>;
  }

  return (
    <ul className="artifact-list">
      {entries.map((entry, index) => (
        <li key={`story-mention-${index}`} className="artifact-item">
          <div>{entry.title}</div>
          {entry.details ? <div className="job-subtext">{entry.details}</div> : null}
        </li>
      ))}
    </ul>
  );
}

function renderStoryRelationships(
  entries: Array<{
    title: string;
    evidence?: string | null;
    notes?: string | null;
  }>,
  emptyText = "無",
) {
  if (entries.length === 0) {
    return <p className="muted-text">{emptyText}</p>;
  }

  return (
    <ul className="artifact-list">
      {entries.map((entry, index) => (
        <li key={`story-relationship-${index}`} className="artifact-item">
          <div>{entry.title}</div>
          {entry.evidence ? <div className="job-subtext">{`證據：${entry.evidence}`}</div> : null}
          {entry.notes ? <div className="job-subtext">{`備註：${entry.notes}`}</div> : null}
        </li>
      ))}
    </ul>
  );
}

function renderStoryEvents(
  entries: Array<{
    summary: string;
    evidence?: string | null;
    notes?: string | null;
  }>,
  emptyText = "無",
) {
  if (entries.length === 0) {
    return <p className="muted-text">{emptyText}</p>;
  }

  return (
    <ul className="artifact-list">
      {entries.map((entry, index) => (
        <li key={`story-event-${index}`} className="artifact-item">
          <div>{entry.summary}</div>
          {entry.evidence ? <div className="job-subtext">{`證據：${entry.evidence}`}</div> : null}
          {entry.notes ? <div className="job-subtext">{`備註：${entry.notes}`}</div> : null}
        </li>
      ))}
    </ul>
  );
}

function sourceSummaryMetrics(data: IngestionKnowledgeReport) {
  return [
    { label: "已確認專有名詞", value: data.summary.glossaryEntries || 0 },
    { label: "待確認專有名詞", value: data.summary.candidateTerms || 0 },
    { label: "已確認角色", value: data.summary.acceptedCharacters || 0 },
    { label: "已分析章節", value: data.summary.storyChapters || 0 },
    { label: "Story mentions", value: data.summary.storyMentions || 0 },
    { label: "Story relations", value: data.summary.storyRelations || 0 },
    { label: "Story events", value: data.summary.storyEvents || 0 },
    { label: "Key lines", value: data.summary.storyKeyLines || 0 },
  ];
}

function translatorSummaryMetrics(data: IngestionKnowledgeReport) {
  return [
    { label: "已確認專有名詞", value: data.summary.glossaryEntries || 0 },
    { label: "待確認專有名詞", value: data.summary.candidateTerms || 0 },
    { label: "已確認角色", value: data.summary.acceptedCharacters || 0 },
    { label: "已分析章節", value: data.summary.storyChapters || 0 },
    { label: "風格證據章節", value: data.summary.styleEvidenceChapters || 0 },
    { label: "對話範例", value: data.summary.styleDialogueSamples || 0 },
    { label: "旁白範例", value: data.summary.styleNarrationSamples || 0 },
    { label: "角色說話風格", value: data.summary.styleCharacters || 0 },
  ];
}

function SummaryCard({ data, isSourceReference }: { data: IngestionKnowledgeReport; isSourceReference: boolean }) {
  const metrics = isSourceReference ? sourceSummaryMetrics(data) : translatorSummaryMetrics(data);
  return (
    <article className="card">
      <h4>{isSourceReference ? "原文 Reference 摘要" : "譯文 Reference 摘要"}</h4>
      <div className="summary-grid">
        {metrics.map((metric) => (
          <SummaryMetric key={metric.label} label={metric.label} value={metric.value} />
        ))}
      </div>
      <p className="muted-text">
        {isSourceReference
          ? "原文 reference 只用來建立角色、術語與故事上下文，不建立譯文風格。"
          : "譯文 reference 主要提供專有名詞譯法、角色語氣、旁白風格與翻譯例句，不以故事關係與事件為主。"}
      </p>
    </article>
  );
}

function ObservedEntriesCard({
  title,
  entries,
  referenceKind,
}: {
  title: string;
  entries: Array<Record<string, unknown>>;
  referenceKind: "source" | "translator";
}) {
  return (
    <article className="card">
      <h4>{title}</h4>
      {renderObservedList(entries, referenceKind)}
    </article>
  );
}

function reportDerived(data: IngestionKnowledgeReport, translator: TranslatorProfileSummary) {
  const referenceKind = data.referenceKind || "translator";
  const isSourceReference = referenceKind === "source";
  return {
    referenceKind,
    isSourceReference,
    glossaryEntries: topGlossaryEntries(data),
    candidateEntries: topCandidateEntries(data),
    characterEntries: topCharacterEntries(data),
    storyEntries: storyChapterSummaries(data, translator.chapters),
    storyContextGlobal: storyContextGlobalSummary(data),
    storyContextChapters: storyContextChapterDetails(data, translator.chapters),
    styleCharacterEntries: styleEvidenceCharacterEntries(data),
    styleChapterEntries: styleEvidenceChapterEntries(data),
    dialogueExamples: styleExampleEntries(data, "dialogue"),
    narrationExamples: styleExampleEntries(data, "narration"),
    overallStyle: globalStyleSummary(data),
    narrationStyle: narrationStyleSummary(data),
  };
}

function AnalyzedChapterList({
  entries,
  chapters,
}: {
  entries: Array<{
    chapterId: string;
    characterCount: number;
    terminologyCount: number;
  }>;
  chapters: TranslatorProfileSummary["chapters"];
}) {
  if (entries.length === 0) {
    return <p className="muted-text">無</p>;
  }
  return (
    <ul className="artifact-list">
      {entries.map((chapter) => (
        <li key={chapter.chapterId} className="artifact-item">
          <div>{resolveChapterDisplayTitle(chapter.chapterId, chapters) || chapter.chapterId}</div>
          <div className="job-subtext">{`角色 ${chapter.characterCount} / 專有名詞 ${chapter.terminologyCount}`}</div>
        </li>
      ))}
    </ul>
  );
}

function StringListCard({ title, values }: { title: string; values: string[] }) {
  return (
    <article className="card">
      <h5>{`${title}：${values.length}`}</h5>
      {values.length > 0 ? <p className="job-subtext">{values.join("、")}</p> : <p className="muted-text">無</p>}
    </article>
  );
}

function GlobalStoryContextTop({ global }: { global: ReturnType<typeof storyContextGlobalSummary> }) {
  return (
    <>
      <StringListCard title="穩定角色" values={global.characters} />
      <StringListCard title="穩定專有名詞" values={global.terminology} />
      <article className="card">
        <h5>{`關係詞：${global.relationships.length}`}</h5>
        {renderStoryRelationships(global.relationships)}
      </article>
      <article className="card">
        <h5>{`Story mentions：${global.mentions.length}`}</h5>
        {renderStoryMentions(global.mentions)}
      </article>
    </>
  );
}

function GlobalStoryContextBottom({ global }: { global: ReturnType<typeof storyContextGlobalSummary> }) {
  const t = useLanguageStore((state) => state.t);
  return (
    <>
      <article className="card">
        <h5>{`Story events：${global.events.length}`}</h5>
        {renderStoryEvents(global.events)}
      </article>
      <article className="card">
        <h5>{`${t("reference.report.characterStates")}：${global.characterStates.length}`}</h5>
        {renderStoryEvents(global.characterStates)}
      </article>
      <article className="card">
        <h5>{`${t("reference.report.openThreads")}：${global.openThreads.length}`}</h5>
        {renderStoryEvents(global.openThreads)}
      </article>
    </>
  );
}

function GlobalStoryContextCard({ global }: { global: ReturnType<typeof storyContextGlobalSummary> }) {
  return (
    <article className="card">
      <h4>全域故事上下文</h4>
      <div className="card-stack">
        <GlobalStoryContextTop global={global} />
        <GlobalStoryContextBottom global={global} />
      </div>
    </article>
  );
}

function chapterSummaryLine(chapter: {
  characters: string[];
  terminology: string[];
  relationships: Array<unknown>;
  mentions: Array<unknown>;
}) {
  return (
    [
      chapter.characters.length > 0 ? `角色：${chapter.characters.join("、")}` : null,
      chapter.terminology.length > 0 ? `專有名詞：${chapter.terminology.join("、")}` : null,
      chapter.relationships.length > 0 ? `關係數：${chapter.relationships.length}` : null,
      chapter.mentions.length > 0 ? `mentions：${chapter.mentions.length}` : null,
    ]
      .filter(Boolean)
      .join(" / ") || "無角色、專有名詞、mentions 或關係詞摘要"
  );
}

function KeyLinesList({ lines, chapterId }: { lines: string[]; chapterId: string }) {
  return (
    <>
      <div className="job-subtext">Key lines</div>
      <ul className="artifact-list">
        {lines.map((line, index) => (
          <li key={`${chapterId}-line-${index}`} className="artifact-item">
            <div>{line}</div>
          </li>
        ))}
      </ul>
    </>
  );
}

function ChapterStoryMentionsRelationshipsEvents({ chapter }: { chapter: any }) {
  return (
    <>
      {chapter.mentions.length > 0 ? (
        <>
          <div className="job-subtext">Mentions</div>
          {renderStoryMentions(chapter.mentions)}
        </>
      ) : null}
      {chapter.relationships.length > 0 ? (
        <>
          <div className="job-subtext">Relationships</div>
          {renderStoryRelationships(chapter.relationships)}
        </>
      ) : null}
      {chapter.events.length > 0 ? (
        <>
          <div className="job-subtext">Events</div>
          {renderStoryEvents(chapter.events)}
        </>
      ) : null}
    </>
  );
}

function ChapterStoryStatesThreadsKeyLines({ chapter, t }: { chapter: any; t: (key: string) => string }) {
  return (
    <>
      {chapter.characterStates.length > 0 ? (
        <>
          <div className="job-subtext">{t("reference.report.characterStates")}</div>
          {renderStoryEvents(chapter.characterStates)}
        </>
      ) : null}
      {chapter.openThreads.length > 0 ? (
        <>
          <div className="job-subtext">{t("reference.report.openThreads")}</div>
          {renderStoryEvents(chapter.openThreads)}
        </>
      ) : null}
      {chapter.keyLines.length > 0 ? (
        <KeyLinesList lines={chapter.keyLines} chapterId={chapter.chapterId} />
      ) : (
        <p className="muted-text">無關鍵句。</p>
      )}
    </>
  );
}

function ChapterStoryItem({
  chapter,
  chaptersMeta,
  t,
}: {
  chapter: any;
  chaptersMeta: any;
  t: (key: string) => string;
}) {
  return (
    <article className="card">
      <h5>{chapter.title}</h5>
      <div className="job-subtext">{chapterSummaryLine(chapter)}</div>
      <ChapterStoryMentionsRelationshipsEvents chapter={chapter} />
      <ChapterStoryStatesThreadsKeyLines chapter={chapter} t={t} />
    </article>
  );
}

function ChapterStoryContextCard({ chapters, chaptersMeta }: { chapters: any[]; chaptersMeta: any }) {
  const t = useLanguageStore((state) => state.t);
  return (
    <article className="card">
      <h4>章節故事上下文</h4>
      {chapters.length > 0 ? (
        <div className="card-stack">
          {chapters.map((chapter) => (
            <ChapterStoryItem key={chapter.chapterId} chapter={chapter} chaptersMeta={chaptersMeta} t={t} />
          ))}
        </div>
      ) : (
        <p className="muted-text">無</p>
      )}
    </article>
  );
}

function SourceStorySection({
  data,
  translator,
  derived,
}: {
  data: IngestionKnowledgeReport;
  translator: TranslatorProfileSummary;
  derived: ReturnType<typeof reportDerived>;
}) {
  return (
    <>
      <article className="card">
        <h4>{`已分析章節：${data.summary.storyChapters || 0}`}</h4>
        <AnalyzedChapterList entries={derived.storyEntries} chapters={translator.chapters} />
      </article>
      <GlobalStoryContextCard global={derived.storyContextGlobal} />
      <ChapterStoryContextCard chapters={derived.storyContextChapters} chaptersMeta={translator.chapters} />
    </>
  );
}

function StyleSummaryCard({
  overallStyle,
  narrationStyle,
  data,
}: {
  overallStyle: ReturnType<typeof globalStyleSummary>;
  narrationStyle: ReturnType<typeof narrationStyleSummary>;
  data: IngestionKnowledgeReport;
}) {
  return (
    <article className="card">
      <h4>翻譯風格摘要</h4>
      <div className="summary-grid">
        <SummaryMetric
          label="整體風格"
          value={[overallStyle.tone, overallStyle.register].filter(Boolean).join(" / ") || "無"}
        />
        <SummaryMetric
          label="旁白風格"
          value={[narrationStyle.tone, narrationStyle.register].filter(Boolean).join(" / ") || "無"}
        />
        <SummaryMetric label="風格證據章節" value={data.summary.styleEvidenceChapters || 0} />
        <SummaryMetric label="角色說話風格" value={data.summary.styleCharacters || 0} />
      </div>
    </article>
  );
}

function CharacterSpeechCard({ entries }: { entries: Array<Record<string, unknown>> }) {
  return (
    <article className="card">
      <h4>角色說話風格</h4>
      {entries.length > 0 ? (
        <ul className="artifact-list">
          {entries.map((entry, index) => {
            const summary = describeCharacterSpeech(entry);
            return (
              <li key={`style-character-${index}`} className="artifact-item">
                <div>{summary.title}</div>
                {summary.details ? <div className="job-subtext">{summary.details}</div> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted-text">無</p>
      )}
    </article>
  );
}

function ExampleListCard({
  title,
  examples,
  prefix,
}: {
  title: string;
  examples: Array<Record<string, unknown>>;
  prefix: string;
}) {
  return (
    <article className="card">
      <h5>{title}</h5>
      {examples.length > 0 ? (
        <ul className="artifact-list">
          {examples.map((entry, index) => (
            <li key={`${prefix}-example-${index}`} className="artifact-item">
              <div>{String(entry.translation || "")}</div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted-text">無</p>
      )}
    </article>
  );
}

function TranslationExamplesCard({
  dialogueExamples,
  narrationExamples,
}: {
  dialogueExamples: Array<Record<string, unknown>>;
  narrationExamples: Array<Record<string, unknown>>;
}) {
  return (
    <article className="card">
      <h4>翻譯範例</h4>
      <div className="card-stack">
        <ExampleListCard title="對話" examples={dialogueExamples} prefix="dialogue" />
        <ExampleListCard title="旁白" examples={narrationExamples} prefix="narration" />
      </div>
    </article>
  );
}

function styleEvidenceLine(entry: {
  dominantRegister: string | null;
  dialogueRatio: number | null;
  narrationRatio: number | null;
  confidence: number | null;
}) {
  return [
    entry.dominantRegister ? `語體 ${entry.dominantRegister}` : null,
    entry.dialogueRatio !== null ? `對話 ${entry.dialogueRatio}%` : null,
    entry.narrationRatio !== null ? `旁白 ${entry.narrationRatio}%` : null,
    entry.confidence !== null ? `信心 ${entry.confidence}%` : null,
  ]
    .filter(Boolean)
    .join(" / ");
}

function StyleEvidenceEntry({
  entry,
  translator,
}: {
  entry: ReturnType<typeof styleEvidenceChapterEntries>[number];
  translator: TranslatorProfileSummary;
}) {
  return (
    <li className="artifact-item">
      <div>{resolveChapterDisplayTitle(entry.chapterId, translator.chapters) || entry.chapterId}</div>
      <div className="job-subtext">{styleEvidenceLine(entry)}</div>
    </li>
  );
}

function StyleEvidenceDetailsCard({
  entries,
  translator,
}: {
  entries: ReturnType<typeof styleEvidenceChapterEntries>;
  translator: TranslatorProfileSummary;
}) {
  return (
    <details className="settings-section">
      <summary>
        <div>
          <strong>風格證據明細</strong>
          <div className="muted-text">查看每個章節的對話比例、旁白比例與信心分數。</div>
        </div>
      </summary>
      {entries.length > 0 ? (
        <ul className="artifact-list">
          {entries.map((entry) => (
            <StyleEvidenceEntry key={entry.chapterKey} entry={entry} translator={translator} />
          ))}
        </ul>
      ) : (
        <p className="muted-text">無</p>
      )}
    </details>
  );
}

function TranslatorStyleSection({
  data,
  translator,
  derived,
}: {
  data: IngestionKnowledgeReport;
  translator: TranslatorProfileSummary;
  derived: ReturnType<typeof reportDerived>;
}) {
  return (
    <>
      <StyleSummaryCard overallStyle={derived.overallStyle} narrationStyle={derived.narrationStyle} data={data} />
      <CharacterSpeechCard entries={derived.styleCharacterEntries} />
      <TranslationExamplesCard
        dialogueExamples={derived.dialogueExamples}
        narrationExamples={derived.narrationExamples}
      />
      <StyleEvidenceDetailsCard entries={derived.styleChapterEntries} translator={translator} />
    </>
  );
}

type ReportMetaProps = {
  pane: IngestionReportPaneProps;
  manga: ReferenceMangaOption;
  translator: ReferenceTranslatorOption;
  data: IngestionKnowledgeReport;
  t: (key: string) => string;
};

function IngestionReportMeta({ pane, manga, translator, data, t }: ReportMetaProps) {
  return (
    <>
      <p className="reference-inline-meta">
        {`${manga.label} / ${translator.label} / ${t("reference.data.ingestionUpdated")} ${data.ingestionUpdatedAt ? new Date(data.ingestionUpdatedAt).toLocaleString() : "-"}`}
      </p>
      {data.ingestionStale ? <p className="error-text">{t("reference.data.ingestionStale")}</p> : null}
      <div className="button-row">
        <button className="secondary-button danger-button" type="button" disabled={pane.deleteIngestionPending}
          onClick={() => void pane.confirmDeleteIngestion(manga, translator)}>
          刪除 Ingestion 結果
        </button>
      </div>
    </>
  );
}

function IngestionObservedCards({ data, derived }: {
  data: IngestionKnowledgeReport; derived: ReturnType<typeof reportDerived>;
}) {
  return <>
    <ObservedEntriesCard title={`已確認專有名詞：${data.summary.glossaryEntries || 0}`}
      entries={derived.glossaryEntries} referenceKind={derived.referenceKind} />
    <ObservedEntriesCard title={`待確認專有名詞：${data.summary.candidateTerms || 0}`}
      entries={derived.candidateEntries} referenceKind={derived.referenceKind} />
    <ObservedEntriesCard title={`角色相關條目：${data.summary.acceptedCharacters || 0}`}
      entries={derived.characterEntries} referenceKind={derived.referenceKind} />
  </>;
}

type ReportCardStackProps = {
  data: IngestionKnowledgeReport;
  translator: ReferenceTranslatorOption;
  derived: ReturnType<typeof reportDerived>;
};

function IngestionReportCardStack({ data, translator, derived }: ReportCardStackProps) {
  return (
    <div className="card-stack">
      <SummaryCard data={data} isSourceReference={derived.isSourceReference} />
      <IngestionObservedCards data={data} derived={derived} />
      {derived.isSourceReference ? <SourceStorySection data={data} translator={translator} derived={derived} /> : null}
      {!derived.isSourceReference ? (
        <TranslatorStyleSection data={data} translator={translator} derived={derived} />
      ) : null}
    </div>
  );
}

function IngestionReportView({
  pane,
  manga,
  translator,
  data,
}: {
  pane: IngestionReportPaneProps;
  manga: ReferenceMangaOption;
  translator: ReferenceTranslatorOption;
  data: IngestionKnowledgeReport;
}) {
  const t = useLanguageStore((state) => state.t);
  const derived = reportDerived(data, translator);
  return (
    <>
      <IngestionReportMeta pane={pane} manga={manga} translator={translator} data={data} t={t} />
      <IngestionReportCardStack data={data} translator={translator} derived={derived} />
    </>
  );
}

type ExtractionEntryActionsProps = {
  pane: IngestionReportPaneProps;
  entry: ReferenceSetSummary;
  worklistIds: Set<string>;
};

function ExtractionEntryActions({ pane, entry, worklistIds }: ExtractionEntryActionsProps) {
  const t = useLanguageStore((state) => state.t);
  return (
    <>
      <button className="secondary-button" type="button" disabled={worklistIds.has(entry.id)}
        onClick={() => pane.addReferenceSetToWorklist(entry)}>
        {worklistIds.has(entry.id) ? t("reference.data.inWorklist") : t("reference.data.addToWorklist")}
      </button>
      <button className="secondary-button danger-button" type="button"
        disabled={!entry.extractionAvailable || pane.deleteExtractionPending}
        onClick={() => void pane.confirmDeleteExtraction(entry)}>
        {t("reference.data.deleteExtraction")}
      </button>
      <button className="secondary-button danger-button" type="button" disabled={pane.deleteReferencePending}
        onClick={() => void pane.confirmDeleteReference(entry)}>
        {t("reference.worklist.delete")}
      </button>
    </>
  );
}

function ExtractionEntryItem({
  pane,
  entry,
  worklistIds,
}: {
  pane: IngestionReportPaneProps;
  entry: ReferenceSetSummary;
  worklistIds: Set<string>;
}) {
  const t = useLanguageStore((state) => state.t);
  return (
    <li className="artifact-item">
      <div>
        <strong>{entry.chapterTitle || entry.label}</strong>
        <div className="job-subtext">
          {entry.extractionAvailable
            ? `${t("reference.data.extractionReady")} · ${entry.extractionUpdatedAt ? new Date(entry.extractionUpdatedAt).toLocaleString() : "-"}`
            : t("reference.data.extractionMissing")}
        </div>
      </div>
      <ExtractionEntryActions pane={pane} entry={entry} worklistIds={worklistIds} />
    </li>
  );
}

function ExtractionAddAllButton({
  pane,
  entriesOutsideWorklist,
}: {
  pane: IngestionReportPaneProps;
  entriesOutsideWorklist: ReferenceSetSummary[];
}) {
  const t = useLanguageStore((state) => state.t);
  return (
    <button
      className="secondary-button"
      type="button"
      disabled={entriesOutsideWorklist.length === 0}
      onClick={() => pane.addReferenceSetsToWorklist(entriesOutsideWorklist)}
    >
      {entriesOutsideWorklist.length === 0
        ? t("reference.data.allInWorklist")
        : t("reference.data.addAllToWorklist", {
            count: entriesOutsideWorklist.length,
          })}
    </button>
  );
}

type ExtractionListCardProps = {
  pane: IngestionReportPaneProps;
  extractionEntries: ReferenceSetSummary[];
  entriesOutsideWorklist: ReferenceSetSummary[];
  worklistIds: Set<string>;
};

function ExtractionListCard({ pane, extractionEntries, entriesOutsideWorklist, worklistIds }: ExtractionListCardProps) {
  const t = useLanguageStore((state) => state.t);
  return (
    <article className="card">
      <h4>{t("reference.data.extractionList")}</h4>
      {extractionEntries.length > 0 ? (
        <div className="button-row">
          <ExtractionAddAllButton pane={pane} entriesOutsideWorklist={entriesOutsideWorklist} />
        </div>
      ) : null}
      {extractionEntries.length > 0 ? (
        <ul className="artifact-list">
          {extractionEntries.map((entry) => (
            <ExtractionEntryItem key={entry.id} pane={pane} entry={entry} worklistIds={worklistIds} />
          ))}
        </ul>
      ) : (
        <p className="muted-text">{t("reference.data.noExtractions")}</p>
      )}
    </article>
  );
}

function TranslatorToggleButton({
  pane,
  manga,
  translator,
  translatorSelected,
}: {
  pane: IngestionReportPaneProps;
  manga: ReferenceMangaOption;
  translator: ReferenceTranslatorOption;
  translatorSelected: boolean;
}) {
  return (
    <button
      className={translatorSelected ? "reference-selector-item selected" : "reference-selector-item"}
      type="button"
      onClick={() => {
        if (translatorSelected) {
          pane.setSelectedReportTranslatorId("");
          return;
        }
        pane.setSelectedReportMangaId(manga.mangaId);
        pane.setSelectedReportTranslatorId(translator.translatorId);
      }}
    >
      <strong>{translator.label}</strong>
      <span className="job-subtext">{`章節數 ${translator.chapterCount}`}</span>
    </button>
  );
}

type TranslatorReportContentProps = {
  pane: IngestionReportPaneProps;
  manga: ReferenceMangaOption;
  translator: ReferenceTranslatorOption;
  extractionEntries: ReferenceSetSummary[];
  entriesOutsideWorklist: ReferenceSetSummary[];
  worklistIds: Set<string>;
};

function TranslatorReportContent(props: TranslatorReportContentProps) {
  const { pane, manga, translator, extractionEntries, entriesOutsideWorklist, worklistIds } = props;
  return (
    <>
      {!pane.embedded ? (
        <ExtractionListCard
          pane={pane}
          extractionEntries={extractionEntries}
          entriesOutsideWorklist={entriesOutsideWorklist}
          worklistIds={worklistIds}
        />
      ) : null}
      {pane.ingestionReportLoading ? <p>載入 Ingestion 報告中...</p> : null}
      {pane.ingestionReportError ? <p className="error-text">載入 Ingestion 報告失敗。</p> : null}
      {pane.ingestionReportData ? (
        <IngestionReportView pane={pane} manga={manga} translator={translator} data={pane.ingestionReportData} />
      ) : (
        <p className="muted-text">選取譯者後，這裡會顯示 Ingestion 報告。</p>
      )}
    </>
  );
}

function translatorExtractionEntries(
  pane: IngestionReportPaneProps,
  manga: ReferenceMangaOption,
  translator: ReferenceTranslatorOption,
) {
  return pane.referenceSets
    .filter((entry) => entry.mangaId === manga.mangaId && entry.translatorId === translator.translatorId)
    .sort((left, right) => String(left.chapterTitle || left.label).localeCompare(
      String(right.chapterTitle || right.label), undefined, { numeric: true, sensitivity: "base" },
    ));
}

function SelectedTranslatorReport({ pane, manga, translator, entries }: {
  pane: IngestionReportPaneProps;
  manga: ReferenceMangaOption;
  translator: ReferenceTranslatorOption;
  entries: ReferenceSetSummary[];
}) {
  const worklistIds = new Set(pane.worklistReferenceSetIds);
  const outside = entries.filter((entry) => !worklistIds.has(entry.id));
  return (
    <div className="reference-inline-summary">
      <TranslatorReportContent pane={pane} manga={manga} translator={translator}
        extractionEntries={entries} entriesOutsideWorklist={outside} worklistIds={worklistIds} />
    </div>
  );
}

function ReportTranslatorItem({
  pane,
  manga,
  translator,
}: {
  pane: IngestionReportPaneProps;
  manga: ReferenceMangaOption;
  translator: ReferenceTranslatorOption;
}) {
  const translatorSelected = pane.selectedReportTranslatorId === translator.translatorId;
  const extractionEntries = translatorExtractionEntries(pane, manga, translator);
  return (
    <div className="reference-tree-item">
      {!pane.embedded ? (
        <TranslatorToggleButton
          pane={pane}
          manga={manga}
          translator={translator}
          translatorSelected={translatorSelected}
        />
      ) : null}
      {translatorSelected ? (
        <SelectedTranslatorReport pane={pane} manga={manga} translator={translator} entries={extractionEntries} />
      ) : null}
    </div>
  );
}

function ReportTranslatorList({ pane, manga }: { pane: IngestionReportPaneProps; manga: ReferenceMangaOption }) {
  const t = useLanguageStore((state) => state.t);
  if (manga.translators.length === 0) {
    return <p className="muted-text">這部漫畫目前沒有可檢視的譯者 Ingestion。</p>;
  }
  const visibleTranslators = manga.translators.filter(
    (translator) => !pane.embedded || translator.translatorId === pane.selectedReportTranslatorId,
  );
  return (
    <div className="reference-child-list">
      <div className="reference-selector-list">
        {visibleTranslators.map((translator) => (
          <ReportTranslatorItem key={translator.translatorId} pane={pane} manga={manga} translator={translator} />
        ))}
      </div>
    </div>
  );
}

function toggleMangaReportSelection(pane: IngestionReportPaneProps, manga: ReferenceMangaOption, isSelected: boolean) {
  if (isSelected) {
    pane.setSelectedReportMangaId("");
    pane.setSelectedReportTranslatorId("");
    return;
  }
  pane.setSelectedReportMangaId(manga.mangaId);
  pane.setSelectedReportTranslatorId("");
}

function MangaReportButton({
  pane,
  manga,
  isSelected,
}: {
  pane: IngestionReportPaneProps;
  manga: ReferenceMangaOption;
  isSelected: boolean;
}) {
  return (
    <button
      className={isSelected ? "reference-selector-item selected" : "reference-selector-item"}
      type="button"
      onClick={() => toggleMangaReportSelection(pane, manga, isSelected)}
    >
      <strong>{manga.label}</strong>
      <span className="job-subtext">{`譯者數 ${manga.translators.length}`}</span>
    </button>
  );
}

function ReportMangaItem({ pane, manga }: { pane: IngestionReportPaneProps; manga: ReferenceMangaOption }) {
  const isSelected = pane.selectedReportMangaId === manga.mangaId;
  return (
    <div className="reference-tree-item">
      {!pane.embedded ? <MangaReportButton pane={pane} manga={manga} isSelected={isSelected} /> : null}
      {isSelected ? <ReportTranslatorList pane={pane} manga={manga} /> : null}
    </div>
  );
}

function ReportPaneBody(props: IngestionReportPaneProps) {
  if (props.mangaSeriesLoading) {
    return <p>載入漫畫列表中...</p>;
  }
  if (props.mangaSeriesError) {
    return <p className="error-text">載入漫畫列表失敗。</p>;
  }
  if (props.mangaSeriesOptions.length === 0) {
    return <p className="muted-text">尚無 Ingestion 報告可檢視。</p>;
  }
  const visibleManga = props.mangaSeriesOptions.filter(
    (manga) => !props.embedded || manga.mangaId === props.selectedReportMangaId,
  );
  return (
    <div className="reference-selector-list">
      {visibleManga.map((manga) => (
        <ReportMangaItem key={manga.mangaId} pane={props} manga={manga} />
      ))}
    </div>
  );
}

export function IngestionReportPane(props: IngestionReportPaneProps) {
  const t = useLanguageStore((state) => state.t);
  return (
    <SectionCard
      title={t("reference.section.report.title")}
      description={t("reference.section.report.description")}
      defaultOpen={props.embedded}
    >
      <ReportPaneBody {...props} />
    </SectionCard>
  );
}
