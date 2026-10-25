import { useState } from "react";
import type { BilingualEvidenceDocument } from "../../../api/jobs";
import { useLanguageStore } from "../../../stores/language_store";
import { SectionCard } from "../../shared/components/SectionCard";

type Props = {
  visible: boolean;
  document: BilingualEvidenceDocument | null;
  loading: boolean;
  running: boolean;
  updating: boolean;
  onRun: () => void;
  onUpdate: (linkId: string, action: "accept" | "unbind") => void;
};

type TermLink = NonNullable<BilingualEvidenceDocument["termLinks"]>[number];
type StylePair = NonNullable<BilingualEvidenceDocument["stylePairs"]>[number];
type ChapterGroup = NonNullable<BilingualEvidenceDocument["chapterGroups"]>[number];
type Translate = ReturnType<typeof useLanguageStore.getState>["t"];

function bilingualSummaryItems(
  document: BilingualEvidenceDocument | null,
  reviewLinks: TermLink[],
  stylePairs: StylePair[],
  t: Translate,
) {
  return [
    ["pill-neutral", t("reference.bilingualEvidence.optional")],
    ["pill-success", `${t("reference.bilingualEvidence.accepted")} ${document?.summary?.accepted || 0}`],
    ["pill-warn", `${t("reference.bilingualEvidence.needsReview")} ${reviewLinks.length}`],
    ["pill-neutral", `${t("reference.bilingualEvidence.stylePairs")} ${stylePairs.length}`],
    ["pill-success", `${t("reference.bilingualEvidence.promoted")} ${document?.promotedTerminology || 0}`],
    ["pill-warn", `${t("reference.bilingualEvidence.unmatched")} ${document?.unmatchedAnchors?.length || 0}`],
    ["pill-warn", `${t("reference.bilingualEvidence.conflicts")} ${document?.conflicts?.length || 0}`],
    ["pill-neutral", t("reference.bilingualEvidence.revision", { value: document?.ledgerRevision || 0 })],
  ];
}

function BilingualEvidenceSummary({
  document,
  reviewLinks,
  stylePairs,
}: {
  document: BilingualEvidenceDocument | null;
  reviewLinks: TermLink[];
  stylePairs: StylePair[];
}) {
  const t = useLanguageStore((state) => state.t);
  return (
    <div className="reference-alignment-step-row">
      {bilingualSummaryItems(document, reviewLinks, stylePairs, t).map(([tone, label]) => (
        <span className={`pill ${tone}`} key={label}>{label}</span>
      ))}
    </div>
  );
}

function BilingualEvidenceActiveRun({ activeRun }: { activeRun: NonNullable<BilingualEvidenceDocument["activeRun"]> }) {
  const t = useLanguageStore((state) => state.t);
  return (
    <div className="reference-alignment-step-row">
      <span>
        {t("reference.bilingualEvidence.progress", {
          completed: activeRun.completedWindows,
          total: activeRun.totalWindows,
        })}
      </span>
      <span>
        {t("reference.bilingualEvidence.reused", {
          count: activeRun.reusedWindows,
        })}
      </span>
      {activeRun.failedWindowId ? (
        <span className="job-error">
          {t("reference.bilingualEvidence.failedWindow", {
            value: activeRun.failedWindowId,
          })}
        </span>
      ) : null}
    </div>
  );
}

type EvidenceActionsProps = {
  running: boolean;
  expanded: boolean;
  activeRun: BilingualEvidenceDocument["activeRun"];
  termLinks: TermLink[];
  stylePairs: StylePair[];
  onRun: () => void;
  onToggle: () => void;
};

function runButtonLabel(props: EvidenceActionsProps, t: Translate) {
  if (props.running) return t("reference.bilingualEvidence.running");
  return props.activeRun?.resumeAvailable
    ? t("reference.bilingualEvidence.resume")
    : t("reference.bilingualEvidence.run");
}

function BilingualEvidenceActions(props: EvidenceActionsProps) {
  const t = useLanguageStore((state) => state.t);
  return (
    <div className="button-row">
      <button className="secondary-button" type="button" disabled={props.running} onClick={props.onRun}>
        {runButtonLabel(props, t)}
      </button>
      <button className="secondary-button" type="button"
        disabled={props.termLinks.length + props.stylePairs.length === 0} onClick={props.onToggle}>
        {props.expanded ? t("reference.bilingualEvidence.collapse") : t("reference.bilingualEvidence.expand")}
      </button>
    </div>
  );
}

