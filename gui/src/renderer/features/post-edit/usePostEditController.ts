import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  createChapter,
  createPostEditExportJob,
  createPostEditReferenceSet,
  createTranslatorProfile,
  getEditedScene,
  getJobs,
  getMangaSeries,
  getSourcePreflight,
  getTranslatedImages,
  saveEditedScene,
  type EditedSceneDocument,
  type GuiJob,
} from "../../api/jobs";
import { useLanguageStore } from "../../stores/language_store";
import { useUiStore } from "../../stores/ui_store";
import {
  cloneScene,
  isEditableJob,
  payloadString,
  reorderNodes,
  reorderPages,
  resolvePostEditPreview,
  sourceImageForPage,
  translatedImageForPage,
  type PostEditPreviewMode,
  updateNodeTranslation,
} from "./postEditModel";
import { useTextRegionCorrection } from "./useTextRegionCorrection";

type Translate = ReturnType<typeof useLanguageStore.getState>["t"];
type Manga = Awaited<ReturnType<typeof getMangaSeries>>["series"][number];
type Chapter = Manga["translators"][number]["chapters"][number];

function usePostEditQueries(jobId: string | null) {
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: getJobs });
  const manga = useQuery({ queryKey: ["manga-series"], queryFn: getMangaSeries });
  const scene = useQuery({
    queryKey: ["edited-scene", jobId],
    queryFn: () => getEditedScene(jobId as string),
    enabled: Boolean(jobId),
  });
  const images = useQuery({
    queryKey: ["translated-images", jobId],
    queryFn: () => getTranslatedImages(jobId as string),
    enabled: Boolean(jobId),
    retry: 1,
  });
  const preflightId = scene.data?.editedScene?.sourcePreflightId || null;
  const sourceImages = useQuery({
    queryKey: ["source-preflight", preflightId],
    queryFn: () => getSourcePreflight(preflightId as string),
    enabled: Boolean(preflightId),
    retry: false,
  });
  return { jobs, manga, scene, images, sourceImages };
}

function useDocumentState(t: Translate) {
  const [draft, setDraft] = useState<EditedSceneDocument | null>(null);
  const [selectedPageId, setSelectedPageId] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [draggedPageId, setDraggedPageId] = useState<string | null>(null);
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const [status, setStatus] = useState(t("postEdit.status.ready"));
  const [pageSearch, setPageSearch] = useState("");
  return {
    draft,
    setDraft,
    selectedPageId,
    setSelectedPageId,
    selectedNodeId,
    setSelectedNodeId,
    draggedPageId,
    setDraggedPageId,
    draggedNodeId,
    setDraggedNodeId,
    status,
    setStatus,
    pageSearch,
    setPageSearch,
  };
}

function useBranchState() {
  const [translatorLabel, setTranslatorLabel] = useState("");
  const [chapterTitle, setChapterTitle] = useState("");
  const [referenceLabel, setReferenceLabel] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [seededJobId, setSeededJobId] = useState<string | null>(null);
  return {
    translatorLabel,
    setTranslatorLabel,
    chapterTitle,
    setChapterTitle,
    referenceLabel,
    setReferenceLabel,
    editorOpen,
    setEditorOpen,
    seededJobId,
    setSeededJobId,
  };
}

function usePreviewState() {
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [failedImageIds, setFailedImageIds] = useState<Set<string>>(() => new Set());
  const [mode, setMode] = useState<PostEditPreviewMode>("translated");
  return { dimensions, setDimensions, failedImageIds, setFailedImageIds, mode, setMode };
}

function useJobSelectionEffect(jobId: string | null, jobs: { id: string }[], selectJob: (id: string | null) => void) {
  useEffect(() => {
    if (!jobId && jobs[0]) selectJob(jobs[0].id);
    else if (jobId && !jobs.some((job) => job.id === jobId)) selectJob(jobs[0]?.id || null);
  }, [jobId, jobs, selectJob]);
}

