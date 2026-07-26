import { useEffect, useMemo, useState } from "react";
import type {
  ExtractionReviewDocument,
  ExtractionReviewPage,
  ReferenceSetSummary,
} from "../../../api/jobs";
import { useLanguageStore } from "../../../stores/language_store";
import { SectionCard } from "../../shared/components/SectionCard";

type Props = {
  referenceSet: ReferenceSetSummary | null;
  review: ExtractionReviewDocument | null;
  loading: boolean;
  error: boolean;
  busy: boolean;
  activeSessionId: string | null;
  onStart: () => void;
  onSync: () => void;
  onFinishEditor: () => void;
  onCancel: () => void;
  onSaveOrder: (pages: Array<{ pageId: string; nodeIds: string[] }>) => void;
  onConfirm: () => void;
};

function moveId(items: string[], sourceId: string, targetId: string) {
  const sourceIndex = items.indexOf(sourceId);
  const targetIndex = items.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return items;
  const next = [...items];
  next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, sourceId);
  return next;
}

export function ExtractionReviewPane(props: Props) {
  const t = useLanguageStore((state) => state.t);
  const [selectedPageId, setSelectedPageId] = useState("");
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const [nodeOrder, setNodeOrder] = useState<Record<string, string[]>>({});

  useEffect(() => {
    const pages = props.review?.pages || [];
    const saved = new Map((props.review?.orderDraft || []).map((page) => [page.pageId, page.nodeIds]));
    setNodeOrder(Object.fromEntries(pages.map((page) => [page.pageId, saved.get(page.pageId) || page.texts.map((node) => node.nodeId)])));
    setSelectedPageId((current) => pages.some((page) => page.pageId === current) ? current : pages[0]?.pageId || "");
  }, [props.review]);

  const selectedPage = useMemo(
    () => props.review?.pages.find((page) => page.pageId === selectedPageId) || null,
    [props.review, selectedPageId]
  );
  const selectedNodes = useMemo(() => {
    if (!selectedPage) return [];
    const byId = new Map(selectedPage.texts.map((node) => [node.nodeId, node]));
    return (nodeOrder[selectedPage.pageId] || []).map((nodeId) => byId.get(nodeId)).filter(Boolean) as ExtractionReviewPage["texts"];
  }, [nodeOrder, selectedPage]);
  const canEditOrder = props.review?.status === "awaiting_order_review";

  return (
    <SectionCard
      title={t("reference.extractionReview.title")}
      description={t("reference.extractionReview.description")}
      defaultOpen={Boolean(props.referenceSet)}
    >
      {!props.referenceSet ? <p className="muted-text">{t("reference.extractionReview.select")}</p> : null}
      {props.referenceSet ? (
        <>
          <div className="summary-grid">
            <div><strong>{t("reference.extractionReview.reference")}</strong><span>{props.referenceSet.chapterTitle || props.referenceSet.label}</span></div>
            <div><strong>{t("reference.extractionReview.status")}</strong><span>{t(`reference.extractionReview.status.${props.review?.status || props.referenceSet.reviewStatus || "awaiting_review"}`)}</span></div>
            <div><strong>{t("reference.extractionReview.rawNodes")}</strong><span>{props.review?.rawSummary.nodeCount ?? props.referenceSet.rawNodeCount}</span></div>
            <div><strong>{t("reference.extractionReview.currentNodes")}</strong><span>{props.review?.draftSummary?.nodeCount ?? props.review?.currentSummary.nodeCount ?? props.referenceSet.currentNodeCount}</span></div>
          </div>
          {props.loading ? <p>{t("shared.state.loading")}</p> : null}
          {props.error ? <p className="error-text">{t("reference.extractionReview.loadFailed")}</p> : null}
          {props.review?.reviewDiff ? (
            <p className="muted-text">
              {t("reference.extractionReview.diff", props.review.reviewDiff)}
            </p>
          ) : null}
          <div className="button-row">
            {!props.activeSessionId && props.review?.status !== "awaiting_order_review" ? (
              <button className="primary-button" type="button" disabled={props.busy || !props.referenceSet.extractionAvailable} onClick={props.onStart}>
                {t(props.review?.status === "reviewed" ? "reference.extractionReview.reopen" : "reference.extractionReview.start")}
              </button>
            ) : null}
            {props.activeSessionId ? (
              <>
                <button className="secondary-button" type="button" disabled={props.busy} onClick={props.onSync}>{t("reference.extractionReview.sync")}</button>
                <button className="primary-button" type="button" disabled={props.busy} onClick={props.onFinishEditor}>{t("reference.extractionReview.finishEditor")}</button>
                <button className="secondary-button danger-button" type="button" disabled={props.busy} onClick={props.onCancel}>{t("reference.extractionReview.cancel")}</button>
              </>
            ) : null}
          </div>
          {canEditOrder ? (
            <div className="extraction-review-order-layout">
              <div className="extraction-review-page-tabs">
                {(props.review?.pages || []).map((page, index) => (
                  <button key={page.pageId} type="button" className={selectedPageId === page.pageId ? "selected" : ""} onClick={() => setSelectedPageId(page.pageId)}>
                    <strong>{`${index + 1}. ${page.pageName}`}</strong>
                    <small>{t("reference.extractionReview.nodeCount", { count: page.texts.length })}</small>
                  </button>
                ))}
              </div>
              <div className="extraction-review-node-order">
                {selectedNodes.map((node, index) => (
                  <button
                    key={node.nodeId}
                    type="button"
                    draggable
                    className={draggedNodeId === node.nodeId ? "dragging" : ""}
                    onDragStart={() => setDraggedNodeId(node.nodeId)}
                    onDragOver={(event) => {
                      event.preventDefault();
                      if (!draggedNodeId || !selectedPage) return;
                      setNodeOrder((current) => ({
                        ...current,
                        [selectedPage.pageId]: moveId(current[selectedPage.pageId] || [], draggedNodeId, node.nodeId),
                      }));
                    }}
                    onDragEnd={() => setDraggedNodeId(null)}
                  >
                    <span>{index + 1}</span>
                    <strong>
                      {node.text || node.nodeId}
                      {node.changeType && node.changeType !== "unchanged" ? (
                        <em className={`review-change review-change-${node.changeType}`}>
                          {t(`reference.extractionReview.change.${node.changeType}`)}
                        </em>
                      ) : null}
                    </strong>
                    <small>
                      {`${t("reference.extractionReview.originalIndex")}: ${node.originalIndex == null ? "-" : node.originalIndex + 1} / ${Math.round(node.bbox.x)}, ${Math.round(node.bbox.y)}`}
                    </small>
                  </button>
                ))}
                {(selectedPage?.removedTexts || []).map((node) => (
                  <div key={`removed-${node.nodeId}`} className="extraction-review-removed-node">
                    <span>{node.originalIndex == null ? "-" : node.originalIndex + 1}</span>
                    <del>{node.text || node.nodeId}</del>
                    <em className="review-change review-change-deleted">
                      {t("reference.extractionReview.change.deleted")}
                    </em>
                  </div>
                ))}
              </div>
              <div className="button-row">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={props.busy}
                  onClick={() => props.onSaveOrder((props.review?.pages || []).map((page) => ({ pageId: page.pageId, nodeIds: nodeOrder[page.pageId] || [] })))}
                >
                  {t("reference.extractionReview.saveOrder")}
                </button>
                <button className="primary-button" type="button" disabled={props.busy || !props.review?.orderDraft} onClick={props.onConfirm}>
                  {t("reference.extractionReview.confirm")}
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </SectionCard>
  );
}
