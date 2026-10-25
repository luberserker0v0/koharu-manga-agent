import { useEffect, useMemo, useState } from "react";
import type { ExtractionReviewDocument, ExtractionReviewPage, ReferenceSetSummary } from "../../../api/jobs";
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

type Translate = (key: string, params?: Record<string, string | number>) => string;
type ReviewNode = ExtractionReviewPage["texts"][number];

function initialOrder(review: ExtractionReviewDocument | null) {
  const pages = review?.pages || [];
  const saved = new Map((review?.orderDraft || []).map((page) => [page.pageId, page.nodeIds]));
  return Object.fromEntries(
    pages.map((page) => [page.pageId, saved.get(page.pageId) || page.texts.map((node) => node.nodeId)]),
  );
}

function orderedNodes(page: ExtractionReviewPage | null, nodeOrder: Record<string, string[]>) {
  if (!page) return [];
  const byId = new Map(page.texts.map((node) => [node.nodeId, node]));
  return (nodeOrder[page.pageId] || [])
    .map((nodeId) => byId.get(nodeId))
    .filter(Boolean) as ExtractionReviewPage["texts"];
}

function useReviewOrder(review: ExtractionReviewDocument | null) {
  const [selectedPageId, setSelectedPageId] = useState("");
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const [nodeOrder, setNodeOrder] = useState<Record<string, string[]>>({});
  useEffect(() => {
    const pages = review?.pages || [];
    setNodeOrder(initialOrder(review));
    setSelectedPageId((current) => (pages.some((page) => page.pageId === current) ? current : pages[0]?.pageId || ""));
  }, [review]);
  const selectedPage = useMemo(
    () => review?.pages.find((page) => page.pageId === selectedPageId) || null,
    [review, selectedPageId],
  );
  const selectedNodes = useMemo(() => orderedNodes(selectedPage, nodeOrder), [nodeOrder, selectedPage]);
  const moveNode = (targetId: string) => {
    if (!draggedNodeId || !selectedPage) return;
    setNodeOrder((current) => ({
      ...current,
      [selectedPage.pageId]: moveId(current[selectedPage.pageId] || [], draggedNodeId, targetId),
    }));
  };
  return { selectedPageId, setSelectedPageId, draggedNodeId, setDraggedNodeId,
    nodeOrder, selectedPage, selectedNodes, moveNode };
}

function ReviewSummaryGrid({ referenceSet, review, t }: {
  referenceSet: ReferenceSetSummary; review: ExtractionReviewDocument | null; t: Translate;
}) {
  const status = review?.status || referenceSet.reviewStatus || "awaiting_review";
  return (
    <div className="summary-grid">
      <div><strong>{t("reference.extractionReview.reference")}</strong>
        <span>{referenceSet.chapterTitle || referenceSet.label}</span></div>
      <div><strong>{t("reference.extractionReview.status")}</strong>
        <span>{t(`reference.extractionReview.status.${status}`)}</span></div>
      <div><strong>{t("reference.extractionReview.rawNodes")}</strong>
        <span>{review?.rawSummary.nodeCount ?? referenceSet.rawNodeCount}</span></div>
      <div><strong>{t("reference.extractionReview.currentNodes")}</strong>
        <span>{review?.draftSummary?.nodeCount ?? review?.currentSummary.nodeCount ?? referenceSet.currentNodeCount}</span></div>
    </div>
  );
}

function ReviewSummary({ props, t }: { props: Props; t: Translate }) {
  const { referenceSet, review } = props;
  if (!referenceSet) return null;
  return (
    <>
      <ReviewSummaryGrid referenceSet={referenceSet} review={review} t={t} />
      {props.loading ? <p>{t("shared.state.loading")}</p> : null}
      {props.error ? <p className="error-text">{t("reference.extractionReview.loadFailed")}</p> : null}
      {review?.reviewDiff ? (
        <p className="muted-text">{t("reference.extractionReview.diff", review.reviewDiff)}</p>
      ) : null}
    </>
  );
}

function ActiveReviewActions({ props, t }: { props: Props; t: Translate }) {
  if (!props.activeSessionId) return null;
  return <>
    <button className="secondary-button" type="button" disabled={props.busy} onClick={props.onSync}>
      {t("reference.extractionReview.sync")}
    </button>
    <button className="primary-button" type="button" disabled={props.busy} onClick={props.onFinishEditor}>
      {t("reference.extractionReview.finishEditor")}
    </button>
    <button className="secondary-button danger-button" type="button" disabled={props.busy} onClick={props.onCancel}>
      {t("reference.extractionReview.cancel")}
    </button>
  </>;
}

function ReviewActions({ props, t }: { props: Props; t: Translate }) {
  const canStart = !props.activeSessionId && props.review?.status !== "awaiting_order_review";
  return (
    <div className="button-row">
      {canStart ? (
        <button className="primary-button" type="button"
          disabled={props.busy || !props.referenceSet?.extractionAvailable} onClick={props.onStart}>
          {t(
            props.review?.status === "reviewed"
              ? "reference.extractionReview.reopen"
              : "reference.extractionReview.start",
          )}
        </button>
      ) : null}
      <ActiveReviewActions props={props} t={t} />
    </div>
  );
}