function useSceneEffect(
  scene: ReturnType<typeof usePostEditQueries>["scene"],
  document: ReturnType<typeof useDocumentState>,
) {
  useEffect(() => {
    if (!scene.data?.exists || !scene.data.editedScene) {
      document.setDraft(null);
      document.setSelectedPageId("");
      document.setSelectedNodeId("");
      return;
    }
    const draft = cloneScene(scene.data.editedScene);
    const pageId = draft.pageOrder[0] || "";
    document.setDraft(draft);
    document.setSelectedPageId(pageId);
    document.setSelectedNodeId(pageId ? draft.pages[pageId]?.nodeOrder[0] || "" : "");
  }, [scene.data]);
}

function usePreviewResetEffect(jobId: string | null, preview: ReturnType<typeof usePreviewState>) {
  useEffect(() => {
    preview.setFailedImageIds(new Set());
    preview.setDimensions(null);
    preview.setMode("translated");
  }, [jobId]);
}

function useBranchSeedEffect(job: GuiJob | null, branch: ReturnType<typeof useBranchState>, t: Translate) {
  useEffect(() => {
    if (!job || branch.seededJobId === job.id) return;
    const translator = payloadString(job, "translatorLabel") || payloadString(job, "translator");
    const nextTranslator = translator ? `${translator}${t("postEdit.branch.revisionSuffix")}` : "";
    const chapter = payloadString(job, "chapterTitle");
    branch.setTranslatorLabel(nextTranslator);
    branch.setChapterTitle(chapter);
    branch.setReferenceLabel([payloadString(job, "mangaLabel"), nextTranslator, chapter].filter(Boolean).join(" / "));
    branch.setSeededJobId(job.id);
  }, [branch.seededJobId, job, t]);
}

async function createBranch(
  draft: EditedSceneDocument,
  branch: ReturnType<typeof useBranchState>,
  manga: Manga | null,
  chapter: Chapter | null,
  t: Translate,
) {
  const translatorLabel = branch.translatorLabel.trim();
  if (!draft.jobId || !draft.mangaId) throw new Error(t("postEdit.branch.documentRequired"));
  if (!translatorLabel) throw new Error(t("postEdit.branch.translatorRequired"));
  const chapterTitle = branch.chapterTitle.trim() || chapter?.chapterTitle || t("postEdit.branch.untitledChapter");
  const label =
    branch.referenceLabel.trim() || [manga?.label || draft.mangaId, translatorLabel, chapterTitle].join(" / ");
  const saved = await saveEditedScene(draft.jobId, draft);
  const translator = await createTranslatorProfile(draft.mangaId, {
    label: translatorLabel,
    language: manga?.language || "zh-TW",
  });
  const createdChapter = await createChapter(draft.mangaId, translator.translator.translatorId, { chapterTitle });
  await createPostEditReferenceSet(
    saved.editedScene.jobId,
    buildReferencePayload(draft, manga, translator.translator, createdChapter.chapter, label, chapterTitle),
  );
  return { translator: translator.translator, chapter: createdChapter.chapter };
}

function buildReferencePayload(
  draft: EditedSceneDocument,
  manga: Manga | null,
  translator: { translatorId: string; label: string },
  chapter: Chapter,
  label: string,
  chapterTitle: string,
) {
  return {
    label,
    language: manga?.language || "zh-TW",
    referenceKind: "translator" as const,
    mangaId: draft.mangaId || "",
    mangaLabel: manga?.label || draft.mangaId || "",
    translatorId: translator.translatorId,
    translatorLabel: translator.label,
    chapterId: chapter.chapterId,
    chapterTitle: chapter.chapterTitle || chapterTitle,
  };
}

function useSaveMutation(document: ReturnType<typeof useDocumentState>, t: Translate) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (scene: EditedSceneDocument) => saveEditedScene(scene.jobId, scene),
    onSuccess: async (result) => {
      document.setDraft(cloneScene(result.editedScene));
      document.setStatus(t("postEdit.status.saved"));
      await client.invalidateQueries({ queryKey: ["edited-scene", result.editedScene.jobId] });
      await client.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error) => document.setStatus(error instanceof Error ? error.message : t("postEdit.status.saveFailed")),
  });
}

