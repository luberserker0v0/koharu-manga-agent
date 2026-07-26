import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { getJob, getJobArtifacts, type GuiArtifact } from "../api/jobs";
import { getGlossary, getStoryContext, getStyleProfile } from "../api/knowledge";
import { openDesktopPath, readJsonFile } from "../services/desktop_api";
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

function describeArtifact(artifact: GuiArtifact): string {
  if (
    artifact.kind === "workspace_import_manifest" ||
    artifact.kind === "workspace_export_manifest"
  ) {
    const stage =
      artifact.metadata &&
      typeof artifact.metadata === "object" &&
      "stage" in artifact.metadata
        ? String((artifact.metadata as Record<string, unknown>).stage)
        : "unknown stage";
    return `Stage: ${stage}`;
  }

  if (
    artifact.kind === "quality_validation_report" ||
    artifact.kind === "comparison_self_vs_other" ||
    artifact.kind === "comparison_review_report"
  ) {
    const metadata = artifact.metadata as Record<string, unknown> | null;
    const referenceSetId =
      metadata && typeof metadata.referenceSetId === "string" ? metadata.referenceSetId : null;
    const chapterId =
      metadata && typeof metadata.chapterId === "string" ? metadata.chapterId : null;
    return [
      referenceSetId ? `Reference: ${referenceSetId}` : null,
      chapterId ? `Chapter: ${chapterId}` : null,
    ]
      .filter(Boolean)
      .join(" / ");
  }

  return "";
}

