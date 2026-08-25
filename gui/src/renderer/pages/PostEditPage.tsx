import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type DragEvent } from "react";
import {
  createChapter, createPostEditExportJob, createPostEditReferenceSet, createTranslatorProfile,
  getEditedScene, getJobs, getMangaSeries, getSourcePreflight, saveEditedScene,
  type EditedSceneDocument, type GuiJob,
} from "../api/jobs";
import { readSettings, validatePaths } from "../services/desktop_api";
import { useLanguageStore } from "../stores/language_store";
import { useUiStore } from "../stores/ui_store";
import type { GuiSettings, SourcePreflightImage } from "../types/settings";

function moveId(ids: string[], draggedId: string, targetId: string) {
  const from = ids.indexOf(draggedId);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return ids;
  const next = ids.slice();
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

function cloneScene(scene: EditedSceneDocument): EditedSceneDocument {
  return structuredClone(scene);
}

function isEditableJob(job: GuiJob) {
  if (!["translation", "translation_quality_repair"].includes(job.type) || job.status !== "succeeded") return false;
  if (!job.artifacts.some((artifact) => ["post_edit_document", "edited_scene"].includes(artifact.kind))) return false;
  const publication = job.result && typeof job.result === "object"
    ? (job.result as { publication?: { status?: string } }).publication
    : null;
  return publication?.status !== "superseded";
}

function previewPath(images: SourcePreflightImage[], pageName: string | undefined, pageIndex: number) {
  const image = pageName
    ? images.find((item) => item.fileName === pageName || item.orderedName === pageName
      || item.normalizedPath.endsWith(`\\${pageName}`) || item.previewPath.endsWith(`\\${pageName}`))
    : null;
  return image?.previewPath || images[pageIndex]?.previewPath || null;
}

function payloadString(job: GuiJob | null, key: string) {
  const value = job?.payload[key];
  return typeof value === "string" ? value : "";
}

export function PostEditPage() {
  const t = useLanguageStore((state) => state.t);
  const queryClient = useQueryClient();
  const selectedJobId = useUiStore((state) => state.selectedJobId);
  const setSelectedJobId = useUiStore((state) => state.setSelectedJobId);
  const setSelectedPage = useUiStore((state) => state.setSelectedPage);
  const [draft, setDraft] = useState<EditedSceneDocument | null>(null);
  const [selectedPageId, setSelectedPageId] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [draggedPageId, setDraggedPageId] = useState<string | null>(null);
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const [status, setStatus] = useState(t("postEdit.status.ready"));
  const [settingsSnapshot, setSettingsSnapshot] = useState<GuiSettings | null>(null);
  const [seededJobId, setSeededJobId] = useState<string | null>(null);
  const [branchTranslatorLabel, setBranchTranslatorLabel] = useState("");
  const [branchChapterTitle, setBranchChapterTitle] = useState("");
  const [branchReferenceLabel, setBranchReferenceLabel] = useState("");
  const [branchEditorOpen, setBranchEditorOpen] = useState(false);
  const [pageSearch, setPageSearch] = useState("");
  const [previewDimensions, setPreviewDimensions] = useState<{ width: number; height: number } | null>(null);

  const jobsQuery = useQuery({ queryKey: ["jobs"], queryFn: getJobs });
  const mangaQuery = useQuery({ queryKey: ["manga-series"], queryFn: getMangaSeries });
  const jobs = useMemo(() => (jobsQuery.data?.jobs || []).filter(isEditableJob), [jobsQuery.data]);
  const sceneQuery = useQuery({ queryKey: ["edited-scene", selectedJobId], queryFn: () => getEditedScene(selectedJobId as string), enabled: Boolean(selectedJobId) });
  const selectedJob = jobs.find((job) => job.id === selectedJobId) || null;
  const preflightId = draft?.sourcePreflightId || payloadString(selectedJob, "sourcePreflightId") || null;
  const preflightQuery = useQuery({ queryKey: ["source-preflight", preflightId], queryFn: () => getSourcePreflight(preflightId as string), enabled: Boolean(preflightId) });
  const images = preflightQuery.data?.images || [];
  const selectedManga = (mangaQuery.data?.series || []).find((item) => item.mangaId === draft?.mangaId) || null;
  const sourceTranslator = selectedManga?.translators.find((item) => item.translatorId === draft?.translatorId) || null;
  const sourceChapter = sourceTranslator?.chapters.find((item) => item.chapterId === draft?.chapterId) || null;

  useEffect(() => { readSettings().then(setSettingsSnapshot).catch(() => {}); }, []);
  useEffect(() => {
    if (!selectedJobId && jobs[0]) setSelectedJobId(jobs[0].id);
    else if (selectedJobId && !jobs.some((job) => job.id === selectedJobId)) setSelectedJobId(jobs[0]?.id || null);
  }, [jobs, selectedJobId, setSelectedJobId]);
  useEffect(() => {
    if (!sceneQuery.data?.exists || !sceneQuery.data.editedScene) {
      setDraft(null); setSelectedPageId(""); setSelectedNodeId(""); return;
    }
    const next = cloneScene(sceneQuery.data.editedScene);
    const firstPage = next.pageOrder[0] || "";
    setDraft(next);
    setSelectedPageId(firstPage);
    setSelectedNodeId(firstPage ? next.pages[firstPage]?.nodeOrder[0] || "" : "");
  }, [sceneQuery.data]);
  useEffect(() => {
    if (!selectedJob || seededJobId === selectedJob.id) return;
    const translator = payloadString(selectedJob, "translatorLabel") || payloadString(selectedJob, "translator");
    const nextTranslator = translator ? `${translator}${t("postEdit.branch.revisionSuffix")}` : "";
    const chapter = payloadString(selectedJob, "chapterTitle");
    setBranchTranslatorLabel(nextTranslator);
    setBranchChapterTitle(chapter);
    setBranchReferenceLabel([payloadString(selectedJob, "mangaLabel"), nextTranslator, chapter].filter(Boolean).join(" / "));
    setSeededJobId(selectedJob.id);
  }, [seededJobId, selectedJob, t]);

  const saveMutation = useMutation({
    mutationFn: (scene: EditedSceneDocument) => saveEditedScene(scene.jobId, scene),
    onSuccess: async (result) => {
      setDraft(cloneScene(result.editedScene));
      setStatus(t("postEdit.status.saved"));
      await queryClient.invalidateQueries({ queryKey: ["edited-scene", result.editedScene.jobId] });
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error) => setStatus(error instanceof Error ? error.message : t("postEdit.status.saveFailed")),
  });
  const exportMutation = useMutation({
    mutationFn: (payload: { jobId: string; outputDir: string }) => createPostEditExportJob({ sourceJobId: payload.jobId, outputDir: payload.outputDir }),
    onSuccess: async (job) => {
      setStatus(t("postEdit.status.exportCreated")); setSelectedJobId(job.id); setSelectedPage("job-list");
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error) => setStatus(error instanceof Error ? error.message : t("postEdit.status.exportFailed")),
  });
  const branchMutation = useMutation({
    mutationFn: async () => {
      if (!draft?.jobId || !draft.mangaId) throw new Error(t("postEdit.branch.documentRequired"));
      const translatorLabel = branchTranslatorLabel.trim();
      if (!translatorLabel) throw new Error(t("postEdit.branch.translatorRequired"));
      const chapterTitle = branchChapterTitle.trim() || sourceChapter?.chapterTitle || t("postEdit.branch.untitledChapter");
      const referenceLabel = branchReferenceLabel.trim() || [selectedManga?.label || draft.mangaId, translatorLabel, chapterTitle].filter(Boolean).join(" / ");
      const saved = await saveMutation.mutateAsync(draft);
      const translator = await createTranslatorProfile(draft.mangaId, { label: translatorLabel, language: selectedManga?.language || "zh-TW" });
      const chapter = await createChapter(draft.mangaId, translator.translator.translatorId, { chapterTitle });
      await createPostEditReferenceSet(saved.editedScene.jobId, {
        label: referenceLabel, language: selectedManga?.language || "zh-TW", referenceKind: "translator",
        mangaId: draft.mangaId, mangaLabel: selectedManga?.label || draft.mangaId,
        translatorId: translator.translator.translatorId, translatorLabel: translator.translator.label,
        chapterId: chapter.chapter.chapterId, chapterTitle: chapter.chapter.chapterTitle || chapterTitle,
      });
      return { translator: translator.translator, chapter: chapter.chapter };
    },
    onSuccess: async (result) => {
      setStatus(t("postEdit.branch.created", { translator: result.translator.label, chapter: result.chapter.chapterTitle || result.chapter.chapterId }));
      setBranchEditorOpen(false);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["manga-series"] }), queryClient.invalidateQueries({ queryKey: ["reference-sets"] }), queryClient.invalidateQueries({ queryKey: ["jobs"] })]);
    },
    onError: (error) => setStatus(error instanceof Error ? error.message : t("postEdit.branch.failed")),
  });

  const selectedPage = draft && selectedPageId ? draft.pages[selectedPageId] : null;
  const pageIndex = draft ? draft.pageOrder.indexOf(selectedPageId) : -1;
  const selectedNode = selectedPage && selectedNodeId ? selectedPage.nodes[selectedNodeId] || null : null;
  const selectedImage = selectedPage && pageIndex >= 0 ? previewPath(images, selectedPage.pageName, pageIndex) : null;
  const dirty = Boolean(draft && sceneQuery.data?.editedScene && JSON.stringify(draft) !== JSON.stringify(sceneQuery.data.editedScene));
  const visiblePages = (draft?.pageOrder || []).filter((id) => {
    const search = pageSearch.trim().toLowerCase();
    if (!search || !draft) return true;
    return draft.pages[id]?.pageName.toLowerCase().includes(search) || String(draft.pageOrder.indexOf(id) + 1).includes(search);
  });

  const updateTranslation = (translation: string) => {
    setDraft((current) => {
      if (!current || !selectedPageId || !selectedNodeId) return current;
      const page = current.pages[selectedPageId];
      return { ...current, pages: { ...current.pages, [selectedPageId]: { ...page, nodes: { ...page.nodes, [selectedNodeId]: { ...page.nodes[selectedNodeId], editedTranslation: translation } } } } };
    });
  };
  const selectPage = (pageId: string) => {
    if (!draft) return;
    setSelectedPageId(pageId);
    setSelectedNodeId(draft.pages[pageId]?.nodeOrder[0] || "");
    setPreviewDimensions(null);
  };
  const handleExport = async () => {
    if (!draft) return;
    try {
      const settings = settingsSnapshot || await readSettings();
      setSettingsSnapshot(settings);
      const outputDir = settings.outputFolder.trim();
      if (!outputDir) throw new Error(t("postEdit.export.outputRequired"));
      const validation = await validatePaths({ sourceFolder: "", outputFolder: outputDir, referenceFolder: settings.referenceFolder, sourceRequired: false });
      if (!validation.outputFolder.ok) throw new Error(t("postEdit.export.outputInvalid", { reason: validation.outputFolder.reason }));
      const saved = await saveMutation.mutateAsync(draft);
      exportMutation.mutate({ jobId: saved.editedScene.jobId, outputDir });
    } catch (error) { setStatus(error instanceof Error ? error.message : t("postEdit.status.exportFailed")); }
  };

  return (
    <section className="page post-edit-workspace-page">
      <header className="post-edit-toolbar">
        <div className="post-edit-toolbar-heading"><div><h1>{t("postEdit.title")}</h1><p className="muted-text">{status}</p></div><span className={dirty ? "pill pill-warn" : "pill pill-neutral"}>{t(dirty ? "settings.state.unsaved" : "settings.state.saved")}</span></div>
        <div className="post-edit-toolbar-controls">
          <label className="post-edit-job-selector"><span>{t("postEdit.selection.title")}</span><select value={selectedJobId || ""} disabled={!jobs.length} onChange={(event) => setSelectedJobId(event.currentTarget.value || null)}><option value="">{t("postEdit.selection.placeholder")}</option>{jobs.map((job) => <option key={job.id} value={job.id}>{[payloadString(job, "mangaLabel"), payloadString(job, "translatorLabel"), payloadString(job, "chapterTitle")].filter(Boolean).join(" / ") || job.id}</option>)}</select></label>
          {draft && <div className="post-edit-document-summary">{t("postEdit.workspace.summary", { pages: draft.stats.pageCount, nodes: draft.stats.textNodeCount })}</div>}
          <div className="button-row post-edit-toolbar-actions"><button className="primary-button" type="button" disabled={!draft || saveMutation.isPending} onClick={() => draft && saveMutation.mutate(draft)}>{t("postEdit.button.save")}</button><button className="secondary-button" type="button" disabled={!draft || exportMutation.isPending} onClick={() => void handleExport()}>{t("postEdit.button.export")}</button><button className="secondary-button" type="button" disabled={!draft} onClick={() => setBranchEditorOpen((open) => !open)}>{t("postEdit.branch.open")}</button></div>
        </div>
        {branchEditorOpen && <div className="post-edit-branch-panel"><div className="form-grid"><label><span>{t("postEdit.branch.translatorLabel")}</span><input value={branchTranslatorLabel} onChange={(event) => setBranchTranslatorLabel(event.currentTarget.value)} placeholder={t("postEdit.branch.translatorPlaceholder")} /></label><label><span>{t("postEdit.branch.chapterLabel")}</span><input value={branchChapterTitle} onChange={(event) => setBranchChapterTitle(event.currentTarget.value)} placeholder={t("postEdit.branch.chapterPlaceholder")} /></label><label><span>{t("postEdit.branch.referenceLabel")}</span><input value={branchReferenceLabel} onChange={(event) => setBranchReferenceLabel(event.currentTarget.value)} placeholder={t("postEdit.branch.referencePlaceholder")} /></label></div><div className="button-row"><button className="secondary-button" type="button" onClick={() => setBranchEditorOpen(false)}>{t("postEdit.branch.cancel")}</button><button className="primary-button" type="button" disabled={branchMutation.isPending || saveMutation.isPending} onClick={() => void branchMutation.mutateAsync().catch(() => {})}>{t("postEdit.branch.create")}</button></div></div>}
      </header>

      {!draft ? <article className="card post-edit-empty-workspace"><p>{t(jobs.length ? "postEdit.pageOrder.empty" : "postEdit.selection.empty")}</p></article> : <div className="post-edit-workspace-layout">
        <aside className="post-edit-pane post-edit-pages-pane"><div className="post-edit-pane-header"><h2>{t("postEdit.workspace.pages")}</h2><span>{draft.pageOrder.length}</span></div><input className="post-edit-page-search" value={pageSearch} onChange={(event) => setPageSearch(event.currentTarget.value)} placeholder={t("postEdit.workspace.searchPages")} /><ul className="post-edit-page-list">
          {visiblePages.map((pageId) => {
            const page = draft.pages[pageId];
            const index = draft.pageOrder.indexOf(pageId);
            const image = previewPath(images, page.pageName, index);
            return <li key={pageId} className={`post-edit-page-card${selectedPageId === pageId ? " selected" : ""}${draggedPageId === pageId ? " dragging" : ""}`} draggable onClick={() => selectPage(pageId)} onDragStart={() => setDraggedPageId(pageId)} onDragOver={(event: DragEvent<HTMLLIElement>) => { event.preventDefault(); if (draggedPageId && draggedPageId !== pageId) setDraft((current) => current ? { ...current, pageOrder: moveId(current.pageOrder, draggedPageId, pageId) } : current); }} onDrop={() => setDraggedPageId(null)} onDragEnd={() => setDraggedPageId(null)}><div className="post-edit-page-thumb">{image ? <img alt={page.pageName} src={image} /> : <span>{index + 1}</span>}</div><div className="post-edit-page-info"><strong>{t("postEdit.workspace.pageNumber", { page: index + 1 })}</strong><span>{t("postEdit.workspace.nodeCount", { count: page.nodeOrder.length })}</span></div></li>;
          })}
        </ul></aside>

        <main className="post-edit-pane post-edit-preview-pane"><div className="post-edit-pane-header"><h2>{t("postEdit.workspace.preview")}</h2>{selectedPage && <span>{t("postEdit.workspace.pagePosition", { page: pageIndex + 1, total: draft.pageOrder.length })}</span>}</div><div className="post-edit-preview-scroll">{selectedImage && selectedPage ? <div className="post-edit-image-stage"><img alt={selectedPage.pageName} src={selectedImage} onLoad={(event) => setPreviewDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />{previewDimensions && selectedPage.nodeOrder.map((nodeId, index) => { const node = selectedPage.nodes[nodeId]; if (!node?.anchor || node.anchor.width <= 0 || node.anchor.height <= 0) return null; return <button key={nodeId} type="button" className={`post-edit-bubble-overlay${selectedNodeId === nodeId ? " selected" : ""}`} style={{ left: `${node.anchor.x / previewDimensions.width * 100}%`, top: `${node.anchor.y / previewDimensions.height * 100}%`, width: `${node.anchor.width / previewDimensions.width * 100}%`, height: `${node.anchor.height / previewDimensions.height * 100}%` }} onClick={() => setSelectedNodeId(nodeId)} title={t("postEdit.workspace.dialogueNumber", { number: index + 1 })}><span>{index + 1}</span></button>; })}</div> : <div className="post-edit-node-preview-empty">{t("postEdit.nodeOrder.noPreview")}</div>}</div></main>

        <aside className="post-edit-pane post-edit-dialogue-pane"><div className="post-edit-pane-header"><h2>{t("postEdit.workspace.dialogues")}</h2>{selectedPage && <span>{selectedPage.nodeOrder.length}</span>}</div><div className="post-edit-node-list">{!selectedPage && <p>{t("postEdit.nodeOrder.empty")}</p>}{selectedPage?.nodeOrder.map((nodeId, index) => { const node = selectedPage.nodes[nodeId]; return <button key={nodeId} type="button" draggable className={`post-edit-node-card${selectedNodeId === nodeId ? " selected" : ""}${draggedNodeId === nodeId ? " dragging" : ""}`} onClick={() => setSelectedNodeId(nodeId)} onDragStart={() => setDraggedNodeId(nodeId)} onDragOver={(event: DragEvent<HTMLButtonElement>) => { event.preventDefault(); if (!draggedNodeId || draggedNodeId === nodeId) return; setDraft((current) => { if (!current || !selectedPageId) return current; const page = current.pages[selectedPageId]; return { ...current, pages: { ...current.pages, [selectedPageId]: { ...page, nodeOrder: moveId(page.nodeOrder, draggedNodeId, nodeId) } } }; }); }} onDrop={() => setDraggedNodeId(null)} onDragEnd={() => setDraggedNodeId(null)}><span className="preflight-image-order">{index + 1}</span><span className="post-edit-node-copy"><strong>{node.originalText.slice(0, 48) || nodeId}</strong><span>{node.editedTranslation.slice(0, 72) || t("postEdit.nodeOrder.emptyTranslation")}</span></span></button>; })}</div><div className="post-edit-editor-dock"><div className="post-edit-pane-header"><h2>{t("postEdit.editor.title")}</h2>{selectedNode && <span>{t("postEdit.workspace.dialogueNumber", { number: (selectedPage?.nodeOrder.indexOf(selectedNodeId) || 0) + 1 })}</span>}</div>{!selectedNode ? <p>{t("postEdit.editor.empty")}</p> : <><label><span>{t("postEdit.editor.originalText")}</span><textarea readOnly rows={2} value={selectedNode.originalText} /></label><label><span>{t("postEdit.editor.translation")}</span><textarea rows={4} value={selectedNode.editedTranslation} onChange={(event) => updateTranslation(event.currentTarget.value)} /></label><button className="secondary-button" type="button" onClick={() => { updateTranslation(selectedNode.originalTranslation || ""); setStatus(t("postEdit.status.reset")); }}>{t("postEdit.button.reset")}</button></>}</div></aside>
      </div>}
    </section>
  );
}