function BilingualTermLinkActions({ link, updating, onUpdate }: {
  link: TermLink; updating: boolean; onUpdate: Props["onUpdate"];
}) {
  const t = useLanguageStore((state) => state.t);
  return (
    <div className="button-row">
      {link.status !== "accepted" ? (
        <button className="secondary-button" type="button" disabled={updating}
          onClick={() => onUpdate(link.termLinkId, "accept")}>
          {t("reference.bilingualEvidence.accept")}
        </button>
      ) : null}
      {link.status !== "rejected" ? (
        <button className="secondary-button" type="button" disabled={updating}
          onClick={() => onUpdate(link.termLinkId, "unbind")}>
          {t("reference.bilingualEvidence.unbind")}
        </button>
      ) : null}
    </div>
  );
}

function BilingualTermLinkCard({
  link,
  updating,
  onUpdate,
}: {
  link: TermLink;
  updating: boolean;
  onUpdate: Props["onUpdate"];
}) {
  const t = useLanguageStore((state) => state.t);
  return (
    <article className="reference-workspace-entry" key={link.termLinkId}>
      <div>
        <strong>{link.sourceSurface || link.sourceTexts.join(" / ") || t("reference.common.none")}</strong>
        <span> → </span>
        <strong>{link.targetSurface || link.targetTexts.join(" / ") || t("reference.common.none")}</strong>
      </div>
      <p className="muted-text">
        {link.category} · {Math.round(link.confidence * 100)}% ·{" "}
        {t("reference.bilingualEvidence.observations", {
          count: link.observationCount || 1,
        })}{" "}
        · {link.reason}
      </p>
      <BilingualTermLinkActions link={link} updating={updating} onUpdate={onUpdate} />
    </article>
  );
}

function BilingualStylePairCard({ pair }: { pair: StylePair }) {
  const t = useLanguageStore((state) => state.t);
  return (
    <article className="reference-workspace-entry" key={pair.stylePairId}>
      <div>
        <strong>{pair.sourceTexts.join(" / ") || t("reference.common.none")}</strong>
        <span> → </span>
        <strong>{pair.targetTexts.join(" / ") || t("reference.common.none")}</strong>
      </div>
      <p className="muted-text">
        {pair.textRole} · {pair.styleChannel} · {Math.round(pair.confidence * 100)}% · {pair.reason}
      </p>
    </article>
  );
}

type ChapterDetailsProps = {
  group: ChapterGroup;
  termLinks: TermLink[];
  stylePairs: StylePair[];
  updating: boolean;
  onUpdate: Props["onUpdate"];
};

function chapterEvidence(group: ChapterGroup, termLinks: TermLink[], stylePairs: StylePair[]) {
  const chapterTermLinks = group.termLinkIds
    .map((id) => termLinks.find((link) => link.termLinkId === id))
    .filter((link): link is TermLink => Boolean(link));
  const chapterStylePairs = group.stylePairIds
    .map((id) => stylePairs.find((pair) => pair.stylePairId === id))
    .filter((pair): pair is StylePair => Boolean(pair));
  return { chapterTermLinks, chapterStylePairs };
}

function BilingualChapterDetails({ group, termLinks, stylePairs, updating, onUpdate }: ChapterDetailsProps) {
  const t = useLanguageStore((state) => state.t);
  const evidence = chapterEvidence(group, termLinks, stylePairs);
  return (
    <details key={group.chapterId}>
      <summary>
        {t("reference.bilingualEvidence.chapter", {
          value: group.chapterTitle,
        })}
      </summary>
      {evidence.chapterTermLinks.map((link) => (
        <BilingualTermLinkCard key={link.termLinkId} link={link} updating={updating} onUpdate={onUpdate} />
      ))}
      {evidence.chapterStylePairs.map((pair) => (
        <BilingualStylePairCard key={pair.stylePairId} pair={pair} />
      ))}
    </details>
  );
}

function BilingualConfidenceChanges({ document }: { document: BilingualEvidenceDocument | null }) {
  const t = useLanguageStore((state) => state.t);
  if (!document?.confidenceChanges?.length) return null;
  return (
    <details>
      <summary>{t("reference.bilingualEvidence.confidenceChanges")}</summary>
      {document.confidenceChanges.map((change) => (
        <p className="muted-text" key={change.evidenceId}>
          {change.sourceSurface} → {change.targetSurface} · {Math.round(change.previousConfidence * 100)}% →{" "}
          {Math.round(change.currentConfidence * 100)}%
        </p>
      ))}
    </details>
  );
}