function useExportMutation(document: ReturnType<typeof useDocumentState>, t: Translate) {
  const client = useQueryClient();
  const selectJob = useUiStore((state) => state.setSelectedJobId);
  const selectPage = useUiStore((state) => state.setSelectedPage);
  return useMutation({
    mutationFn: (jobId: string) => createPostEditExportJob({ sourceJobId: jobId }),
    onSuccess: async (job) => {
      document.setStatus(t("postEdit.status.exportCreated"));
      selectJob(job.id);
      selectPage("job-list");
      await client.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error) => document.setStatus(error instanceof Error ? error.message : t("postEdit.status.exportFailed")),
  });
}

function useBranchMutation(context: {
  document: ReturnType<typeof useDocumentState>;
  branch: ReturnType<typeof useBranchState>;
  manga: Manga | null;
  chapter: Chapter | null;
  t: Translate;
}) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!context.document.draft) throw new Error(context.t("postEdit.branch.documentRequired"));
      return createBranch(context.document.draft, context.branch, context.manga, context.chapter, context.t);
    },
    onSuccess: async (result) => {
      context.document.setStatus(
        context.t("postEdit.branch.created", {
          translator: result.translator.label,
          chapter: result.chapter.chapterTitle || result.chapter.chapterId,
        }),
      );
      context.branch.setEditorOpen(false);
      await Promise.all(
        ["manga-series", "reference-sets", "jobs"].map((key) => client.invalidateQueries({ queryKey: [key] })),
      );
    },
    onError: (error) =>
      context.document.setStatus(error instanceof Error ? error.message : context.t("postEdit.branch.failed")),
  });
}

function useDocumentActions(
  document: ReturnType<typeof useDocumentState>,
  preview: ReturnType<typeof usePreviewState>,
) {
  const updateTranslation = (value: string) =>
    document.setDraft(
      (scene) => scene && updateNodeTranslation(scene, document.selectedPageId, document.selectedNodeId, value),
    );
  const selectPage = (pageId: string) => {
    if (!document.draft) return;
    document.setSelectedPageId(pageId);
    document.setSelectedNodeId(document.draft.pages[pageId]?.nodeOrder[0] || "");
    preview.setDimensions(null);
  };
  const reorderPage = (targetId: string) =>
    document.setDraft((scene) =>
      scene && document.draggedPageId ? reorderPages(scene, document.draggedPageId, targetId) : scene,
    );
  const reorderNode = (targetId: string) =>
    document.setDraft((scene) =>
      scene && document.draggedNodeId
        ? reorderNodes(scene, document.selectedPageId, document.draggedNodeId, targetId)
        : scene,
    );
  const markImageFailed = (id: string) => {
    preview.setFailedImageIds((ids) => new Set(ids).add(id));
    preview.setDimensions(null);
  };
  return { updateTranslation, selectPage, reorderPage, reorderNode, markImageFailed };
}

function useExportAction(
  document: ReturnType<typeof useDocumentState>,
  mutation: ReturnType<typeof useExportMutation>,
  t: Translate,
) {
  return async () => {
    if (!document.draft) return;
    try {
      const saved = await saveEditedScene(document.draft.jobId, document.draft);
      mutation.mutate(saved.editedScene.jobId);
    } catch (error) {
      document.setStatus(error instanceof Error ? error.message : t("postEdit.status.exportFailed"));
    }
  };
}

function deriveWorkspace(
  document: ReturnType<typeof useDocumentState>,
  preview: ReturnType<typeof usePreviewState>,
  queries: ReturnType<typeof usePostEditQueries>,
) {
  const page = document.draft?.pages[document.selectedPageId] || null;
  const node = page?.nodes[document.selectedNodeId] || null;
  const images = queries.images.data?.images || [];
  const image =
    document.draft && page ? translatedImageForPage(images, document.draft.sourcePageOrder, page.pageId) : null;
  const sourceImage = sourceImageForPage(queries.sourceImages.data?.images || [], page?.sourceImageId);
  const previewImage = resolvePostEditPreview(preview.mode, sourceImage, image, preview.failedImageIds);
  const baseline = queries.scene.data?.editedScene;
  const dirty = Boolean(document.draft && baseline && JSON.stringify(document.draft) !== JSON.stringify(baseline));
  const visiblePages = filterPages(document.draft, document.pageSearch);
  return {
    page,
    node,
    image,
    imageUrl: previewImage?.url || null,
    sourceImage,
    previewImageKey: previewImage?.key || null,
    effectivePreviewMode: previewImage?.mode || "translated" as const,
    images,
    dirty,
    visiblePages,
    pageIndex: document.draft?.pageOrder.indexOf(document.selectedPageId) ?? -1,
  };
}

