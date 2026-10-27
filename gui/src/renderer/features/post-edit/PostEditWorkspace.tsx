import type { DragEvent } from "react";
import type { EditedSceneDocument, TranslatedImage } from "../../api/jobs";
import type { PostEditController } from "./usePostEditController";
import { payloadString, translatedImageForPage, translatedImageUrl, type PostEditPreviewMode } from "./postEditModel";
import { TextRegionCorrectionEditor } from "./TextRegionCorrectionEditor";

type Controller = PostEditController;

function JobSelector({ c }: { c: Controller }) {
  return (
    <label className="post-edit-job-selector">
      <span>{c.t("postEdit.selection.title")}</span>
      <select
        value={c.jobId || ""}
        disabled={!c.jobs.length}
        onChange={(e) => c.selectJob(e.currentTarget.value || null)}
      >
        <option value="">{c.t("postEdit.selection.placeholder")}</option>
        {c.jobs.map((job) => (
          <option key={job.id} value={job.id}>
            {[
              payloadString(job, "mangaLabel"),
              payloadString(job, "translatorLabel"),
              payloadString(job, "chapterTitle"),
            ]
              .filter(Boolean)
              .join(" / ") || job.id}
          </option>
        ))}
      </select>
    </label>
  );
}

function ToolbarActions({ c }: { c: Controller }) {
  const { t, document, save, exportJob, actions, branch } = c;
  return (
    <div className="button-row post-edit-toolbar-actions">
      <ToolbarButton
        primary
        disabled={!document.draft || save.isPending}
        onClick={() => document.draft && save.mutate(document.draft)}
        label={t("postEdit.button.save")}
      />
      <ToolbarButton
        disabled={!document.draft || exportJob.isPending}
        onClick={() => void actions.export()}
        label={t("postEdit.button.export")}
      />
      <ToolbarButton
        disabled={!document.draft}
        onClick={() => branch.setEditorOpen((open) => !open)}
        label={t("postEdit.branch.open")}
      />
    </div>
  );
}

