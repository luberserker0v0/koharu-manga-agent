import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getJob, getJobArtifactContent, getJobArtifacts, type GuiArtifact } from "../api/jobs";
import { getGlossary, getStoryContext, getStyleProfile } from "../api/knowledge";
import { downloadJobArtifact, openDesktopPath } from "../services/desktop_api";
import { useUiStore } from "../stores/ui_store";

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatBooleanSummary(value: unknown): string {
  if (value === true) {
    return "Yes";
  }
  if (value === false) {
    return "No";
  }
  return "n/a";
}

function prettyArtifactKind(kind: string): string {
  switch (kind) {
    case "quality_validation_report":
      return "Quality validation report";
    case "comparison_self_vs_other":
      return "Legacy comparison snapshot";
    case "comparison_review_report":
      return "Legacy comparison review";
    case "workspace_import_manifest":
      return "Import manifest";
    case "workspace_export_manifest":
      return "Export manifest";
    case "reference_scene":
      return "Reference scene";
    case "reference_texts":
      return "Reference texts";
    case "story_context":
      return "Story context";
    case "style_profile":
      return "Style profile";
    case "translation_memory_snapshot":
      return "Translation memory snapshot";
    case "final_translation_snapshot":
      return "Final translation snapshot";
    case "knowledge_report":
      return "Knowledge learning report";
    default:
      return kind.replaceAll("_", " ");
  }
}

function describeManifestArtifact(artifact: GuiArtifact): string {
  const stage =
    artifact.metadata && typeof artifact.metadata === "object" && "stage" in artifact.metadata
      ? String((artifact.metadata as Record<string, unknown>).stage)
      : "unknown stage";
  return `Stage: ${stage}`;
}
function describeComparisonArtifact(artifact: GuiArtifact): string {
  const metadata = artifact.metadata as Record<string, unknown> | null;
  const referenceSetId = metadata && typeof metadata.referenceSetId === "string" ? metadata.referenceSetId : null;
  const chapterId = metadata && typeof metadata.chapterId === "string" ? metadata.chapterId : null;
  return [referenceSetId ? `Reference: ${referenceSetId}` : null, chapterId ? `Chapter: ${chapterId}` : null]
    .filter(Boolean)
    .join(" / ");
}
function describeArtifact(artifact: GuiArtifact): string {
  if (artifact.kind === "workspace_import_manifest" || artifact.kind === "workspace_export_manifest")
    return describeManifestArtifact(artifact);
  if (
    artifact.kind === "quality_validation_report" ||
    artifact.kind === "comparison_self_vs_other" ||
    artifact.kind === "comparison_review_report"
  )
    return describeComparisonArtifact(artifact);
  return "";
}

function ArtifactListItem({
  artifact,
  onOpen,
  onPreview,
}: {
  artifact: GuiArtifact;
  onOpen: (artifact: GuiArtifact) => void;
  onPreview?: (artifact: GuiArtifact) => void;
}) {
  return (
    <li className="artifact-item">
      <div>
        <strong>{prettyArtifactKind(artifact.kind)}</strong>
        <div className="job-subtext">{artifact.kind}</div>
        {describeArtifact(artifact) ? <div className="job-subtext">{describeArtifact(artifact)}</div> : null}
        <div className="job-subtext">{artifact.fileName}</div>
      </div>
      <div className="job-actions">
        <button className="secondary-button" onClick={() => onOpen(artifact)} type="button">
          Open
        </button>
        {onPreview ? (
          <button className="secondary-button" onClick={() => onPreview(artifact)} type="button">
            Preview
          </button>
        ) : null}
      </div>
    </li>
  );
}
function ArtifactList({
  artifacts,
  title,
  onOpen,
  onPreview,
}: {
  artifacts: GuiArtifact[];
  title: string;
  onOpen: (artifact: GuiArtifact) => void;
  onPreview?: (artifact: GuiArtifact) => void;
}) {
  if (artifacts.length === 0)
    return (
      <article className="card">
        <h2>{title}</h2>
        <p>No artifacts available.</p>
      </article>
    );
  return (
    <article className="card">
      <h2>{title}</h2>
      <ul className="artifact-list">
        {artifacts.map((artifact) => (
          <ArtifactListItem key={artifact.id} artifact={artifact} onOpen={onOpen} onPreview={onPreview} />
        ))}
      </ul>
    </article>
  );
}