function ArtifactList({
  artifacts,
  title,
  onPreview,
}: {
  artifacts: GuiArtifact[];
  title: string;
  onPreview?: (artifact: GuiArtifact) => void;
}) {
  if (artifacts.length === 0) {
    return (
      <article className="card">
        <h2>{title}</h2>
        <p>No artifacts available.</p>
      </article>
    );
  }

  return (
    <article className="card">
      <h2>{title}</h2>
      <ul className="artifact-list">
        {artifacts.map((artifact) => (
          <li key={artifact.id} className="artifact-item">
            <div>
              <strong>{prettyArtifactKind(artifact.kind)}</strong>
              <div className="job-subtext">{artifact.kind}</div>
              {describeArtifact(artifact) ? <div className="job-subtext">{describeArtifact(artifact)}</div> : null}
              <div className="job-subtext">{artifact.path}</div>
            </div>
            <div className="job-actions">
              <button
                className="secondary-button"
                onClick={() => openDesktopPath(artifact.path)}
                type="button"
              >
                Open
              </button>
              {onPreview ? (
                <button
                  className="secondary-button"
                  onClick={() => onPreview(artifact)}
                  type="button"
                >
                  Preview
                </button>
              ) : null}
            </div>
          </li>
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
      artifact.kind === "comparison_review_report"
  );
  const workspaceManifests = artifacts.filter(
    (artifact) =>
      artifact.kind === "workspace_import_manifest" ||
      artifact.kind === "workspace_export_manifest"
  );
  const general = artifacts.filter(
    (artifact) => !comparison.includes(artifact) && !workspaceManifests.includes(artifact)
  );

  return {
    comparison,
    workspaceManifests,
    general,
  };
}

function ComparisonSummaryCard({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") {
    return null;
  }

  const comparisonRecord = data as Record<string, unknown>;
  const summary =
    "summary" in comparisonRecord
      ? (comparisonRecord.summary as Record<string, unknown> | undefined)
      : undefined;
  const issues = Array.isArray(comparisonRecord.issues)
    ? (comparisonRecord.issues as Array<Record<string, unknown>>)
    : [];
  if (!summary) {
    return null;
  }

  return (
    <>
      <div className="summary-grid compact-grid">
        <div>
          <strong>Matched</strong>
          <span>{String(summary.matchedItems ?? "n/a")}</span>
        </div>
        <div>
          <strong>Different</strong>
          <span>{String(summary.differentTranslation ?? "n/a")}</span>
        </div>
        <div>
          <strong>Only in self</strong>
          <span>{String(summary.onlyInSelf ?? "n/a")}</span>
        </div>
        <div>
          <strong>Only in other</strong>
          <span>{String(summary.onlyInOther ?? "n/a")}</span>
        </div>
      </div>
      {issues.length > 0 ? (
        <div className="compact-list">
          <strong>Issues</strong>
          <ul className="plain-list">
            {issues.slice(0, 5).map((issue, index) => (
              <li key={index}>
                {String(issue.type ?? "issue")} - {String(issue.message ?? "No message")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function ReviewReportSummaryCard({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") {
    return null;
  }

  const report = data as Record<string, unknown>;
  const scores =
    report.scores && typeof report.scores === "object"
      ? (report.scores as Record<string, unknown>)
      : null;
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const fixes = Array.isArray(report.suggestedFixes) ? report.suggestedFixes : [];

  return (
    <>
      <div className="summary-grid compact-grid">
        <div>
          <strong>Overall</strong>
          <span>{String(report.overall ?? "n/a")}</span>
        </div>
        <div>
          <strong>Findings</strong>
          <span>{String(findings.length)}</span>
        </div>
        <div>
          <strong>Suggested fixes</strong>
          <span>{String(fixes.length)}</span>
        </div>
        <div>
          <strong>Consistency</strong>
          <span>{scores ? String(scores.consistency ?? "n/a") : "n/a"}</span>
        </div>
      </div>
      {findings.length > 0 ? (
        <div className="compact-list">
          <strong>Top findings</strong>
          <ul className="plain-list">
            {findings.slice(0, 5).map((finding, index) => {
              const entry = finding as Record<string, unknown>;
              return (
                <li key={index}>
                  {String(entry.type ?? "finding")} - {String(entry.message ?? "No message")}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {fixes.length > 0 ? (
        <div className="compact-list">
          <strong>Top suggested fixes</strong>
          <ul className="plain-list">
            {fixes.slice(0, 5).map((fix, index) => {
              const entry = fix as Record<string, unknown>;
              return (
                <li key={index}>
                  {String(entry.pageName ?? "unknown page")} - {String(entry.reason ?? "Suggested fix")}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function QualityValidationSummaryCard({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") {
    return null;
  }

  const report = data as Record<string, unknown>;
  const issues = Array.isArray(report.issues) ? report.issues : [];
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const passedChecks = Array.isArray(report.passedChecks) ? report.passedChecks : [];
  const failedChecks = Array.isArray(report.failedChecks) ? report.failedChecks : [];
  const styleMemorySummary =
    report.styleMemorySummary && typeof report.styleMemorySummary === "object"
      ? (report.styleMemorySummary as Record<string, unknown>)
      : null;
  const activeLayers = Array.isArray(styleMemorySummary?.activeLayers)
    ? styleMemorySummary.activeLayers
    : [];
  const coverage =
    styleMemorySummary?.coverage && typeof styleMemorySummary.coverage === "object"
      ? (styleMemorySummary.coverage as Record<string, unknown>)
      : null;

  return (
    <>
      <div className="summary-grid compact-grid">
        <div>
          <strong>Overall</strong>
          <span>{String(report.overall ?? "n/a")}</span>
        </div>
        <div>
          <strong>Score</strong>
          <span>{String(report.score ?? "n/a")}</span>
        </div>
        <div>
          <strong>Issues</strong>
          <span>{String(issues.length)}</span>
        </div>
        <div>
          <strong>Warnings</strong>
          <span>{String(warnings.length)}</span>
        </div>
      </div>
      {styleMemorySummary ? (
        <>
          <div className="summary-grid compact-grid">
            <div>
              <strong>Style layers</strong>
              <span>{String(activeLayers.length)}</span>
            </div>
            <div>
              <strong>Preferred register</strong>
              <span>{String(styleMemorySummary.preferredRegister ?? "n/a")}</span>
            </div>
            <div>
              <strong>Honorifics</strong>
              <span>{formatBooleanSummary(styleMemorySummary.preserveHonorifics)}</span>
            </div>
            <div>
              <strong>Full-width punctuation</strong>
              <span>{formatBooleanSummary(styleMemorySummary.preferFullWidth)}</span>
            </div>
            <div>
              <strong>Character voices</strong>
              <span>{String(styleMemorySummary.characterSpeechCount ?? 0)}</span>
            </div>
            <div>
              <strong>Story anchors</strong>
              <span>{String(styleMemorySummary.storyAnchorCount ?? 0)}</span>
            </div>
            <div>
              <strong>Dialogue examples</strong>
              <span>{String(styleMemorySummary.dialogueExamples ?? 0)}</span>
            </div>
            <div>
              <strong>Narration examples</strong>
              <span>{String(styleMemorySummary.narrationExamples ?? 0)}</span>
            </div>
            <div>
              <strong>Reference kind</strong>
              <span>{String(styleMemorySummary.referenceKind ?? "n/a")}</span>
            </div>
            <div>
              <strong>Target style allowed</strong>
              <span>{formatBooleanSummary(styleMemorySummary.targetStyleAllowed)}</span>
            </div>
            <div>
              <strong>Style chapters</strong>
              <span>{String(coverage?.chapterCount ?? 0)}</span>
            </div>
            <div>
              <strong>Reference sets</strong>
              <span>{String(coverage?.referenceSetCount ?? 0)}</span>
            </div>
          </div>
          {activeLayers.length > 0 ? (
            <div className="compact-list">
              <strong>Active style layers</strong>
              <ul className="plain-list">
                {activeLayers.map((layer, index) => (
                  <li key={index}>{String(layer)}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
      {failedChecks.length > 0 ? (
        <div className="compact-list">
          <strong>Failed checks</strong>
          <ul className="plain-list">
            {failedChecks.slice(0, 5).map((check, index) => (
              <li key={index}>{String(check)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {passedChecks.length > 0 ? (
        <div className="compact-list">
          <strong>Passed checks</strong>
          <ul className="plain-list">
            {passedChecks.slice(0, 5).map((check, index) => (
              <li key={index}>{String(check)}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function ManifestSummaryCard({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") {
    return null;
  }

  const manifest = data as Record<string, unknown>;
  const accepted = Array.isArray(manifest.accepted) ? manifest.accepted : [];
  const rejected = Array.isArray(manifest.rejected) ? manifest.rejected : [];
  const inputs = Array.isArray(manifest.inputs) ? manifest.inputs : [];

  return (
    <>
      <div className="summary-grid compact-grid">
        <div>
          <strong>Stage</strong>
          <span>{String(manifest.stage ?? "n/a")}</span>
        </div>
        <div>
          <strong>Task type</strong>
          <span>{String(manifest.taskType ?? "n/a")}</span>
        </div>
        <div>
          <strong>Accepted</strong>
          <span>{String(accepted.length)}</span>
        </div>
        <div>
          <strong>Rejected</strong>
          <span>{String(rejected.length)}</span>
        </div>
        {inputs.length > 0 ? (
          <div>
            <strong>Inputs</strong>
            <span>{String(inputs.length)}</span>
          </div>
        ) : null}
      </div>
      {accepted.length > 0 ? (
        <div className="compact-list">
          <strong>Accepted outputs</strong>
          <ul className="plain-list">
            {accepted.slice(0, 5).map((entry, index) => {
              const item = entry as Record<string, unknown>;
              return <li key={index}>{String(item.file ?? item.path ?? "output")}</li>;
            })}
          </ul>
        </div>
      ) : null}
      {rejected.length > 0 ? (
        <div className="compact-list">
          <strong>Rejected outputs</strong>
          <ul className="plain-list">
            {rejected.slice(0, 5).map((entry, index) => {
              const item = entry as Record<string, unknown>;
              return (
                <li key={index}>
                  {String(item.file ?? "output")} - {String(item.reason ?? "Rejected")}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function GlossarySummaryCard({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = data as Record<string, unknown>;
  const terms = Array.isArray(record.terms) ? record.terms : [];
  const locked = terms.filter(
    (entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).locked === true
  );

  return (
    <>
      <div className="summary-grid compact-grid">
        <div>
          <strong>Total terms</strong>
          <span>{String(terms.length)}</span>
        </div>
        <div>
          <strong>Locked terms</strong>
          <span>{String(locked.length)}</span>
        </div>
      </div>
      {terms.length > 0 ? (
        <div className="compact-list">
          <strong>Top terms</strong>
          <ul className="plain-list">
            {terms.slice(0, 5).map((entry, index) => {
              const item = entry as Record<string, unknown>;
              return (
                <li key={index}>
                  {String(item.source_term ?? item.term ?? "term")} {"->"}{" "}
                  {String(item.canonical_translation ?? item.translation ?? "n/a")}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function StoryContextSummaryCard({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = data as Record<string, unknown>;
  const chapters = Array.isArray(record.chapters) ? record.chapters : [];
  const relationships = Array.isArray(record.relationships) ? record.relationships : [];
  const events = Array.isArray(record.events) ? record.events : [];

  return (
    <>
      <div className="summary-grid compact-grid">
        <div>
          <strong>Chapters</strong>
          <span>{String(chapters.length)}</span>
        </div>
        <div>
          <strong>Relationships</strong>
          <span>{String(relationships.length)}</span>
        </div>
        <div>
          <strong>Events</strong>
          <span>{String(events.length)}</span>
        </div>
      </div>
      {chapters.length > 0 ? (
        <div className="compact-list">
          <strong>Latest chapter notes</strong>
          <ul className="plain-list">
            {chapters.slice(-3).reverse().map((entry, index) => {
              const item = entry as Record<string, unknown>;
              return (
                <li key={index}>
                  {String(item.chapterId ?? item.id ?? "chapter")} - {String(item.summary ?? "No summary")}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function StyleProfileSummaryCard({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = data as Record<string, unknown>;
  const notes = Array.isArray(record.notes) ? record.notes : [];
  const honorificPolicy = Array.isArray(record.honorific_policy) ? record.honorific_policy : [];
  const punctuationPolicy = Array.isArray(record.punctuation_policy) ? record.punctuation_policy : [];

  return (
    <>
      <div className="summary-grid compact-grid">
        <div>
          <strong>Tone</strong>
          <span>{String(record.tone ?? "n/a")}</span>
        </div>
        <div>
          <strong>Register</strong>
          <span>{String(record.register ?? "n/a")}</span>
        </div>
        <div>
          <strong>Honorific rules</strong>
          <span>{String(honorificPolicy.length)}</span>
        </div>
        <div>
          <strong>Punctuation rules</strong>
          <span>{String(punctuationPolicy.length)}</span>
        </div>
      </div>
      {notes.length > 0 ? (
        <div className="compact-list">
          <strong>Notes</strong>
          <ul className="plain-list">
            {notes.slice(0, 5).map((note, index) => (
              <li key={index}>{String(note)}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

export function ArtifactsContent({ embedded = false }: { embedded?: boolean }) {
  const selectedJobId = useUiStore((state) => state.selectedJobId);
  const selectedMangaId = useUiStore((state) => state.selectedMangaId);
  const selectedTranslatorId = useUiStore((state) => state.selectedTranslatorId);
  const setSelectedMangaId = useUiStore((state) => state.setSelectedMangaId);
  const setSelectedTranslatorId = useUiStore((state) => state.setSelectedTranslatorId);
  const [mangaIdInput, setMangaIdInput] = useState("");
  const [translatorIdInput, setTranslatorIdInput] = useState("");
  const [previewArtifact, setPreviewArtifact] = useState<GuiArtifact | null>(null);
  const [previewData, setPreviewData] = useState<unknown>(null);
  const [previewStatus, setPreviewStatus] = useState("");

  const jobQuery = useQuery({
    queryKey: ["artifacts-job", selectedJobId],
    queryFn: () => getJob(selectedJobId as string),
    enabled: Boolean(selectedJobId),
  });

  const artifactsQuery = useQuery({
    queryKey: ["artifacts-list", selectedJobId],
    queryFn: () => getJobArtifacts(selectedJobId as string),
    enabled: Boolean(selectedJobId),
  });

  useEffect(() => {
    const payloadMangaId = jobQuery.data?.payload?.mangaId;
    if (!mangaIdInput.trim() && typeof payloadMangaId === "string" && payloadMangaId.trim()) {
      setSelectedMangaId(payloadMangaId);
    }
  }, [jobQuery.data?.payload, mangaIdInput, setSelectedMangaId]);

  useEffect(() => {
    const payloadTranslatorId = jobQuery.data?.payload?.translatorId;
    if (
      !translatorIdInput.trim() &&
      typeof payloadTranslatorId === "string" &&
      payloadTranslatorId.trim()
    ) {
      setSelectedTranslatorId(payloadTranslatorId);
    }
  }, [jobQuery.data?.payload, setSelectedTranslatorId, translatorIdInput]);

  const effectiveMangaId = useMemo(() => {
    const explicit = mangaIdInput.trim();
    if (explicit) {
      return explicit;
    }
    if (selectedMangaId?.trim()) {
      return selectedMangaId.trim();
    }
    const payloadMangaId = jobQuery.data?.payload?.mangaId;
    return typeof payloadMangaId === "string" ? payloadMangaId : "";
  }, [jobQuery.data?.payload, mangaIdInput, selectedMangaId]);

  const effectiveTranslatorId = useMemo(() => {
    const explicit = translatorIdInput.trim();
    if (explicit) {
      return explicit;
    }
    if (selectedTranslatorId?.trim()) {
      return selectedTranslatorId.trim();
    }
    const payloadTranslatorId = jobQuery.data?.payload?.translatorId;
    return typeof payloadTranslatorId === "string" ? payloadTranslatorId : "";
  }, [jobQuery.data?.payload, selectedTranslatorId, translatorIdInput]);

  const glossaryQuery = useQuery({
    queryKey: ["glossary", effectiveMangaId, effectiveTranslatorId],
    queryFn: () => getGlossary(effectiveMangaId, effectiveTranslatorId || null),
    enabled: Boolean(effectiveMangaId),
  });

  const storyContextQuery = useQuery({
    queryKey: ["story-context", effectiveMangaId, effectiveTranslatorId],
    queryFn: () => getStoryContext(effectiveMangaId, effectiveTranslatorId || null),
    enabled: Boolean(effectiveMangaId),
  });

  const styleProfileQuery = useQuery({
    queryKey: ["style-profile", effectiveMangaId, effectiveTranslatorId],
    queryFn: () => getStyleProfile(effectiveMangaId, effectiveTranslatorId || null),
    enabled: Boolean(effectiveMangaId),
  });

  const partitionedArtifacts = useMemo(
    () => partitionArtifacts(artifactsQuery.data?.artifacts || []),
    [artifactsQuery.data?.artifacts]
  );

  const handlePreview = async (artifact: GuiArtifact) => {
    try {
      setPreviewArtifact(artifact);
      setPreviewStatus("Loading preview...");
      const preview = await readJsonFile(artifact.path);
      setPreviewData(preview.data);
      setPreviewStatus("Preview loaded.");
    } catch (error) {
      setPreviewData(null);
      setPreviewStatus(
        error instanceof Error ? `Failed to load preview: ${error.message}` : "Failed to load preview."
      );
    }
  };

  const previewSummary = useMemo(() => {
    if (!previewArtifact || !previewData) {
      return null;
    }

    if (previewArtifact.kind === "comparison_self_vs_other") {
      return <ComparisonSummaryCard data={previewData} />;
    }
    if (previewArtifact.kind === "quality_validation_report") {
      return <QualityValidationSummaryCard data={previewData} />;
    }
    if (previewArtifact.kind === "comparison_review_report") {
      return <ReviewReportSummaryCard data={previewData} />;
    }
    if (
      previewArtifact.kind === "workspace_import_manifest" ||
      previewArtifact.kind === "workspace_export_manifest"
    ) {
      return <ManifestSummaryCard data={previewData} />;
    }
    return null;
  }, [previewArtifact, previewData]);

  return (
    <section className="page">
      {!embedded ? <h1>Artifacts</h1> : null}
      <div className="card-stack">
        <article className="card">
          <h2>{embedded ? "Artifact context" : "Current context"}</h2>
          <div className="summary-grid">
            <div>
              <strong>Selected job</strong>
              <span>{selectedJobId ?? "Not selected"}</span>
            </div>
            <div>
              <strong>Resolved mangaId</strong>
              <span>{effectiveMangaId || "Not set"}</span>
            </div>
            <div>
              <strong>Resolved translatorId</strong>
              <span>{effectiveTranslatorId || "Not set"}</span>
            </div>
          </div>
          <div className="form-grid">
            <label className="standalone-field">
              <span>Override mangaId</span>
              <input
                value={mangaIdInput}
                onChange={(event) => {
                  const nextValue = event.currentTarget.value;
                  setMangaIdInput(nextValue);
                  setSelectedMangaId(nextValue.trim() || null);
                }}
              />
            </label>
            <label className="standalone-field">
              <span>Override translatorId</span>
              <input
                value={translatorIdInput}
                onChange={(event) => {
                  const nextValue = event.currentTarget.value;
                  setTranslatorIdInput(nextValue);
                  setSelectedTranslatorId(nextValue.trim() || null);
                }}
              />
            </label>
          </div>
        </article>

        {selectedJobId && artifactsQuery.isLoading ? (
          <article className="card">
            <h2>Selected job artifacts</h2>
            <p>Loading artifacts...</p>
          </article>
        ) : null}

        {selectedJobId && artifactsQuery.isError ? (
          <article className="card">
            <h2>Selected job artifacts</h2>
            <p className="error-text">Failed to load artifacts.</p>
          </article>
        ) : null}

        {selectedJobId && artifactsQuery.data ? (
          <>
            <ArtifactList
              artifacts={partitionedArtifacts.comparison}
              title="Quality and comparison reports"
              onPreview={handlePreview}
            />
            <ArtifactList
              artifacts={partitionedArtifacts.workspaceManifests}
              title="Workspace manifests"
              onPreview={handlePreview}
            />
            <ArtifactList
              artifacts={partitionedArtifacts.general}
              title="Other job artifacts"
              onPreview={handlePreview}
            />
          </>
        ) : null}

        <article className="card">
          <h2>Artifact preview</h2>
          {previewArtifact ? (
            <>
              <div className="summary-grid">
                <div>
                  <strong>Artifact</strong>
                  <span>{prettyArtifactKind(previewArtifact.kind)}</span>
                </div>
                <div>
                  <strong>Path</strong>
                  <span>{previewArtifact.path}</span>
                </div>
              </div>
              <p className="muted-text">{previewStatus || "Select an artifact and press Preview."}</p>
              {previewSummary}
              {previewData ? <pre>{formatJson(previewData)}</pre> : null}
            </>
          ) : (
            <p>Select an artifact to preview.</p>
          )}
        </article>

        <article className="card">
          <h2>Local glossary</h2>
          {!effectiveMangaId ? <p>Enter a mangaId, or select a job that already includes one.</p> : null}
          {effectiveMangaId && glossaryQuery.isLoading ? <p>Loading local glossary...</p> : null}
          {effectiveMangaId && glossaryQuery.isError ? <p className="error-text">Failed to load local glossary.</p> : null}
          {effectiveMangaId && glossaryQuery.data ? (
            <>
              <GlossarySummaryCard data={glossaryQuery.data} />
              <pre>{formatJson(glossaryQuery.data)}</pre>
            </>
          ) : null}
        </article>

        <article className="card">
          <h2>Story context</h2>
          {!effectiveMangaId ? <p>Enter a mangaId, or select a job that already includes one.</p> : null}
          {effectiveMangaId && storyContextQuery.isLoading ? <p>Loading story context...</p> : null}
          {effectiveMangaId && storyContextQuery.isError ? <p className="error-text">Failed to load story context.</p> : null}
          {effectiveMangaId && storyContextQuery.data ? (
            <>
              <StoryContextSummaryCard data={storyContextQuery.data} />
              <pre>{formatJson(storyContextQuery.data)}</pre>
            </>
          ) : null}
        </article>

        <article className="card">
          <h2>Style profile</h2>
          {!effectiveMangaId ? <p>Enter a mangaId, or select a job that already includes one.</p> : null}
          {effectiveMangaId && styleProfileQuery.isLoading ? <p>Loading style profile...</p> : null}
          {effectiveMangaId && styleProfileQuery.isError ? <p className="error-text">Failed to load style profile.</p> : null}
          {effectiveMangaId && styleProfileQuery.data ? (
            <>
              <StyleProfileSummaryCard data={styleProfileQuery.data} />
              <pre>{formatJson(styleProfileQuery.data)}</pre>
            </>
          ) : null}
        </article>
      </div>
    </section>
  );
}

export function ArtifactsPage() {
  return <ArtifactsContent embedded={false} />;
}