function ToolbarButton(props: { label: string; disabled: boolean; onClick: () => void; primary?: boolean }) {
  return (
    <button
      className={props.primary ? "primary-button" : "secondary-button"}
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function BranchField(props: { label: string; value: string; placeholder: string; onChange: (value: string) => void }) {
  return (
    <label>
      <span>{props.label}</span>
      <input
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
    </label>
  );
}

function BranchFields({ c }: { c: Controller }) {
  const { t, branch } = c;
  return (
    <div className="form-grid">
      <BranchField
        label={t("postEdit.branch.translatorLabel")}
        value={branch.translatorLabel}
        placeholder={t("postEdit.branch.translatorPlaceholder")}
        onChange={branch.setTranslatorLabel}
      />
      <BranchField
        label={t("postEdit.branch.chapterLabel")}
        value={branch.chapterTitle}
        placeholder={t("postEdit.branch.chapterPlaceholder")}
        onChange={branch.setChapterTitle}
      />
      <BranchField
        label={t("postEdit.branch.referenceLabel")}
        value={branch.referenceLabel}
        placeholder={t("postEdit.branch.referencePlaceholder")}
        onChange={branch.setReferenceLabel}
      />
    </div>
  );
}

function BranchButtons({ c }: { c: Controller }) {
  const { t, branch, createBranchJob, save } = c;
  return (
    <div className="button-row">
      <button className="secondary-button" type="button" onClick={() => branch.setEditorOpen(false)}>
        {t("postEdit.branch.cancel")}
      </button>
      <button
        className="primary-button"
        type="button"
        disabled={createBranchJob.isPending || save.isPending}
        onClick={() => void createBranchJob.mutateAsync().catch(() => {})}
      >
        {t("postEdit.branch.create")}
      </button>
    </div>
  );
}

function BranchPanel({ c }: { c: Controller }) {
  if (!c.branch.editorOpen) return null;
  return (
    <div className="post-edit-branch-panel">
      <BranchFields c={c} />
      <BranchButtons c={c} />
    </div>
  );
}

function WorkspaceHeader({ c }: { c: Controller }) {
  const { t, document, derived } = c;
  return (
    <header className="post-edit-toolbar">
      <div className="post-edit-toolbar-heading">
        <div>
          <h1>{t("postEdit.title")}</h1>
          <p className="muted-text">{document.status}</p>
        </div>
        <span className={derived.dirty ? "pill pill-warn" : "pill pill-neutral"}>
          {t(derived.dirty ? "settings.state.unsaved" : "settings.state.saved")}
        </span>
      </div>
      <div className="post-edit-toolbar-controls">
        <JobSelector c={c} />
        {document.draft && (
          <div className="post-edit-document-summary">
            {t("postEdit.workspace.summary", {
              pages: document.draft.stats.pageCount,
              nodes: document.draft.stats.textNodeCount,
            })}
          </div>
        )}
        <ToolbarActions c={c} />
      </div>
      <BranchPanel c={c} />
    </header>
  );
}

function PageThumbnail(props: { pageName: string; index: number; image: TranslatedImage | null; onError: () => void }) {
  return (
    <div className="post-edit-page-thumb">
      {props.image ? (
        <img alt={props.pageName} src={translatedImageUrl(props.image)} onError={props.onError} />
      ) : (
        <span>{props.index + 1}</span>
      )}
    </div>
  );
}

function PageCard({ c, pageId }: { c: Controller; pageId: string }) {
  const { document, preview, derived, actions } = c;
  const draft = document.draft as EditedSceneDocument;
  const { page, index, candidate } = pageCardData(draft, derived.images, pageId);
  const image = candidate && !preview.failedImageIds.has(candidate.id) ? candidate : null;
  const dragOver = (event: DragEvent<HTMLLIElement>) => {
    event.preventDefault();
    if (document.draggedPageId !== pageId) actions.reorderPage(pageId);
  };
  return (
    <li
      className={`post-edit-page-card${document.selectedPageId === pageId ? " selected" : ""}${document.draggedPageId === pageId ? " dragging" : ""}`}
      draggable
      onClick={() => actions.selectPage(pageId)}
      onDragStart={() => document.setDraggedPageId(pageId)}
      onDragOver={dragOver}
      onDrop={() => document.setDraggedPageId(null)}
      onDragEnd={() => document.setDraggedPageId(null)}
    >
      <PageThumbnail
        pageName={page.pageName}
        index={index}
        image={image}
        onError={() => candidate && actions.markImageFailed(candidate.id)}
      />
      <PageInfo c={c} index={index} nodeCount={page.nodeOrder.length} />
    </li>
  );
}

function pageCardData(draft: EditedSceneDocument, images: TranslatedImage[], pageId: string) {
  return {
    page: draft.pages[pageId],
    index: draft.pageOrder.indexOf(pageId),
    candidate: translatedImageForPage(images, draft.sourcePageOrder, pageId),
  };
}

function PageInfo({ c, index, nodeCount }: { c: Controller; index: number; nodeCount: number }) {
  return (
    <div className="post-edit-page-info">
      <strong>{c.t("postEdit.workspace.pageNumber", { page: index + 1 })}</strong>
      <span>{c.t("postEdit.workspace.nodeCount", { count: nodeCount })}</span>
    </div>
  );
}

function PagesPane({ c }: { c: Controller }) {
  const { t, document, derived } = c;
  const draft = document.draft as EditedSceneDocument;
  return (
    <aside className="post-edit-pane post-edit-pages-pane">
      <div className="post-edit-pane-header">
        <h2>{t("postEdit.workspace.pages")}</h2>
        <span>{draft.pageOrder.length}</span>
      </div>
      <input
        className="post-edit-page-search"
        value={document.pageSearch}
        onChange={(event) => document.setPageSearch(event.currentTarget.value)}
        placeholder={t("postEdit.workspace.searchPages")}
      />
      <ul className="post-edit-page-list">
        {derived.visiblePages.map((id) => (
          <PageCard key={id} c={c} pageId={id} />
        ))}
      </ul>
    </aside>
  );
}

function BubbleOverlay({ c, nodeId, index }: { c: Controller; nodeId: string; index: number }) {
  const { t, document, preview, derived } = c;
  const node = derived.page?.nodes[nodeId];
  if (!node?.anchor || !preview.dimensions || node.anchor.width <= 0 || node.anchor.height <= 0) return null;
  const style = {
    left: `${(node.anchor.x / preview.dimensions.width) * 100}%`,
    top: `${(node.anchor.y / preview.dimensions.height) * 100}%`,
    width: `${(node.anchor.width / preview.dimensions.width) * 100}%`,
    height: `${(node.anchor.height / preview.dimensions.height) * 100}%`,
  };
  return (
    <button
      type="button"
      className={`post-edit-bubble-overlay${document.selectedNodeId === nodeId ? " selected" : ""}`}
      style={style}
      onClick={() => document.setSelectedNodeId(nodeId)}
      title={t("postEdit.workspace.dialogueNumber", { number: index + 1 })}
    >
      <span>{index + 1}</span>
    </button>
  );
}

function ImageStage({ c }: { c: Controller }) {
  const { preview, derived, actions } = c;
  if (!derived.imageUrl || !derived.page || !derived.previewImageKey) return null;
  return (
    <div className="post-edit-image-stage">
      <img
        alt={`${derived.page.pageName} – ${c.t(`postEdit.preview.${derived.effectivePreviewMode}`)}`}
        src={derived.imageUrl}
        onError={() => actions.markImageFailed(derived.previewImageKey as string)}
        onLoad={(event) =>
          preview.setDimensions({
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          })
        }
      />
      {preview.dimensions &&
        derived.page.nodeOrder.map((id, index) => <BubbleOverlay key={id} c={c} nodeId={id} index={index} />)}
    </div>
  );
}

function previewMessage(c: Controller) {
  if (c.queries.images.isPending) return "postEdit.image.loading";
  if (c.queries.images.isError || (c.derived.image && c.preview.failedImageIds.has(c.derived.image.id))) {
    return "postEdit.image.loadFailed";
  }
  return "postEdit.nodeOrder.noPreview";
}

function selectPreviewMode(c: Controller, mode: PostEditPreviewMode) {
  c.preview.setMode(mode);
  c.preview.setDimensions(null);
}

function PreviewModeToggle({ c }: { c: Controller }) {
  const sourceAvailable = Boolean(c.derived.sourceImage);
  return (
    <div className="post-edit-preview-mode" role="group" aria-label={c.t("postEdit.preview.modeLabel")}>
      <PreviewModeButton c={c} mode="translated" disabled={!c.derived.image} />
      <span title={sourceAvailable ? undefined : c.t("postEdit.preview.sourceUnavailable")}>
        <PreviewModeButton c={c} mode="source" disabled={!sourceAvailable} />
      </span>
    </div>
  );
}

function PreviewModeButton(props: { c: Controller; mode: PostEditPreviewMode; disabled: boolean }) {
  const active = props.c.derived.effectivePreviewMode === props.mode;
  return <button className={active ? "active" : ""} type="button" aria-pressed={active}
    disabled={props.disabled} onClick={() => selectPreviewMode(props.c, props.mode)}>
    {props.c.t(`postEdit.preview.${props.mode}`)}
  </button>;
}

function PreviewPane({ c }: { c: Controller }) {
  const { t, document, derived } = c;
  return (
    <main className="post-edit-pane post-edit-preview-pane">
      <div className="post-edit-pane-header">
        <div><h2>{t("postEdit.workspace.preview")}</h2>
          {derived.page && <span>{t("postEdit.workspace.pagePosition", {
            page: derived.pageIndex + 1, total: document.draft?.pageOrder.length || 0,
          })}</span>}
        </div>
        <PreviewModeToggle c={c} />
      </div>
      <div className="post-edit-preview-scroll">
        {derived.imageUrl ? (
          <ImageStage c={c} />
        ) : (
          <div className="post-edit-node-preview-empty">{t(previewMessage(c))}</div>
        )}
      </div>
    </main>
  );
}

function DialogueCard({ c, nodeId, index }: { c: Controller; nodeId: string; index: number }) {
  const { t, document, derived, actions } = c;
  const node = derived.page!.nodes[nodeId];
  const dragOver = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (document.draggedNodeId !== nodeId) actions.reorderNode(nodeId);
  };
  return (
    <button
      type="button"
      draggable
      className={`post-edit-node-card${document.selectedNodeId === nodeId ? " selected" : ""}${document.draggedNodeId === nodeId ? " dragging" : ""}`}
      onClick={() => document.setSelectedNodeId(nodeId)}
      onDragStart={() => document.setDraggedNodeId(nodeId)}
      onDragOver={dragOver}
      onDrop={() => document.setDraggedNodeId(null)}
      onDragEnd={() => document.setDraggedNodeId(null)}
    >
      <span className="preflight-image-order">{index + 1}</span>
      <span className="post-edit-node-copy">
        <strong>{node.originalText.slice(0, 48) || nodeId}</strong>
        <span>{node.editedTranslation.slice(0, 72) || t("postEdit.nodeOrder.emptyTranslation")}</span>
      </span>
    </button>
  );
}

function DialogueList({ c }: { c: Controller }) {
  return (
    <div className="post-edit-node-list">
      {!c.derived.page && <p>{c.t("postEdit.nodeOrder.empty")}</p>}
      {c.derived.page?.nodeOrder.map((id, index) => (
        <DialogueCard key={id} c={c} nodeId={id} index={index} />
      ))}
    </div>
  );
}

function EditorHeader({ c }: { c: Controller }) {
  const number = (c.derived.page?.nodeOrder.indexOf(c.document.selectedNodeId) || 0) + 1;
  return (
    <div className="post-edit-pane-header">
      <h2>{c.t("postEdit.editor.title")}</h2>
      {c.derived.node && <span>{c.t("postEdit.workspace.dialogueNumber", { number })}</span>}
    </div>
  );
}

function EditorFields({ c }: { c: Controller }) {
  const { t, document, derived, actions } = c;
  if (!derived.node) return <p>{t("postEdit.editor.empty")}</p>;
  const reset = () => {
    actions.updateTranslation(derived.node!.originalTranslation || "");
    document.setStatus(t("postEdit.status.reset"));
  };
  return (
    <>
      <label>
        <span>{t("postEdit.editor.originalText")}</span>
        <textarea readOnly rows={2} value={derived.node.originalText} />
      </label>
      <label>
        <span>{t("postEdit.editor.translation")}</span>
        <textarea
          rows={4}
          value={derived.node.editedTranslation}
          onChange={(event) => actions.updateTranslation(event.currentTarget.value)}
        />
      </label>
      <button className="secondary-button" type="button" onClick={reset}>
        {t("postEdit.button.reset")}
      </button>
    </>
  );
}

function EditorDock({ c }: { c: Controller }) {
  return (
    <div className="post-edit-editor-dock">
      <EditorHeader c={c} />
      <EditorFields c={c} />
      {c.derived.node && <TextRegionCorrectionEditor correction={c.correction} t={c.t} />}
    </div>
  );
}

function DialoguesPane({ c }: { c: Controller }) {
  return (
    <aside className="post-edit-pane post-edit-dialogue-pane">
      <div className="post-edit-pane-header">
        <h2>{c.t("postEdit.workspace.dialogues")}</h2>
        {c.derived.page && <span>{c.derived.page.nodeOrder.length}</span>}
      </div>
      <DialogueList c={c} />
      <EditorDock c={c} />
    </aside>
  );
}

function WorkspaceBody({ c }: { c: Controller }) {
  if (!c.document.draft) {
    const key = c.jobs.length ? "postEdit.pageOrder.empty" : "postEdit.selection.empty";
    return (
      <article className="card post-edit-empty-workspace">
        <p>{c.t(key)}</p>
      </article>
    );
  }
  return (
    <div className="post-edit-workspace-layout">
      <PagesPane c={c} />
      <PreviewPane c={c} />
      <DialoguesPane c={c} />
    </div>
  );
}

export function PostEditWorkspace({ controller }: { controller: Controller }) {
  return (
    <section className="page post-edit-workspace-page">
      <WorkspaceHeader c={controller} />
      <WorkspaceBody c={controller} />
    </section>
  );
}