function partitionArtifacts(artifacts: GuiArtifact[]) {
  const comparison = artifacts.filter(
    (artifact) =>
      artifact.kind === "quality_validation_report" ||
      artifact.kind === "comparison_self_vs_other" ||
      artifact.kind === "comparison_review_report",
  );
  const workspaceManifests = artifacts.filter(
    (artifact) => artifact.kind === "workspace_import_manifest" || artifact.kind === "workspace_export_manifest",
  );
  const general = artifacts.filter(
    (artifact) => !comparison.includes(artifact) && !workspaceManifests.includes(artifact),
  );

  return {
    comparison,
    workspaceManifests,
    general,
  };
}

type SummaryMetric = { label: string; value: unknown };

function SummaryMetrics({ items }: { items: SummaryMetric[] }) {
  return (
    <div className="summary-grid compact-grid">
      {items.map((item) => (
        <div key={item.label}>
          <strong>{item.label}</strong>
          <span>{String(item.value ?? "n/a")}</span>
        </div>
      ))}
    </div>
  );
}

function CompactList({
  title,
  items,
  render,
}: {
  title: string;
  items: unknown[];
  render?: (item: unknown) => ReactNode;
}) {
  if (!items.length) return null;
  return (
    <div className="compact-list">
      <strong>{title}</strong>
      <ul className="plain-list">
        {items.slice(0, 5).map((item, index) => (
          <li key={index}>{render ? render(item) : String(item)}</li>
        ))}
      </ul>
    </div>
  );
}