function filterPages(draft: EditedSceneDocument | null, input: string) {
  const search = input.trim().toLowerCase();
  return (draft?.pageOrder || []).filter((id) => {
    if (!search || !draft) return true;
    return (
      draft.pages[id]?.pageName.toLowerCase().includes(search) ||
      String(draft.pageOrder.indexOf(id) + 1).includes(search)
    );
  });
}

function useControllerEffects(context: {
  jobId: string | null;
  jobs: GuiJob[];
  selectJob: (id: string | null) => void;
  queries: ReturnType<typeof usePostEditQueries>;
  document: ReturnType<typeof useDocumentState>;
  preview: ReturnType<typeof usePreviewState>;
  branch: ReturnType<typeof useBranchState>;
  job: GuiJob | null;
  t: Translate;
}) {
  useJobSelectionEffect(context.jobId, context.jobs, context.selectJob);
  useSceneEffect(context.queries.scene, context.document);
  usePreviewResetEffect(context.jobId, context.preview);
  useBranchSeedEffect(context.job, context.branch, context.t);
}

function resolvePostEditBinding(queries: ReturnType<typeof usePostEditQueries>, document: ReturnType<typeof useDocumentState>) {
  const manga = (queries.manga.data?.series || []).find((item) => item.mangaId === document.draft?.mangaId) || null;
  const translator = manga?.translators.find((item) => item.translatorId === document.draft?.translatorId);
  const chapter = translator?.chapters.find((item) => item.chapterId === document.draft?.chapterId) || null;
  return { manga, chapter };
}

function useWorkspaceMutations(
  document: ReturnType<typeof useDocumentState>, branch: ReturnType<typeof useBranchState>,
  binding: ReturnType<typeof resolvePostEditBinding>, t: Translate,
) {
  const save = useSaveMutation(document, t);
  const exportJob = useExportMutation(document, t);
  const createBranchJob = useBranchMutation({ document, branch, ...binding, t });
  return { save, exportJob, createBranchJob };
}

function useWorkspaceCorrection(
  jobId: string | null, derived: ReturnType<typeof deriveWorkspace>,
  document: ReturnType<typeof useDocumentState>, t: Translate,
) {
  return useTextRegionCorrection({
    jobId, page: derived.page, node: derived.node, setStatus: document.setStatus, t,
  });
}

export function usePostEditController() {
  const t = useLanguageStore((state) => state.t);
  const jobId = useUiStore((state) => state.selectedJobId);
  const selectJob = useUiStore((state) => state.setSelectedJobId);
  const document = useDocumentState(t);
  const branch = useBranchState();
  const preview = usePreviewState();
  const queries = usePostEditQueries(jobId);
  const jobs = useMemo(() => (queries.jobs.data?.jobs || []).filter(isEditableJob), [queries.jobs.data]);
  const job = jobs.find((item) => item.id === jobId) || null;
  const binding = resolvePostEditBinding(queries, document);
  useControllerEffects({ jobId, jobs, selectJob, queries, document, preview, branch, job, t });
  const { save, exportJob, createBranchJob } = useWorkspaceMutations(document, branch, binding, t);
  const actions = useDocumentActions(document, preview);
  const derived = deriveWorkspace(document, preview, queries);
  const correction = useWorkspaceCorrection(jobId, derived, document, t);
  const core = { t, jobId, selectJob, jobs, document, branch, preview, queries };
  return {
    ...core,
    save,
    exportJob,
    createBranchJob,
    correction,
    actions: { ...actions, export: useExportAction(document, exportJob, t) },
    derived,
  };
}

export type PostEditController = ReturnType<typeof usePostEditController>;
