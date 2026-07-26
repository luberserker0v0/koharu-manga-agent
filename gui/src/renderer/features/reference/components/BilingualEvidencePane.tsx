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

export function BilingualEvidencePane({
  visible,
  document,
  loading,
  running,
  updating,
  onRun,
  onUpdate,
}: Props) {
  const t = useLanguageStore((state) => state.t);
  const [expanded, setExpanded] = useState(false);
  if (!visible) return null;

  const termLinks = document?.termLinks || [];
  const stylePairs = document?.stylePairs || [];
  const reviewLinks = termLinks.filter((link) => link.status !== "accepted");
  const activeRun = document?.activeRun;
  return (
    <SectionCard
      title={t("reference.bilingualEvidence.title")}
      description={t("reference.bilingualEvidence.description")}
    >
      <div className="reference-alignment-step-row">
        <span className="pill pill-neutral">{t("reference.bilingualEvidence.optional")}</span>
        <span className="pill pill-success">
          {t("reference.bilingualEvidence.accepted")} {document?.summary?.accepted || 0}
        </span>
        <span className="pill pill-warn">
          {t("reference.bilingualEvidence.needsReview")} {reviewLinks.length}
        </span>
        <span className="pill pill-neutral">
          {t("reference.bilingualEvidence.stylePairs")} {stylePairs.length}
        </span>
        <span className="pill pill-success">
          {t("reference.bilingualEvidence.promoted")} {document?.promotedTerminology || 0}
        </span>
        <span className="pill pill-warn">
          {t("reference.bilingualEvidence.unmatched")} {document?.unmatchedAnchors?.length || 0}
        </span>
        <span className="pill pill-warn">
          {t("reference.bilingualEvidence.conflicts")} {document?.conflicts?.length || 0}
        </span>
        <span className="pill pill-neutral">
          {t("reference.bilingualEvidence.revision", { value: document?.ledgerRevision || 0 })}
        </span>
      </div>
      {activeRun ? (
        <div className="reference-alignment-step-row">
          <span>
            {t("reference.bilingualEvidence.progress", {
              completed: activeRun.completedWindows,
              total: activeRun.totalWindows,
            })}
          </span>
          <span>{t("reference.bilingualEvidence.reused", { count: activeRun.reusedWindows })}</span>
          {activeRun.failedWindowId ? (
            <span className="job-error">
              {t("reference.bilingualEvidence.failedWindow", { value: activeRun.failedWindowId })}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="button-row">
        <button className="secondary-button" type="button" disabled={running} onClick={onRun}>
          {running
            ? t("reference.bilingualEvidence.running")
            : activeRun?.resumeAvailable
              ? t("reference.bilingualEvidence.resume")
              : t("reference.bilingualEvidence.run")}
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={loading || termLinks.length + stylePairs.length === 0}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? t("reference.bilingualEvidence.collapse")
            : t("reference.bilingualEvidence.expand")}
        </button>
      </div>
      {expanded ? (
        <div className="reference-bilingual-link-list">
          {(document?.chapterGroups || []).map((group) => {
            const chapterTermLinks = group.termLinkIds
              .map((id) => termLinks.find((link) => link.termLinkId === id))
              .filter((link): link is NonNullable<typeof link> => Boolean(link));
            const chapterStylePairs = group.stylePairIds
              .map((id) => stylePairs.find((pair) => pair.stylePairId === id))
              .filter((pair): pair is NonNullable<typeof pair> => Boolean(pair));
            return (
              <details key={group.chapterId}>
                <summary>{t("reference.bilingualEvidence.chapter", { value: group.chapterTitle })}</summary>
                {chapterTermLinks.map((link) => (
                  <article className="reference-workspace-entry" key={link.termLinkId}>
                    <div>
                      <strong>{link.sourceSurface || link.sourceTexts.join(" / ") || t("reference.common.none")}</strong>
                      <span> → </span>
                      <strong>{link.targetSurface || link.targetTexts.join(" / ") || t("reference.common.none")}</strong>
                    </div>
                    <p className="muted-text">
                      {link.category} · {Math.round(link.confidence * 100)}% · {t("reference.bilingualEvidence.observations", { count: link.observationCount || 1 })} · {link.reason}
                    </p>
                    <div className="button-row">
                      {link.status !== "accepted" ? (
                        <button className="secondary-button" type="button" disabled={updating} onClick={() => onUpdate(link.termLinkId, "accept")}>
                          {t("reference.bilingualEvidence.accept")}
                        </button>
                      ) : null}
                      {link.status !== "rejected" ? (
                        <button className="secondary-button" type="button" disabled={updating} onClick={() => onUpdate(link.termLinkId, "unbind")}>
                          {t("reference.bilingualEvidence.unbind")}
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))}
                {chapterStylePairs.map((pair) => (
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
                ))}
              </details>
            );
          })}
          {(document?.confidenceChanges?.length || 0) > 0 ? (
            <details>
              <summary>{t("reference.bilingualEvidence.confidenceChanges")}</summary>
              {document?.confidenceChanges?.map((change) => (
                <p className="muted-text" key={change.evidenceId}>
                  {change.sourceSurface} → {change.targetSurface} · {Math.round(change.previousConfidence * 100)}% → {Math.round(change.currentConfidence * 100)}%
                </p>
              ))}
            </details>
          ) : null}
          {(document?.conflicts?.length || 0) > 0 ? (
            <details>
              <summary>{t("reference.bilingualEvidence.conflicts")}</summary>
              {document?.conflicts?.map((conflict) => (
                <p className="job-error" key={conflict.conflictId}>
                  {conflict.sourceSurface} → {conflict.targetSurfaces.join(" / ")}
                </p>
              ))}
            </details>
          ) : null}
          {(document?.unmatchedAnchors?.length || 0) > 0 ? (
            <details>
              <summary>{t("reference.bilingualEvidence.unmatchedDetails")}</summary>
              {document?.unmatchedAnchors?.map((entry) => (
                <p className="muted-text" key={`${entry.windowId}:${entry.anchorType}:${entry.anchorId}`}>
                  {entry.anchorId} · {entry.reason}
                </p>
              ))}
            </details>
          ) : null}
          {(document?.history?.length || 0) > 0 ? (
            <details>
              <summary>{t("reference.bilingualEvidence.history")}</summary>
              {document?.history?.map((entry) => (
                <p className="muted-text" key={entry.planHash}>
                  {new Date(entry.committedAt).toLocaleString()} · {entry.termEvidenceCount} / {entry.styleEvidenceCount}
                </p>
              ))}
            </details>
          ) : null}
        </div>
      ) : null}
    </SectionCard>
  );
}