function ComparisonSummaryCard({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const summary = record.summary as Record<string, unknown> | undefined;
  if (!summary) return null;
  const metrics = [
    { label: "Matched", value: summary.matchedItems },
    { label: "Different", value: summary.differentTranslation },
    { label: "Only in self", value: summary.onlyInSelf },
    { label: "Only in other", value: summary.onlyInOther },
  ];
  const issues = Array.isArray(record.issues) ? record.issues : [];
  return (
    <>
      <SummaryMetrics items={metrics} />
      <CompactList
        title="Issues"
        items={issues}
        render={(value) => {
          const issue = value as Record<string, unknown>;
          return `${String(issue.type ?? "issue")} - ${String(issue.message ?? "No message")}`;
        }}
      />
    </>
  );
}

function ReviewReportSummaryCard({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") return null;
  const report = data as Record<string, unknown>;
  const scores = report.scores && typeof report.scores === "object" ? (report.scores as Record<string, unknown>) : null;
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const fixes = Array.isArray(report.suggestedFixes) ? report.suggestedFixes : [];
  const metrics = [
    { label: "Overall", value: report.overall },
    { label: "Findings", value: findings.length },
    { label: "Suggested fixes", value: fixes.length },
    { label: "Consistency", value: scores?.consistency },
  ];
  const findingText = (value: unknown) => {
    const item = value as Record<string, unknown>;
    return `${String(item.type ?? "finding")} - ${String(item.message ?? "No message")}`;
  };
  const fixText = (value: unknown) => {
    const item = value as Record<string, unknown>;
    return `${String(item.pageName ?? "unknown page")} - ${String(item.reason ?? "Suggested fix")}`;
  };
  return (
    <>
      <SummaryMetrics items={metrics} />
      <CompactList title="Top findings" items={findings} render={findingText} />
      <CompactList title="Top suggested fixes" items={fixes} render={fixText} />
    </>
  );
}

function StyleMemorySummary({ summary }: { summary: Record<string, unknown> }) {
  const layers = Array.isArray(summary.activeLayers) ? summary.activeLayers : [];
  const coverage =
    summary.coverage && typeof summary.coverage === "object" ? (summary.coverage as Record<string, unknown>) : null;
  const metrics = [
    { label: "Style layers", value: layers.length },
    { label: "Preferred register", value: summary.preferredRegister },
    { label: "Honorifics", value: formatBooleanSummary(summary.preserveHonorifics) },
    { label: "Full-width punctuation", value: formatBooleanSummary(summary.preferFullWidth) },
    { label: "Character voices", value: summary.characterSpeechCount ?? 0 },
    { label: "Story anchors", value: summary.storyAnchorCount ?? 0 },
    { label: "Dialogue examples", value: summary.dialogueExamples ?? 0 },
    { label: "Narration examples", value: summary.narrationExamples ?? 0 },
    { label: "Reference kind", value: summary.referenceKind },
    { label: "Target style allowed", value: formatBooleanSummary(summary.targetStyleAllowed) },
    { label: "Style chapters", value: coverage?.chapterCount ?? 0 },
    { label: "Reference sets", value: coverage?.referenceSetCount ?? 0 },
  ];
  return (
    <>
      <SummaryMetrics items={metrics} />
      <CompactList title="Active style layers" items={layers} />
    </>
  );
}

function QualityValidationSummaryCard({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") return null;
  const report = data as Record<string, unknown>;
  const issues = Array.isArray(report.issues) ? report.issues : [];
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const passed = Array.isArray(report.passedChecks) ? report.passedChecks : [];
  const failed = Array.isArray(report.failedChecks) ? report.failedChecks : [];
  const style =
    report.styleMemorySummary && typeof report.styleMemorySummary === "object"
      ? (report.styleMemorySummary as Record<string, unknown>)
      : null;
  const metrics = [
    { label: "Overall", value: report.overall },
    { label: "Score", value: report.score },
    { label: "Issues", value: issues.length },
    { label: "Warnings", value: warnings.length },
  ];
  return (
    <>
      <SummaryMetrics items={metrics} />
      {style ? <StyleMemorySummary summary={style} /> : null}
      <CompactList title="Failed checks" items={failed} />
      <CompactList title="Passed checks" items={passed} />
    </>
  );
}

function ManifestSummaryCard({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") return null;
  const manifest = data as Record<string, unknown>;
  const accepted = Array.isArray(manifest.accepted) ? manifest.accepted : [];
  const rejected = Array.isArray(manifest.rejected) ? manifest.rejected : [];
  const inputs = Array.isArray(manifest.inputs) ? manifest.inputs : [];
  const metrics = [
    { label: "Stage", value: manifest.stage },
    { label: "Task type", value: manifest.taskType },
    { label: "Accepted", value: accepted.length },
    { label: "Rejected", value: rejected.length },
    ...(inputs.length ? [{ label: "Inputs", value: inputs.length }] : []),
  ];
  const outputName = (value: unknown) => {
    const item = value as Record<string, unknown>;
    return String(item.file ?? item.path ?? "output");
  };
  const rejection = (value: unknown) => {
    const item = value as Record<string, unknown>;
    return `${String(item.file ?? "output")} - ${String(item.reason ?? "Rejected")}`;
  };
  return (
    <>
      <SummaryMetrics items={metrics} />
      <CompactList title="Accepted outputs" items={accepted} render={outputName} />
      <CompactList title="Rejected outputs" items={rejected} render={rejection} />
    </>
  );
}

function GlossarySummaryCard({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const terms = Array.isArray(record.terms) ? record.terms : [];
  const locked = terms.filter(
    (entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).locked === true,
  );
  const termText = (value: unknown) => {
    const item = value as Record<string, unknown>;
    return (
      <>
        {String(item.source_term ?? item.term ?? "term")} {"->"}{" "}
        {String(item.canonical_translation ?? item.translation ?? "n/a")}
      </>
    );
  };
  return (
    <>
      <SummaryMetrics
        items={[
          { label: "Total terms", value: terms.length },
          { label: "Locked terms", value: locked.length },
        ]}
      />
      <CompactList title="Top terms" items={terms} render={termText} />
    </>
  );
}

function StoryContextSummaryCard({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const chapters = Array.isArray(record.chapters) ? record.chapters : [];
  const relationships = Array.isArray(record.relationships) ? record.relationships : [];
  const events = Array.isArray(record.events) ? record.events : [];
  const chapterText = (value: unknown) => {
    const item = value as Record<string, unknown>;
    return `${String(item.chapterId ?? item.id ?? "chapter")} - ${String(item.summary ?? "No summary")}`;
  };
  const recent = chapters.slice(-3).reverse();
  const metrics = [
    { label: "Chapters", value: chapters.length },
    { label: "Relationships", value: relationships.length },
    { label: "Events", value: events.length },
  ];
  return (
    <>
      <SummaryMetrics items={metrics} />
      <CompactList title="Latest chapter notes" items={recent} render={chapterText} />
    </>
  );
}

function StyleProfileSummaryCard({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const notes = Array.isArray(record.notes) ? record.notes : [];
  const honorifics = Array.isArray(record.honorific_policy) ? record.honorific_policy : [];
  const punctuation = Array.isArray(record.punctuation_policy) ? record.punctuation_policy : [];
  const metrics = [
    { label: "Tone", value: record.tone },
    { label: "Register", value: record.register },
    { label: "Honorific rules", value: honorifics.length },
    { label: "Punctuation rules", value: punctuation.length },
  ];
  return (
    <>
      <SummaryMetrics items={metrics} />
      <CompactList title="Notes" items={notes} />
    </>
  );
}

function ArtifactPreviewSummary({
  previewArtifact,
  previewData,
}: {
  previewArtifact: GuiArtifact | null;
  previewData: unknown;
}) {
  if (!previewArtifact || !previewData) return null;
  if (previewArtifact.kind === "comparison_self_vs_other") return <ComparisonSummaryCard data={previewData} />;
  if (previewArtifact.kind === "quality_validation_report") return <QualityValidationSummaryCard data={previewData} />;
  if (previewArtifact.kind === "comparison_review_report") return <ReviewReportSummaryCard data={previewData} />;
  if (previewArtifact.kind === "workspace_import_manifest" || previewArtifact.kind === "workspace_export_manifest")
    return <ManifestSummaryCard data={previewData} />;
  return null;
}

function useSyncSelectedId(payloadValue: unknown, override: string, setter: (value: string | null) => void) {
  useEffect(() => {
    if (!override.trim() && typeof payloadValue === "string" && payloadValue.trim()) setter(payloadValue);
  }, [override, payloadValue, setter]);
}

function useArtifactStoreContext() {
  return {
    selectedJobId: useUiStore((state) => state.selectedJobId),
    selectedMangaId: useUiStore((state) => state.selectedMangaId),
    selectedTranslatorId: useUiStore((state) => state.selectedTranslatorId),
    setSelectedMangaId: useUiStore((state) => state.setSelectedMangaId),
    setSelectedTranslatorId: useUiStore((state) => state.setSelectedTranslatorId),
  };
}

function resolveArtifactIds(
  payload: Record<string, unknown> | undefined,
  mangaInput: string,
  translatorInput: string,
  store: ReturnType<typeof useArtifactStoreContext>,
) {
  return {
    mangaId:
      mangaInput.trim() ||
      store.selectedMangaId?.trim() ||
      (typeof payload?.mangaId === "string" ? payload.mangaId : ""),
    translatorId:
      translatorInput.trim() ||
      store.selectedTranslatorId?.trim() ||
      (typeof payload?.translatorId === "string" ? payload.translatorId : ""),
  };
}

function useArtifactSelection() {
  const store = useArtifactStoreContext();
  const [mangaIdInput, setMangaIdInput] = useState("");
  const [translatorIdInput, setTranslatorIdInput] = useState("");
  const jobQuery = useQuery({
    queryKey: ["artifacts-job", store.selectedJobId],
    queryFn: () => getJob(store.selectedJobId as string),
    enabled: Boolean(store.selectedJobId),
  });
  useSyncSelectedId(jobQuery.data?.payload?.mangaId, mangaIdInput, store.setSelectedMangaId);
  useSyncSelectedId(jobQuery.data?.payload?.translatorId, translatorIdInput, store.setSelectedTranslatorId);
  const { mangaId, translatorId } = resolveArtifactIds(jobQuery.data?.payload, mangaIdInput, translatorIdInput, store);
  return {
    selectedJobId: store.selectedJobId,
    mangaId,
    translatorId,
    mangaIdInput,
    translatorIdInput,
    setMangaIdInput,
    setTranslatorIdInput,
    setSelectedMangaId: store.setSelectedMangaId,
    setSelectedTranslatorId: store.setSelectedTranslatorId,
  };
}

function useArtifactData(selectedJobId: string | null) {
  const query = useQuery({
    queryKey: ["artifacts-list", selectedJobId],
    queryFn: () => getJobArtifacts(selectedJobId as string),
    enabled: Boolean(selectedJobId),
  });
  const partitioned = useMemo(() => partitionArtifacts(query.data?.artifacts || []), [query.data?.artifacts]);
  return { query, partitioned };
}

function useKnowledgeData(mangaId: string, translatorId: string) {
  const glossary = useQuery({
    queryKey: ["glossary", mangaId, translatorId],
    queryFn: () => getGlossary(mangaId, translatorId || null),
    enabled: Boolean(mangaId),
  });
  const story = useQuery({
    queryKey: ["story-context", mangaId, translatorId],
    queryFn: () => getStoryContext(mangaId, translatorId || null),
    enabled: Boolean(mangaId),
  });
  const style = useQuery({
    queryKey: ["style-profile", mangaId, translatorId],
    queryFn: () => getStyleProfile(mangaId, translatorId || null),
    enabled: Boolean(mangaId),
  });
  return { glossary, story, style };
}

function useArtifactPreview(selectedJobId: string | null) {
  const [artifact, setArtifact] = useState<GuiArtifact | null>(null);
  const [data, setData] = useState<unknown>(null);
  const [status, setStatus] = useState("");
  const preview = async (nextArtifact: GuiArtifact) => {
    if (!selectedJobId) return;
    try {
      setArtifact(nextArtifact);
      setStatus("Loading preview...");
      const result = await getJobArtifactContent(selectedJobId, nextArtifact.id);
      setData(result);
      setStatus("Preview loaded.");
    } catch (error) {
      setData(null);
      setStatus(error instanceof Error ? `Failed to load preview: ${error.message}` : "Failed to load preview.");
    }
  };
  const open = async (nextArtifact: GuiArtifact) => {
    if (!selectedJobId) return;
    try {
      const result = await downloadJobArtifact({ jobId: selectedJobId, artifactId: nextArtifact.id });
      await openDesktopPath(result.path);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };
  return { artifact, data, status, preview, open };
}

function OverrideField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="standalone-field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  );
}

function ArtifactContextSummary({ selection }: { selection: ReturnType<typeof useArtifactSelection> }) {
  return (
    <div className="summary-grid">
      <div>
        <strong>Selected job</strong>
        <span>{selection.selectedJobId ?? "Not selected"}</span>
      </div>
      <div>
        <strong>Resolved mangaId</strong>
        <span>{selection.mangaId || "Not set"}</span>
      </div>
      <div>
        <strong>Resolved translatorId</strong>
        <span>{selection.translatorId || "Not set"}</span>
      </div>
    </div>
  );
}

function ArtifactContextCard({
  embedded,
  selection,
}: {
  embedded: boolean;
  selection: ReturnType<typeof useArtifactSelection>;
}) {
  const updateManga = (value: string) => {
    selection.setMangaIdInput(value);
    selection.setSelectedMangaId(value.trim() || null);
  };
  const updateTranslator = (value: string) => {
    selection.setTranslatorIdInput(value);
    selection.setSelectedTranslatorId(value.trim() || null);
  };
  return (
    <article className="card">
      <h2>{embedded ? "Artifact context" : "Current context"}</h2>
      <ArtifactContextSummary selection={selection} />
      <div className="form-grid">
        <OverrideField label="Override mangaId" value={selection.mangaIdInput} onChange={updateManga} />
        <OverrideField label="Override translatorId" value={selection.translatorIdInput} onChange={updateTranslator} />
      </div>
    </article>
  );
}

function ArtifactQueryState({ data }: { data: ReturnType<typeof useArtifactData> }) {
  if (data.query.isLoading)
    return (
      <article className="card">
        <h2>Selected job artifacts</h2>
        <p>Loading artifacts...</p>
      </article>
    );
  if (data.query.isError)
    return (
      <article className="card">
        <h2>Selected job artifacts</h2>
        <p className="error-text">Failed to load artifacts.</p>
      </article>
    );
  return null;
}

function SelectedJobArtifacts({
  selectedJobId,
  data,
  onOpen,
  onPreview,
}: {
  selectedJobId: string | null;
  data: ReturnType<typeof useArtifactData>;
  onOpen: (artifact: GuiArtifact) => void;
  onPreview: (artifact: GuiArtifact) => void;
}) {
  if (!selectedJobId) return null;
  if (data.query.isLoading || data.query.isError) return <ArtifactQueryState data={data} />;
  if (!data.query.data) return null;
  return (
    <>
      <ArtifactList
        artifacts={data.partitioned.comparison}
        title="Quality and comparison reports"
        onOpen={onOpen}
        onPreview={onPreview}
      />
      <ArtifactList artifacts={data.partitioned.workspaceManifests} title="Workspace manifests"
        onOpen={onOpen} onPreview={onPreview} />
      <ArtifactList artifacts={data.partitioned.general} title="Other job artifacts"
        onOpen={onOpen} onPreview={onPreview} />
    </>
  );
}

function ArtifactPreviewCard({ preview }: { preview: ReturnType<typeof useArtifactPreview> }) {
  return (
    <article className="card">
      <h2>Artifact preview</h2>
      {preview.artifact ? (
        <>
          <div className="summary-grid">
            <div>
              <strong>Artifact</strong>
              <span>{prettyArtifactKind(preview.artifact.kind)}</span>
            </div>
            <div>
              <span>{preview.artifact.fileName}</span>
            </div>
          </div>
          <p className="muted-text">{preview.status || "Select an artifact and press Preview."}</p>
          <ArtifactPreviewSummary previewArtifact={preview.artifact} previewData={preview.data} />
          {preview.data ? <pre>{formatJson(preview.data)}</pre> : null}
        </>
      ) : (
        <p>Select an artifact to preview.</p>
      )}
    </article>
  );
}

function KnowledgeCard({
  title,
  mangaId,
  loading,
  error,
  data,
  summary,
}: {
  title: string;
  mangaId: string;
  loading: boolean;
  error: boolean;
  data: unknown;
  summary: ReactNode;
}) {
  return (
    <article className="card">
      <h2>{title}</h2>
      {!mangaId ? <p>Enter a mangaId, or select a job that already includes one.</p> : null}
      {mangaId && loading ? <p>Loading {title.toLowerCase()}...</p> : null}
      {mangaId && error ? <p className="error-text">Failed to load {title.toLowerCase()}.</p> : null}
      {mangaId && data ? (
        <>
          {summary}
          <pre>{formatJson(data)}</pre>
        </>
      ) : null}
    </article>
  );
}

function ArtifactKnowledgeCards({
  selection,
  knowledge,
}: {
  selection: ReturnType<typeof useArtifactSelection>;
  knowledge: ReturnType<typeof useKnowledgeData>;
}) {
  const card = (title: string, query: typeof knowledge.glossary, summary: ReactNode) => (
    <KnowledgeCard
      title={title}
      mangaId={selection.mangaId}
      loading={query.isLoading}
      error={query.isError}
      data={query.data}
      summary={summary}
    />
  );
  return (
    <>
      {card("Local glossary", knowledge.glossary, <GlossarySummaryCard data={knowledge.glossary.data} />)}
      {card("Story context", knowledge.story, <StoryContextSummaryCard data={knowledge.story.data} />)}
      {card("Style profile", knowledge.style, <StyleProfileSummaryCard data={knowledge.style.data} />)}
    </>
  );
}
export function ArtifactsContent({ embedded = false }: { embedded?: boolean }) {
  const selection = useArtifactSelection();
  const artifacts = useArtifactData(selection.selectedJobId);
  const knowledge = useKnowledgeData(selection.mangaId, selection.translatorId);
  const preview = useArtifactPreview(selection.selectedJobId);
  return (
    <section className="page">
      {!embedded ? <h1>Artifacts</h1> : null}
      <div className="card-stack">
        <ArtifactContextCard embedded={embedded} selection={selection} />
        <SelectedJobArtifacts selectedJobId={selection.selectedJobId} data={artifacts}
          onOpen={preview.open} onPreview={preview.preview} />
        <ArtifactPreviewCard preview={preview} />
        <ArtifactKnowledgeCards selection={selection} knowledge={knowledge} />
      </div>
    </section>
  );
}

export function ArtifactsPage() {
  return <ArtifactsContent embedded={false} />;
}
