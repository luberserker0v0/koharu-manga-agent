import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  confirmQualityReview,
  getQualityReview,
  type GuiJob,
  type QualityReviewDecision,
} from "../../../api/jobs";
import { useLanguageStore } from "../../../stores/language_store";

type Props = {
  job: GuiJob;
  onFinalizeCreated: (job: GuiJob) => void;
};

export function QualityReviewPane({ job, onFinalizeCreated }: Props) {
  const { t } = useLanguageStore();
  const [decisions, setDecisions] = useState<Record<string, QualityReviewDecision>>({});
  const isReviewable = job.status === "waiting_user_review" ||
    (job.type === "translation_deep_audit" && job.status === "succeeded");
  const reviewQuery = useQuery({
    queryKey: ["quality-review", job.id],
    queryFn: () => getQualityReview(job.id),
    enabled: isReviewable,
  });
  const finalizeMutation = useMutation({
    mutationFn: () => confirmQualityReview(job.id, Object.values(decisions)),
    onSuccess: onFinalizeCreated,
  });
  if (!isReviewable) return null;
  if (reviewQuery.isLoading) return <article className="card"><p>{t("jobDetail.qualityReview.loading")}</p></article>;
  if (reviewQuery.isError || !reviewQuery.data) return <article className="card"><p>{t("jobDetail.qualityReview.loadFailed")}</p></article>;
  const review = reviewQuery.data;
  const requiredIds = review.pages.flatMap((page) => page.items.filter((item) => item.blocking).map((item) => item.nodeId));
  const isDeepAudit = job.type === "translation_deep_audit";
  const hasDecision = Object.keys(decisions).length > 0;
  const complete = requiredIds.every((nodeId) => Boolean(decisions[nodeId])) && (!isDeepAudit || hasDecision);

  return (
    <article className="card">
      <h2>{t("jobDetail.qualityReview.title")}</h2>
      <p>{t("jobDetail.qualityReview.summary", review.summary)}</p>
      {review.pages.map((page) => (
        <section key={page.pageName} className="reference-report-section">
          <h3>{t("jobDetail.qualityReview.page", { page: page.pageName })}</h3>
          {page.sequenceRisks.map((risk) => (
            <p className="status-banner status-banner-warning" key={`${risk.startNodeId}-${risk.endNodeId}`}>
              {t("jobDetail.qualityReview.sequenceRisk", { start: risk.startNodeId, end: risk.endNodeId })}: {risk.reason}
            </p>
          ))}
          {page.items.map((item) => {
            const decision = decisions[item.nodeId];
            return (
              <div className="event-row" key={item.nodeId}>
                <div className="summary-grid">
                  <div><strong>{t("jobDetail.qualityReview.source")}</strong><span>{item.original}</span></div>
                  <div><strong>{t("jobDetail.qualityReview.current")}</strong><span>{item.currentTranslation}</span></div>
                  <div><strong>{t("jobDetail.qualityReview.proposal")}</strong><span>{item.proposedTranslation || t("shared.value.none")}</span></div>
                  <div><strong>{t("jobDetail.qualityReview.reason")}</strong><span>{item.reason || t("shared.value.none")}</span></div>
                  <div><strong>{t("jobDetail.qualityReview.confidence")}</strong><span>{item.confidence == null ? t("shared.value.none") : `${Math.round(item.confidence * 100)}%`}</span></div>
                  <div><strong>{t("jobDetail.qualityReview.bbox")}</strong><span>{item.bbox ? `${item.bbox.x}, ${item.bbox.y}, ${item.bbox.width} x ${item.bbox.height}` : t("shared.value.none")}</span></div>
                </div>
                <select
                  value={decision?.action || ""}
                  onChange={(event) => setDecisions((current) => ({
                    ...current,
                    [item.nodeId]: { nodeId: item.nodeId, action: event.target.value as QualityReviewDecision["action"] },
                  }))}
                >
                  <option value="">{t("jobDetail.qualityReview.chooseDecision")}</option>
                  {item.proposedTranslation && item.allowedDecisions.includes("accept_proposal") ? (
                    <option value="accept_proposal">{t("jobDetail.qualityReview.acceptProposal")}</option>
                  ) : null}
                  {item.allowedDecisions.includes("manual_edit") ? (
                    <option value="manual_edit">{t("jobDetail.qualityReview.manualEdit")}</option>
                  ) : null}
                  {item.allowedDecisions.includes("confirm_current") ? (
                    <option value="confirm_current">{t("jobDetail.qualityReview.confirmCurrent")}</option>
                  ) : null}
                  {item.allowedDecisions.includes("ignore_and_publish") ? (
                    <option value="ignore_and_publish">{t("jobDetail.qualityReview.ignoreAndPublish")}</option>
                  ) : null}
                </select>
                {decision?.action === "manual_edit" ? (
                  <textarea
                    value={decision.translation || ""}
                    onChange={(event) => setDecisions((current) => ({
                      ...current,
                      [item.nodeId]: { ...current[item.nodeId], translation: event.target.value },
                    }))}
                  />
                ) : null}
              </div>
            );
          })}
        </section>
      ))}
      <div className="button-row">
        <button className="primary-button" type="button" disabled={!complete || finalizeMutation.isPending} onClick={() => finalizeMutation.mutate()}>
          {finalizeMutation.isPending ? t("jobDetail.qualityReview.finalizing") : t("jobDetail.qualityReview.finalize")}
        </button>
      </div>
    </article>
  );
}
