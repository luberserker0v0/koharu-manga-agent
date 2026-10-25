import { type Dispatch, type SetStateAction, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { applyDeepAuditReview, getDeepAuditReview, type DeepAuditReviewDecision, type GuiJob } from "../../../api/jobs";
import { useLanguageStore } from "../../../stores/language_store";

type Props = {
  job: GuiJob;
  onApplyCreated: (job: GuiJob) => void;
};

type Translate = (key: string, params?: Record<string, string | number>) => string;
type ReviewPage = Awaited<ReturnType<typeof getDeepAuditReview>>["pages"][number];
type ReviewItem = ReviewPage["items"][number];

function SummaryValue({ label, value }: { label: string; value: string }) {
  return <div><strong>{label}</strong><span>{value}</span></div>;
}

function ItemSummary({ item, t }: { item: ReviewItem; t: Translate }) {
  const none = t("shared.value.none");
  const bbox = item.bbox ? `${item.bbox.x}, ${item.bbox.y}, ${item.bbox.width} x ${item.bbox.height}` : none;
  return (
    <div className="summary-grid">
      <SummaryValue label={t("jobDetail.deepAuditReview.source")} value={item.original} />
      <SummaryValue label={t("jobDetail.deepAuditReview.current")} value={item.currentTranslation} />
      <SummaryValue label={t("jobDetail.deepAuditReview.proposal")} value={item.proposedTranslation || none} />
      <SummaryValue label={t("jobDetail.deepAuditReview.reason")} value={item.reason || none} />
      <SummaryValue label={t("jobDetail.deepAuditReview.confidence")}
        value={item.confidence == null ? none : `${Math.round(item.confidence * 100)}%`} />
      <SummaryValue label={t("jobDetail.deepAuditReview.bbox")} value={bbox} />
    </div>
  );
}

function DecisionSelect({
  item,
  decision,
  onChange,
  t,
}: {
  item: ReviewItem;
  decision?: DeepAuditReviewDecision;
  onChange: (action: DeepAuditReviewDecision["action"]) => void;
  t: Translate;
}) {
  return (
    <select
      value={decision?.action || ""}
      onChange={(event) => onChange(event.target.value as DeepAuditReviewDecision["action"])}
    >
      <option value="">{t("jobDetail.deepAuditReview.chooseDecision")}</option>
      {item.proposedTranslation && item.allowedDecisions.includes("accept_proposal") ? (
        <option value="accept_proposal">{t("jobDetail.deepAuditReview.acceptProposal")}</option>
      ) : null}
      <option value="manual_edit">{t("jobDetail.deepAuditReview.manualEdit")}</option>
      <option value="confirm_current">{t("jobDetail.deepAuditReview.confirmCurrent")}</option>
      <option value="ignore_and_publish">{t("jobDetail.deepAuditReview.ignoreAndPublish")}</option>
    </select>
  );
}

function ReviewItemCard({
  item,
  decision,
  onAction,
  onTranslation,
  t,
}: {
  item: ReviewItem;
  decision?: DeepAuditReviewDecision;
  onAction: (nodeId: string, action: DeepAuditReviewDecision["action"]) => void;
  onTranslation: (nodeId: string, value: string) => void;
  t: Translate;
}) {
  return (
    <div className="event-row">
      <ItemSummary item={item} t={t} />
      <DecisionSelect item={item} decision={decision} onChange={(action) => onAction(item.nodeId, action)} t={t} />
      {decision?.action === "manual_edit" ? (
        <textarea
          value={decision.translation || ""}
          onChange={(event) => onTranslation(item.nodeId, event.target.value)}
        />
      ) : null}
    </div>
  );
}

function ReviewPageSection({
  page,
  decisions,
  onAction,
  onTranslation,
  t,
}: {
  page: ReviewPage;
  decisions: Record<string, DeepAuditReviewDecision>;
  onAction: (nodeId: string, action: DeepAuditReviewDecision["action"]) => void;
  onTranslation: (nodeId: string, value: string) => void;
  t: Translate;
}) {
  return (
    <section className="reference-report-section">
      <h3>{t("jobDetail.deepAuditReview.page", { page: page.pageName })}</h3>
      {page.sequenceRisks.map((risk) => (
        <SequenceRisk key={`${risk.startNodeId}-${risk.endNodeId}`} risk={risk} t={t} />
      ))}
      {page.items.map((item) => (
        <ReviewItemCard key={item.nodeId} item={item} decision={decisions[item.nodeId]}
          onAction={onAction} onTranslation={onTranslation} t={t} />
      ))}
    </section>
  );
}

function SequenceRisk({ risk, t }: { risk: ReviewPage["sequenceRisks"][number]; t: Translate }) {
  const label = t("jobDetail.deepAuditReview.sequenceRisk", {
    start: risk.startNodeId,
    end: risk.endNodeId,
  });
  return <p className="status-banner status-banner-warning">{label}: {risk.reason}</p>;
}

function ApplyReviewButton({ decisions, pending, onApply, t }: {
  decisions: Record<string, DeepAuditReviewDecision>; pending: boolean; onApply: () => void; t: Translate;
}) {
  return <div className="button-row"><button className="primary-button" type="button"
    disabled={!Object.keys(decisions).length || pending} onClick={onApply}>
    {pending ? t("jobDetail.deepAuditReview.applying") : t("jobDetail.deepAuditReview.apply")}
  </button></div>;
}

function ReviewContent({
  review,
  decisions,
  pending,
  onAction,
  onTranslation,
  onApply,
  t,
}: {
  review: Awaited<ReturnType<typeof getDeepAuditReview>>;
  decisions: Record<string, DeepAuditReviewDecision>;
  pending: boolean;
  onAction: (nodeId: string, action: DeepAuditReviewDecision["action"]) => void;
  onTranslation: (nodeId: string, value: string) => void;
  onApply: () => void;
  t: Translate;
}) {
  return (
    <article className="card">
      <h2>{t("jobDetail.deepAuditReview.title")}</h2>
      <p>{t("jobDetail.deepAuditReview.summary", review.summary)}</p>
      {review.pages.map((page) => (
        <ReviewPageSection key={page.pageName} page={page} decisions={decisions}
          onAction={onAction} onTranslation={onTranslation} t={t} />
      ))}
      <ApplyReviewButton decisions={decisions} pending={pending} onApply={onApply} t={t} />
    </article>
  );
}

function updateDecisionAction(
  setDecisions: Dispatch<SetStateAction<Record<string, DeepAuditReviewDecision>>>,
  nodeId: string,
  action: DeepAuditReviewDecision["action"],
) {
  setDecisions((current) => ({ ...current, [nodeId]: { nodeId, action } }));
}

function updateDecisionTranslation(
  setDecisions: Dispatch<SetStateAction<Record<string, DeepAuditReviewDecision>>>,
  nodeId: string,
  translation: string,
) {
  setDecisions((current) => ({ ...current, [nodeId]: { ...current[nodeId], translation } }));
}

function useDeepAuditReview(job: GuiJob, onApplyCreated: (job: GuiJob) => void) {
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
  const onAction = (nodeId: string, action: DeepAuditReviewDecision["action"]) =>
    updateDecisionAction(setDecisions, nodeId, action);
  const onTranslation = (nodeId: string, translation: string) =>
    updateDecisionTranslation(setDecisions, nodeId, translation);
  return { decisions, isReviewable, reviewQuery, applyMutation, onAction, onTranslation };
}

function ReviewQueryState({ message }: { message: string }) {
  return <article className="card"><p>{message}</p></article>;
}

export function DeepAuditReviewPane({ job, onApplyCreated }: Props) {
  const { t } = useLanguageStore();
  const state = useDeepAuditReview(job, onApplyCreated);
  if (!state.isReviewable) return null;
  if (state.reviewQuery.isLoading) return <ReviewQueryState message={t("jobDetail.deepAuditReview.loading")} />;
  if (state.reviewQuery.isError || !state.reviewQuery.data) {
    return <ReviewQueryState message={t("jobDetail.deepAuditReview.loadFailed")} />;
  }
  return (
    <ReviewContent
      review={state.reviewQuery.data}
      decisions={state.decisions}
      pending={state.applyMutation.isPending}
      onAction={state.onAction}
      onTranslation={state.onTranslation}
      onApply={() => state.applyMutation.mutate()}
      t={t}
    />
  );
}
