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
  confirmDeleteIngestion: (
    manga: MangaSeriesSummary,
    translator: TranslatorProfileSummary
  ) => Promise<void>;
};

function renderObservedList(
  entries: Array<Record<string, unknown>>,
  referenceKind: "source" | "translator",
  emptyText = "無"
) {
  if (entries.length === 0) {
    return <p className="muted-text">{emptyText}</p>;
  }

  return (
    <ul className="artifact-list">
      {entries.map((entry, index) => {
        const summary = describeObservedEntryV2(entry, referenceKind);
        const fallbackLabel =
          typeof entry.name === "string"
            ? entry.name
            : typeof entry.source_term === "string"
              ? entry.source_term
              : null;
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

function renderStoryMentions(
  entries: Array<{ title: string; details?: string }>,
  emptyText = "無"
) {
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
  entries: Array<{ title: string; evidence?: string | null; notes?: string | null }>,
  emptyText = "無"
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
  entries: Array<{ summary: string; evidence?: string | null; notes?: string | null }>,
  emptyText = "無"
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

export function IngestionReportPane({
  mangaSeriesLoading,
  mangaSeriesError,
  mangaSeriesOptions,
  referenceSets,
  selectedReportMangaId,
  selectedReportTranslatorId,
  setSelectedReportMangaId,
  setSelectedReportTranslatorId,
  ingestionReportLoading,
  ingestionReportError,
  ingestionReportData,
  deleteIngestionPending,
  deleteExtractionPending,
  deleteReferencePending,
  worklistReferenceSetIds,
  addReferenceSetToWorklist,
  addReferenceSetsToWorklist,
  confirmDeleteExtraction,
  confirmDeleteReference,
  confirmDeleteIngestion,
}: IngestionReportPaneProps) {
  const t = useLanguageStore((state) => state.t);
  return (
    <SectionCard
      title="Extraction / Ingestion 資料"
      description="先選漫畫與譯者，再管理各章 Extraction 與該譯者唯一一份 Ingestion 資料。"
    >
      {mangaSeriesLoading ? <p>載入漫畫列表中...</p> : null}
      {mangaSeriesError ? <p className="error-text">載入漫畫列表失敗。</p> : null}
      {!mangaSeriesLoading && !mangaSeriesError ? (
        mangaSeriesOptions.length > 0 ? (
          <div className="reference-selector-list">
            {mangaSeriesOptions.map((manga) => {
              const isSelected = selectedReportMangaId === manga.mangaId;
              return (
                <div key={manga.mangaId} className="reference-tree-item">
                  <button
                    className={isSelected ? "reference-selector-item selected" : "reference-selector-item"}
                    type="button"
                    onClick={() => {
                      if (isSelected) {
                        setSelectedReportMangaId("");
                        setSelectedReportTranslatorId("");
                        return;
                      }
                      setSelectedReportMangaId(manga.mangaId);
                      setSelectedReportTranslatorId("");
                    }}
                  >
                    <strong>{manga.label}</strong>
                    <span className="job-subtext">{`譯者數 ${manga.translators.length}`}</span>
                  </button>
                  {isSelected ? (
                    <div className="reference-child-list">
                      {manga.translators.length > 0 ? (
                        <div className="reference-selector-list">
                          {manga.translators.map((translator: ReferenceTranslatorOption) => {
                            const translatorSelected =
                              selectedReportTranslatorId === translator.translatorId;
                            const extractionEntries = referenceSets
                              .filter(
                                (entry) =>
                                  entry.mangaId === manga.mangaId &&
                                  entry.translatorId === translator.translatorId
                              )
                              .sort((left, right) =>
                                String(left.chapterTitle || left.label).localeCompare(
                                  String(right.chapterTitle || right.label),
                                  undefined,
                                  { numeric: true, sensitivity: "base" }
                                )
                              );
                            const worklistIds = new Set(worklistReferenceSetIds);
                            const entriesOutsideWorklist = extractionEntries.filter(
                              (entry) => !worklistIds.has(entry.id)
                            );
                            return (
                              <div key={translator.translatorId} className="reference-tree-item">
                                <button
                                  className={
                                    translatorSelected
                                      ? "reference-selector-item selected"
                                      : "reference-selector-item"
                                  }
                                  type="button"
                                  onClick={() => {
                                    if (translatorSelected) {
                                      setSelectedReportTranslatorId("");
                                      return;
                                    }
                                    setSelectedReportMangaId(manga.mangaId);
                                    setSelectedReportTranslatorId(translator.translatorId);
                                  }}
                                >
                                  <strong>{translator.label}</strong>
                                  <span className="job-subtext">{`章節數 ${translator.chapterCount}`}</span>
                                </button>
                                {translatorSelected ? (
                                  <div className="reference-inline-summary">
                                    <article className="card">
                                      <h4>{t("reference.data.extractionList")}</h4>
                                      {extractionEntries.length > 0 ? (
                                        <div className="button-row">
                                          <button
                                            className="secondary-button"
                                            type="button"
                                            disabled={entriesOutsideWorklist.length === 0}
                                            onClick={() => addReferenceSetsToWorklist(entriesOutsideWorklist)}
                                          >
                                            {entriesOutsideWorklist.length === 0
                                              ? t("reference.data.allInWorklist")
                                              : t("reference.data.addAllToWorklist", {
                                                  count: entriesOutsideWorklist.length,
                                                })}
                                          </button>
                                        </div>
                                      ) : null}
                                      {extractionEntries.length > 0 ? (
                                        <ul className="artifact-list">
                                          {extractionEntries.map((entry) => (
                                            <li key={entry.id} className="artifact-item">
                                              <div>
                                                <strong>{entry.chapterTitle || entry.label}</strong>
                                                <div className="job-subtext">
                                                  {entry.extractionAvailable
                                                    ? `${t("reference.data.extractionReady")} · ${entry.extractionUpdatedAt ? new Date(entry.extractionUpdatedAt).toLocaleString() : "-"}`
                                                    : t("reference.data.extractionMissing")}
                                                </div>
                                              </div>
                                              <button
                                                className="secondary-button"
                                                type="button"
                                                disabled={worklistIds.has(entry.id)}
                                                onClick={() => addReferenceSetToWorklist(entry)}
                                              >
                                                {worklistIds.has(entry.id)
                                                  ? t("reference.data.inWorklist")
                                                  : t("reference.data.addToWorklist")}
                                              </button>
                                              <button
                                                className="secondary-button danger-button"
                                                type="button"
                                                disabled={!entry.extractionAvailable || deleteExtractionPending}
                                                onClick={() => void confirmDeleteExtraction(entry)}
                                              >
                                                {t("reference.data.deleteExtraction")}
                                              </button>
                                              <button
                                                className="secondary-button danger-button"
                                                type="button"
                                                disabled={deleteReferencePending}
                                                onClick={() => void confirmDeleteReference(entry)}
                                              >
                                                {t("reference.worklist.delete")}
                                              </button>
                                            </li>
                                          ))}
                                        </ul>
                                      ) : (
                                        <p className="muted-text">{t("reference.data.noExtractions")}</p>
                                      )}
                                    </article>
                                    {ingestionReportLoading ? <p>載入 Ingestion 報告中...</p> : null}
                                    {ingestionReportError ? (
                                      <p className="error-text">載入 Ingestion 報告失敗。</p>
                                    ) : null}
                                    {ingestionReportData ? (
                                      (() => {
                                        if (!ingestionReportData.ingestionAvailable) {
                                          return (
                                            <article className="card">
                                              <h4>{t("reference.data.ingestion")}</h4>
                                              <p className="muted-text">{t("reference.data.noIngestion")}</p>
                                            </article>
                                          );
                                        }
                                        const referenceKind =
                                          ingestionReportData.referenceKind || "translator";
                                        const isSourceReference = referenceKind === "source";
                                        const glossaryEntries = topGlossaryEntries(ingestionReportData);
                                        const candidateEntries = topCandidateEntries(ingestionReportData);
                                        const characterEntries = topCharacterEntries(ingestionReportData);
                                        const storyEntries = storyChapterSummaries(
                                          ingestionReportData,
                                          translator.chapters
                                        );
                                        const storyContextGlobal =
                                          storyContextGlobalSummary(ingestionReportData);
                                        const storyContextChapters = storyContextChapterDetails(
                                          ingestionReportData,
                                          translator.chapters
                                        );
                                        const styleCharacterEntries =
                                          styleEvidenceCharacterEntries(ingestionReportData);
                                        const styleChapterEntries =
                                          styleEvidenceChapterEntries(ingestionReportData);
                                        const dialogueExamples = styleExampleEntries(
                                          ingestionReportData,
                                          "dialogue"
                                        );
                                        const narrationExamples = styleExampleEntries(
                                          ingestionReportData,
                                          "narration"
                                        );
                                        const overallStyle = globalStyleSummary(ingestionReportData);
                                        const narrationStyle =
                                          narrationStyleSummary(ingestionReportData);

                                        return (
                                          <>
                                            <p className="reference-inline-meta">
                                              {`${manga.label} / ${translator.label} / ${t("reference.data.ingestionUpdated")} ${ingestionReportData.ingestionUpdatedAt ? new Date(ingestionReportData.ingestionUpdatedAt).toLocaleString() : "-"}`}
                                            </p>
                                            {ingestionReportData.ingestionStale ? (
                                              <p className="error-text">{t("reference.data.ingestionStale")}</p>
                                            ) : null}
                                            <div className="button-row">
                                              <button
                                                className="secondary-button danger-button"
                                                type="button"
                                                disabled={deleteIngestionPending}
                                                onClick={() =>
                                                  void confirmDeleteIngestion(manga, translator)
                                                }
                                              >
                                                刪除 Ingestion 結果
                                              </button>
                                            </div>

                                            <div className="card-stack">
                                              <article className="card">
                                                <h4>
                                                  {isSourceReference
                                                    ? "原文 Reference 摘要"
                                                    : "譯文 Reference 摘要"}
                                                </h4>
                                                <div className="summary-grid">
                                                  <SummaryMetric
                                                    label="已確認專有名詞"
                                                    value={ingestionReportData.summary.glossaryEntries || 0}
                                                  />
                                                  <SummaryMetric
                                                    label="待確認專有名詞"
                                                    value={ingestionReportData.summary.candidateTerms || 0}
                                                  />
                                                  <SummaryMetric
                                                    label="已確認角色"
                                                    value={ingestionReportData.summary.acceptedCharacters || 0}
                                                  />
                                                  <SummaryMetric
                                                    label="已分析章節"
                                                    value={ingestionReportData.summary.storyChapters || 0}
                                                  />
                                                  {isSourceReference ? (
                                                    <>
                                                      <SummaryMetric
                                                        label="Story mentions"
                                                        value={ingestionReportData.summary.storyMentions || 0}
                                                      />
                                                      <SummaryMetric
                                                        label="Story relations"
                                                        value={ingestionReportData.summary.storyRelations || 0}
                                                      />
                                                      <SummaryMetric
                                                        label="Story events"
                                                        value={ingestionReportData.summary.storyEvents || 0}
                                                      />
                                                      <SummaryMetric
                                                        label="Key lines"
                                                        value={ingestionReportData.summary.storyKeyLines || 0}
                                                      />
                                                    </>
                                                  ) : (
                                                    <>
                                                      <SummaryMetric
                                                        label="風格證據章節"
                                                        value={
                                                          ingestionReportData.summary.styleEvidenceChapters || 0
                                                        }
                                                      />
                                                      <SummaryMetric
                                                        label="對話範例"
                                                        value={ingestionReportData.summary.styleDialogueSamples || 0}
                                                      />
                                                      <SummaryMetric
                                                        label="旁白範例"
                                                        value={ingestionReportData.summary.styleNarrationSamples || 0}
                                                      />
                                                      <SummaryMetric
                                                        label="角色說話風格"
                                                        value={ingestionReportData.summary.styleCharacters || 0}
                                                      />
                                                    </>
                                                  )}
                                                </div>
                                                <p className="muted-text">
                                                  {isSourceReference
                                                    ? "原文 reference 只用來建立角色、術語與故事上下文，不建立譯文風格。"
                                                    : "譯文 reference 主要提供專有名詞譯法、角色語氣、旁白風格與翻譯例句，不以故事關係與事件為主。"}
                                                </p>
                                              </article>

                                              <article className="card">
                                                <h4>{`已確認專有名詞：${ingestionReportData.summary.glossaryEntries || 0}`}</h4>
                                                {renderObservedList(glossaryEntries, referenceKind)}
                                              </article>

                                              <article className="card">
                                                <h4>{`待確認專有名詞：${ingestionReportData.summary.candidateTerms || 0}`}</h4>
                                                {renderObservedList(candidateEntries, referenceKind)}
                                              </article>

                                              <article className="card">
                                                <h4>{`角色相關條目：${ingestionReportData.summary.acceptedCharacters || 0}`}</h4>
                                                {renderObservedList(characterEntries, referenceKind)}
                                              </article>

                                              {isSourceReference ? (
                                                <>
                                                  <article className="card">
                                                    <h4>{`已分析章節：${ingestionReportData.summary.storyChapters || 0}`}</h4>
                                                    {storyEntries.length > 0 ? (
                                                      <ul className="artifact-list">
                                                        {storyEntries.map((chapter) => (
                                                          <li key={chapter.chapterId} className="artifact-item">
                                                            <div>
                                                              {resolveChapterDisplayTitle(
                                                                chapter.chapterId,
                                                                translator.chapters
                                                              ) || chapter.chapterId}
                                                            </div>
                                                            <div className="job-subtext">
                                                              {`角色 ${chapter.characterCount} / 專有名詞 ${chapter.terminologyCount}`}
                                                            </div>
                                                          </li>
                                                        ))}
                                                      </ul>
                                                    ) : (
                                                      <p className="muted-text">無</p>
                                                    )}
                                                  </article>

                                                  <article className="card">
                                                    <h4>全域故事上下文</h4>
                                                    <div className="card-stack">
                                                      <article className="card">
                                                        <h5>{`穩定角色：${storyContextGlobal.characters.length}`}</h5>
                                                        {storyContextGlobal.characters.length > 0 ? (
                                                          <p className="job-subtext">
                                                            {storyContextGlobal.characters.join("、")}
                                                          </p>
                                                        ) : (
                                                          <p className="muted-text">無</p>
                                                        )}
                                                      </article>
                                                      <article className="card">
                                                        <h5>{`穩定專有名詞：${storyContextGlobal.terminology.length}`}</h5>
                                                        {storyContextGlobal.terminology.length > 0 ? (
                                                          <p className="job-subtext">
                                                            {storyContextGlobal.terminology.join("、")}
                                                          </p>
                                                        ) : (
                                                          <p className="muted-text">無</p>
                                                        )}
                                                      </article>
                                                      <article className="card">
                                                        <h5>{`關係詞：${storyContextGlobal.relationships.length}`}</h5>
                                                        {renderStoryRelationships(
                                                          storyContextGlobal.relationships
                                                        )}
                                                      </article>
                                                      <article className="card">
                                                        <h5>{`Story mentions：${storyContextGlobal.mentions.length}`}</h5>
                                                        {renderStoryMentions(storyContextGlobal.mentions)}
                                                      </article>
                                                      <article className="card">
                                                        <h5>{`Story events：${storyContextGlobal.events.length}`}</h5>
                                                        {renderStoryEvents(storyContextGlobal.events)}
                                                      </article>
                                                      <article className="card">
                                                        <h5>{`${t("reference.report.characterStates")}：${storyContextGlobal.characterStates.length}`}</h5>
                                                        {renderStoryEvents(storyContextGlobal.characterStates)}
                                                      </article>
                                                      <article className="card">
                                                        <h5>{`${t("reference.report.openThreads")}：${storyContextGlobal.openThreads.length}`}</h5>
                                                        {renderStoryEvents(storyContextGlobal.openThreads)}
                                                      </article>
                                                    </div>
                                                  </article>

                                                  <article className="card">
                                                    <h4>章節故事上下文</h4>
                                                    {storyContextChapters.length > 0 ? (
                                                      <div className="card-stack">
                                                        {storyContextChapters.map((chapter) => (
                                                          <article key={chapter.chapterId} className="card">
                                                            <h5>{chapter.title}</h5>
                                                            <div className="job-subtext">
                                                              {[
                                                                chapter.characters.length > 0
                                                                  ? `角色：${chapter.characters.join("、")}`
                                                                  : null,
                                                                chapter.terminology.length > 0
                                                                  ? `專有名詞：${chapter.terminology.join("、")}`
                                                                  : null,
                                                                chapter.relationships.length > 0
                                                                  ? `關係數：${chapter.relationships.length}`
                                                                  : null,
                                                                chapter.mentions.length > 0
                                                                  ? `mentions：${chapter.mentions.length}`
                                                                  : null,
                                                              ]
                                                                .filter(Boolean)
                                                                .join(" / ") || "無角色、專有名詞、mentions 或關係詞摘要"}
                                                            </div>
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
                                                              <>
                                                                <div className="job-subtext">Key lines</div>
                                                                <ul className="artifact-list">
                                                                  {chapter.keyLines.map((line, index) => (
                                                                    <li
                                                                      key={`${chapter.chapterId}-line-${index}`}
                                                                      className="artifact-item"
                                                                    >
                                                                      <div>{line}</div>
                                                                    </li>
                                                                  ))}
                                                                </ul>
                                                              </>
                                                            ) : (
                                                              <p className="muted-text">無關鍵句。</p>
                                                            )}
                                                          </article>
                                                        ))}
                                                      </div>
                                                    ) : (
                                                      <p className="muted-text">無</p>
                                                    )}
                                                  </article>
                                                </>
                                              ) : null}

                                              {!isSourceReference ? (
                                                <>
                                                  <article className="card">
                                                    <h4>翻譯風格摘要</h4>
                                                    <div className="summary-grid">
                                                      <SummaryMetric
                                                        label="整體風格"
                                                        value={
                                                          [overallStyle.tone, overallStyle.register]
                                                            .filter(Boolean)
                                                            .join(" / ") || "無"
                                                        }
                                                      />
                                                      <SummaryMetric
                                                        label="旁白風格"
                                                        value={
                                                          [narrationStyle.tone, narrationStyle.register]
                                                            .filter(Boolean)
                                                            .join(" / ") || "無"
                                                        }
                                                      />
                                                      <SummaryMetric
                                                        label="風格證據章節"
                                                        value={ingestionReportData.summary.styleEvidenceChapters || 0}
                                                      />
                                                      <SummaryMetric
                                                        label="角色說話風格"
                                                        value={ingestionReportData.summary.styleCharacters || 0}
                                                      />
                                                    </div>
                                                  </article>

                                                  <article className="card">
                                                    <h4>角色說話風格</h4>
                                                    {styleCharacterEntries.length > 0 ? (
                                                      <ul className="artifact-list">
                                                        {styleCharacterEntries.map((entry, index) => {
                                                          const summary = describeCharacterSpeech(entry);
                                                          return (
                                                            <li
                                                              key={`style-character-${index}`}
                                                              className="artifact-item"
                                                            >
                                                              <div>{summary.title}</div>
                                                              {summary.details ? (
                                                                <div className="job-subtext">
                                                                  {summary.details}
                                                                </div>
                                                              ) : null}
                                                            </li>
                                                          );
                                                        })}
                                                      </ul>
                                                    ) : (
                                                      <p className="muted-text">無</p>
                                                    )}
                                                  </article>

                                                  <article className="card">
                                                    <h4>翻譯範例</h4>
                                                    <div className="card-stack">
                                                      <article className="card">
                                                        <h5>對話</h5>
                                                        {dialogueExamples.length > 0 ? (
                                                          <ul className="artifact-list">
                                                            {dialogueExamples.map((entry, index) => (
                                                              <li
                                                                key={`dialogue-example-${index}`}
                                                                className="artifact-item"
                                                              >
                                                                <div>{String(entry.translation || "")}</div>
                                                              </li>
                                                            ))}
                                                          </ul>
                                                        ) : (
                                                          <p className="muted-text">無</p>
                                                        )}
                                                      </article>
                                                      <article className="card">
                                                        <h5>旁白</h5>
                                                        {narrationExamples.length > 0 ? (
                                                          <ul className="artifact-list">
                                                            {narrationExamples.map((entry, index) => (
                                                              <li
                                                                key={`narration-example-${index}`}
                                                                className="artifact-item"
                                                              >
                                                                <div>{String(entry.translation || "")}</div>
                                                              </li>
                                                            ))}
                                                          </ul>
                                                        ) : (
                                                          <p className="muted-text">無</p>
                                                        )}
                                                      </article>
                                                    </div>
                                                  </article>

                                                  <details className="settings-section">
                                                    <summary>
                                                      <div>
                                                        <strong>風格證據明細</strong>
                                                        <div className="muted-text">
                                                          查看每個章節的對話比例、旁白比例與信心分數。
                                                        </div>
                                                      </div>
                                                    </summary>
                                                    {styleChapterEntries.length > 0 ? (
                                                      <ul className="artifact-list">
                                                        {styleChapterEntries.map((entry) => (
                                                          <li
                                                            key={entry.chapterKey}
                                                            className="artifact-item"
                                                          >
                                                            <div>
                                                              {resolveChapterDisplayTitle(
                                                                entry.chapterId,
                                                                translator.chapters
                                                              ) || entry.chapterId}
                                                            </div>
                                                            <div className="job-subtext">
                                                              {[
                                                                entry.dominantRegister
                                                                  ? `語體 ${entry.dominantRegister}`
                                                                  : null,
                                                                entry.dialogueRatio !== null
                                                                  ? `對話 ${entry.dialogueRatio}%`
                                                                  : null,
                                                                entry.narrationRatio !== null
                                                                  ? `旁白 ${entry.narrationRatio}%`
                                                                  : null,
                                                                entry.confidence !== null
                                                                  ? `信心 ${entry.confidence}%`
                                                                  : null,
                                                              ]
                                                                .filter(Boolean)
                                                                .join(" / ")}
                                                            </div>
                                                          </li>
                                                        ))}
                                                      </ul>
                                                    ) : (
                                                      <p className="muted-text">無</p>
                                                    )}
                                                  </details>
                                                </>
                                              ) : null}
                                            </div>
                                          </>
                                        );
                                      })()
                                    ) : (
                                      <p className="muted-text">
                                        選取譯者後，這裡會顯示 Ingestion 報告。
                                      </p>
                                    )}
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="muted-text">這部漫畫目前沒有可檢視的譯者 Ingestion。</p>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="muted-text">尚無 Ingestion 報告可檢視。</p>
        )
      ) : null}
    </SectionCard>
  );
}
