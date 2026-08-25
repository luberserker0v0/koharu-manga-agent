import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  applyDeepAuditReview,
  getDeepAuditReview,
  type DeepAuditReviewDecision,
  type GuiJob,
} from "../../../api/jobs";
import { useLanguageStore } from "../../../stores/language_store";

type Props = {
  job: GuiJob;
  onApplyCreated: (job: GuiJob) => void;
};

export function DeepAuditReviewPane({ job, onApplyCreated }: Props) {
  const { t } = useLanguageStore();
  const [decisions, setDecisions] = useState<Record<string, DeepAuditReviewDecision>>({});
  const isReviewable = job.type === "translation_deep_audit" && job.status === "succeeded";
  const reviewQuery = useQuery({
    queryKey: ["deep-audit-review", job.id],
    queryFn: () => getDeepAuditReview(job.id),
    enabled: isReviewable,
  });
  const applyMutation = useMutation({
    mutationFn: () => applyDeepAuditReview(job.id, Object.values(decisions)),
    onSuccess: onApplyCreated,
  });
  if (!isReviewable) return null;
  if (reviewQuery.isLoading) return <article className="card"><p>{t("jobDetail.deepAuditReview.loading")}</p></article>;
  if (reviewQuery.isError || !reviewQuery.data) return <article className="card"><p>{t("jobDetail.deepAuditReview.loadFailed")}</p></article>;
  const review = reviewQuery.data;
  const hasDecision = Object.keys(decisions).length > 0;

  return (
    <article className="card">
      <h2>{t("jobDetail.deepAuditReview.title")}</h2>
      <p>{t("jobDetail.deepAuditReview.summary", review.summary)}</p>
      {review.pages.map((page) => (
        <section key={page.pageName} className="reference-report-section">
          <h3>{t("jobDetail.deepAuditReview.page", { page: page.pageName })}</h3>
          {page.sequenceRisks.map((risk) => (
            <p className="status-banner status-banner-warning" key={`${risk.startNodeId}-${risk.endNodeId}`}>
              {t("jobDetail.deepAuditReview.sequenceRisk", { start: risk.startNodeId, end: risk.endNodeId })}: {risk.reason}
            </p>
          ))}
          {page.items.map((item) => {
            const decision = decisions[item.nodeId];
            return (
              <div className="event-row" key={item.nodeId}>
                <div className="summary-grid">
                  <div><strong>{t("jobDetail.deepAuditReview.source")}</strong><span>{item.original}</span></div>
                  <div><strong>{t("jobDetail.deepAuditReview.current")}</strong><span>{item.currentTranslation}</span></div>
                  <div><strong>{t("jobDetail.deepAuditReview.proposal")}</strong><span>{item.proposedTranslation || t("shared.value.none")}</span></div>
                  <div><strong>{t("jobDetail.deepAuditReview.reason")}</strong><span>{item.reason || t("shared.value.none")}</span></div>
                  <div><strong>{t("jobDetail.deepAuditReview.confidence")}</strong><span>{item.confidence == null ? t("shared.value.none") : `${Math.round(item.confidence * 100)}%`}</span></div>
                  <div><strong>{t("jobDetail.deepAuditReview.bbox")}</strong><span>{item.bbox ? `${item.bbox.x}, ${item.bbox.y}, ${item.bbox.width} x ${item.bbox.height}` : t("shared.value.none")}</span></div>
                </div>
                <select
                  value={decision?.action || ""}
                  onChange={(event) => setDecisions((current) => ({
                    ...current,
                    [item.nodeId]: { nodeId: item.nodeId, action: event.target.value as DeepAuditReviewDecision["action"] },
                  }))}
                >
                  <option value="">{t("jobDetail.deepAuditReview.chooseDecision")}</option>
                  {item.proposedTranslation && item.allowedDecisions.includes("accept_proposal") ? (
                    <option value="accept_proposal">{t("jobDetail.deepAuditReview.acceptProposal")}</option>
                  ) : null}
                  <option value="manual_edit">{t("jobDetail.deepAuditReview.manualEdit")}</option>
                  <option value="confirm_current">{t("jobDetail.deepAuditReview.confirmCurrent")}</option>
                  <option value="ignore_and_publish">{t("jobDetail.deepAuditReview.ignoreAndPublish")}</option>
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
        <button className="primary-button" type="button" disabled={!hasDecision || applyMutation.isPending} onClick={() => applyMutation.mutate()}>
          {applyMutation.isPending ? t("jobDetail.deepAuditReview.applying") : t("jobDetail.deepAuditReview.apply")}
        </button>
      </div>
    </article>
  );
}