function BilingualConflicts({ document }: { document: BilingualEvidenceDocument | null }) {
  const t = useLanguageStore((state) => state.t);
  if (!document?.conflicts?.length) return null;
  return (
    <details>
      <summary>{t("reference.bilingualEvidence.conflicts")}</summary>
      {document.conflicts.map((conflict) => (
        <p className="job-error" key={conflict.conflictId}>
          {conflict.sourceSurface} → {conflict.targetSurfaces.join(" / ")}
        </p>
      ))}
    </details>
  );
}

function BilingualUnmatched({ document }: { document: BilingualEvidenceDocument | null }) {
  const t = useLanguageStore((state) => state.t);
  if (!document?.unmatchedAnchors?.length) return null;
  return (
    <details>
      <summary>{t("reference.bilingualEvidence.unmatchedDetails")}</summary>
      {document.unmatchedAnchors.map((entry) => (
        <p className="muted-text" key={`${entry.windowId}:${entry.anchorType}:${entry.anchorId}`}>
          {entry.anchorId} · {entry.reason}
        </p>
      ))}
    </details>
  );
}

function BilingualHistory({ document }: { document: BilingualEvidenceDocument | null }) {
  const t = useLanguageStore((state) => state.t);
  if (!document?.history?.length) return null;
  return (
    <details>
      <summary>{t("reference.bilingualEvidence.history")}</summary>
      {document.history.map((entry) => (
        <p className="muted-text" key={entry.planHash}>
          {new Date(entry.committedAt).toLocaleString()} · {entry.termEvidenceCount} / {entry.styleEvidenceCount}
        </p>
      ))}
    </details>
  );
}

type EvidenceDetailsProps = {
  document: BilingualEvidenceDocument | null;
  termLinks: TermLink[];
  stylePairs: StylePair[];
  updating: boolean;
  onUpdate: Props["onUpdate"];
};

function BilingualEvidenceDetails({ document, termLinks, stylePairs, updating, onUpdate }: EvidenceDetailsProps) {
  return (
    <div className="reference-bilingual-link-list">
      {(document?.chapterGroups || []).map((group) => (
        <BilingualChapterDetails key={group.chapterId} group={group} termLinks={termLinks}
          stylePairs={stylePairs} updating={updating} onUpdate={onUpdate} />
      ))}
      <BilingualConfidenceChanges document={document} />
      <BilingualConflicts document={document} />
      <BilingualUnmatched document={document} />
      <BilingualHistory document={document} />
    </div>
  );
}

type EvidenceContentProps = Omit<Props, "visible" | "loading"> & {
  expanded: boolean;
  onToggle: () => void;
};

function BilingualEvidenceContent({ document, running, updating, onRun, onUpdate, expanded, onToggle }: EvidenceContentProps) {
  const termLinks = document?.termLinks || [];
  const stylePairs = document?.stylePairs || [];
  const reviewLinks = termLinks.filter((link) => link.status !== "accepted");
  return <>
    <BilingualEvidenceSummary document={document} reviewLinks={reviewLinks} stylePairs={stylePairs} />
    {document?.activeRun ? <BilingualEvidenceActiveRun activeRun={document.activeRun} /> : null}
    <BilingualEvidenceActions running={running} expanded={expanded} activeRun={document?.activeRun}
      termLinks={termLinks} stylePairs={stylePairs} onRun={onRun} onToggle={onToggle} />
    {expanded ? <BilingualEvidenceDetails document={document} termLinks={termLinks}
      stylePairs={stylePairs} updating={updating} onUpdate={onUpdate} /> : null}
  </>;
}

export function BilingualEvidencePane({ visible, document, loading, running, updating, onRun, onUpdate }: Props) {
  const t = useLanguageStore((state) => state.t);
  const [expanded, setExpanded] = useState(false);
  if (!visible) return null;
  return (
    <SectionCard
      title={t("reference.bilingualEvidence.title")}
      description={t("reference.bilingualEvidence.description")}
      defaultOpen
    >
      <BilingualEvidenceContent document={document} running={running} updating={updating} onRun={onRun}
        onUpdate={onUpdate} expanded={expanded} onToggle={() => setExpanded((value) => !value)} />
    </SectionCard>
  );
}