type PageTabsProps = {
  pages: ExtractionReviewPage[];
  selectedPageId: string;
  onSelect: (id: string) => void;
  t: Translate;
};

function PageTabs({ pages, selectedPageId, onSelect, t }: PageTabsProps) {
  return (
    <div className="extraction-review-page-tabs">
      {pages.map((page, index) => (
        <button
          key={page.pageId}
          type="button"
          className={selectedPageId === page.pageId ? "selected" : ""}
          onClick={() => onSelect(page.pageId)}
        >
          <strong>{`${index + 1}. ${page.pageName}`}</strong>
          <small>
            {t("reference.extractionReview.nodeCount", {
              count: page.texts.length,
            })}
          </small>
        </button>
      ))}
    </div>
  );
}

type NodeButtonProps = {
  node: ReviewNode;
  index: number;
  dragging: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDragEnd: () => void;
  t: Translate;
};

function NodeButton({ node, index, dragging, onDragStart, onDragOver, onDragEnd, t }: NodeButtonProps) {
  return (
    <button
      type="button"
      draggable
      className={dragging ? "dragging" : ""}
      onDragStart={onDragStart}
      onDragOver={(event) => {
        event.preventDefault();
        onDragOver();
      }}
      onDragEnd={onDragEnd}
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
      <small>{`${t("reference.extractionReview.originalIndex")}: ${node.originalIndex == null ? "-" : node.originalIndex + 1} / ${Math.round(node.bbox.x)}, ${Math.round(node.bbox.y)}`}</small>
    </button>
  );
}

function RemovedNodes({ page, t }: { page: ExtractionReviewPage | null; t: Translate }) {
  return <>
    {(page?.removedTexts || []).map((node) => (
      <div key={`removed-${node.nodeId}`} className="extraction-review-removed-node">
        <span>{node.originalIndex == null ? "-" : node.originalIndex + 1}</span>
        <del>{node.text || node.nodeId}</del>
        <em className="review-change review-change-deleted">{t("reference.extractionReview.change.deleted")}</em>
      </div>
    ))}
  </>;
}

type NodeOrderProps = {
  nodes: ExtractionReviewPage["texts"];
  page: ExtractionReviewPage | null;
  draggedNodeId: string | null;
  setDraggedNodeId: (id: string | null) => void;
  moveNode: (id: string) => void;
  t: Translate;
};

function NodeOrder({ nodes, page, draggedNodeId, setDraggedNodeId, moveNode, t }: NodeOrderProps) {
  return (
    <div className="extraction-review-node-order">
      {nodes.map((node, index) => (
        <NodeButton
          key={node.nodeId}
          node={node}
          index={index}
          dragging={draggedNodeId === node.nodeId}
          onDragStart={() => setDraggedNodeId(node.nodeId)}
          onDragOver={() => moveNode(node.nodeId)}
          onDragEnd={() => setDraggedNodeId(null)}
          t={t}
        />
      ))}
      <RemovedNodes page={page} t={t} />
    </div>
  );
}

function OrderEditorActions({ props, save, t }: { props: Props; save: () => void; t: Translate }) {
  return (
    <div className="button-row">
      <button className="secondary-button" type="button" disabled={props.busy} onClick={save}>
        {t("reference.extractionReview.saveOrder")}
      </button>
      <button className="primary-button" type="button" disabled={props.busy || !props.review?.orderDraft}
        onClick={props.onConfirm}>
        {t("reference.extractionReview.confirm")}
      </button>
    </div>
  );
}

function OrderEditor({ props, order, t }: { props: Props; order: ReturnType<typeof useReviewOrder>; t: Translate }) {
  const pages = props.review?.pages || [];
  const save = () =>
    props.onSaveOrder(
      pages.map((page) => ({
        pageId: page.pageId,
        nodeIds: order.nodeOrder[page.pageId] || [],
      })),
    );
  return (
    <div className="extraction-review-order-layout">
      <PageTabs pages={pages} selectedPageId={order.selectedPageId} onSelect={order.setSelectedPageId} t={t} />
      <NodeOrder nodes={order.selectedNodes} page={order.selectedPage} draggedNodeId={order.draggedNodeId}
        setDraggedNodeId={order.setDraggedNodeId} moveNode={order.moveNode} t={t} />
      <OrderEditorActions props={props} save={save} t={t} />
    </div>
  );
}

export function ExtractionReviewPane(props: Props) {
  const t = useLanguageStore((state) => state.t);
  const order = useReviewOrder(props.review);
  return (
    <SectionCard
      title={t("reference.extractionReview.title")}
      description={t("reference.extractionReview.description")}
      defaultOpen={Boolean(props.referenceSet)}
    >
      {!props.referenceSet ? <p className="muted-text">{t("reference.extractionReview.select")}</p> : null}
      {props.referenceSet ? (
        <>
          <ReviewSummary props={props} t={t} />
          <ReviewActions props={props} t={t} />
          {props.review?.status === "awaiting_order_review" ? <OrderEditor props={props} order={order} t={t} /> : null}
        </>
      ) : null}
    </SectionCard>
  );
}
