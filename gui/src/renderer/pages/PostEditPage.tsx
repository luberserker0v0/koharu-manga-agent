import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DragEvent, useEffect, useMemo, useState } from "react";
import {
  createChapter,
  createPostEditExportJob,
  createPostEditReferenceSet,
  createTranslatorProfile,
  getEditedScene,
  getJobs,
  getMangaSeries,
  getSourcePreflight,
  saveEditedScene,
  type ChapterSummary,
  type EditedSceneDocument,
  type GuiJob,
  type MangaSeriesSummary,
} from "../api/jobs";
import { readSettings, validatePaths } from "../services/desktop_api";
import { useLanguageStore } from "../stores/language_store";
import { useUiStore } from "../stores/ui_store";
import type { SourcePreflightImage } from "../types/settings";
import type { GuiSettings } from "../types/settings";

function moveId(ids: string[], draggedId: string, targetId: string) {
  if (draggedId === targetId) {
    return ids;
  }
  const next = ids.slice();
  const from = next.indexOf(draggedId);
  const to = next.indexOf(targetId);
  if (from < 0 || to < 0) {
    return ids;
  }
  const [removed] = next.splice(from, 1);
  next.splice(to, 0, removed);
  return next;
}

function cloneEditedScene(scene: EditedSceneDocument): EditedSceneDocument {
  return JSON.parse(JSON.stringify(scene));
}

function isCompletedTranslationJob(job: GuiJob) {
  return ["translation", "translation_quality_repair"].includes(job.type) &&
    ["succeeded", "waiting_user_review"].includes(job.status);
}

function hasPostEditDocument(job: GuiJob) {
  return job.artifacts.some(
    (artifact) => artifact.kind === "post_edit_document" || artifact.kind === "edited_scene"
  );
}

function isSupersededTranslation(job: GuiJob) {
  if (!job.result || typeof job.result !== "object") {
    return false;
  }
  const publication = (job.result as { publication?: { status?: string } }).publication;
  return publication?.status === "superseded";
}

function resolvePagePreviewPath(
  orderedImages: SourcePreflightImage[],
  pageName: string | null | undefined,
  pageIndex: number
) {
  if (pageName) {
    const byName = orderedImages.find(
      (image) =>
        image.fileName === pageName ||
        image.orderedName === pageName ||
        image.normalizedPath.endsWith(`\\${pageName}`) ||
        image.previewPath.endsWith(`\\${pageName}`)
    );
    if (byName) {
      return byName.previewPath;
    }
  }

  return orderedImages[pageIndex]?.previewPath || null;
}

function resolveJobMangaLabel(job: GuiJob | null) {
  return typeof job?.payload.mangaLabel === "string" && job.payload.mangaLabel
    ? job.payload.mangaLabel
    : "Untitled manga";
}

function resolveJobChapterTitle(job: GuiJob | null) {
  return typeof job?.payload.chapterTitle === "string" && job.payload.chapterTitle ? job.payload.chapterTitle : "";
}

function resolveJobTranslatorLabel(job: GuiJob | null) {
  return typeof job?.payload.translatorLabel === "string" && job.payload.translatorLabel
    ? job.payload.translatorLabel
    : typeof job?.payload.translator === "string" && job.payload.translator
      ? job.payload.translator
      : "";
}

export function PostEditPage() {
  const t = useLanguageStore((state) => state.t);
  const queryClient = useQueryClient();
  const selectedJobId = useUiStore((state) => state.selectedJobId);
  const setSelectedJobId = useUiStore((state) => state.setSelectedJobId);
  const setSelectedPage = useUiStore((state) => state.setSelectedPage);
  const [draft, setDraft] = useState<EditedSceneDocument | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string>("");
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [draggedPageId, setDraggedPageId] = useState<string | null>(null);
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const [status, setStatus] = useState(t("postEdit.status.ready"));
  const [settingsSnapshot, setSettingsSnapshot] = useState<GuiSettings | null>(null);
  const [seededJobId, setSeededJobId] = useState<string | null>(null);
  const [branchTranslatorLabel, setBranchTranslatorLabel] = useState("");
  const [branchChapterTitle, setBranchChapterTitle] = useState("");
  const [branchReferenceLabel, setBranchReferenceLabel] = useState("");

  const jobsQuery = useQuery({
    queryKey: ["jobs"],
    queryFn: getJobs,
  });
  const mangaQuery = useQuery({
    queryKey: ["manga-series"],
    queryFn: getMangaSeries,
  });

  const translationJobs = useMemo(
    () => (jobsQuery.data?.jobs || []).filter((job) =>
      isCompletedTranslationJob(job) && hasPostEditDocument(job) && !isSupersededTranslation(job)
    ),
    [jobsQuery.data]
  );

  const editedSceneQuery = useQuery({
    queryKey: ["edited-scene", selectedJobId],
    queryFn: () => getEditedScene(selectedJobId as string),
    enabled: Boolean(selectedJobId),
  });

  const selectedTranslationJob = useMemo(
    () => translationJobs.find((job) => job.id === selectedJobId) || null,
    [selectedJobId, translationJobs]
  );

  const sourcePreflightId =
    draft?.sourcePreflightId ||
    (selectedTranslationJob && typeof selectedTranslationJob.payload.sourcePreflightId === "string"
      ? selectedTranslationJob.payload.sourcePreflightId
      : null);

  const sourcePreflightQuery = useQuery({
    queryKey: ["source-preflight", sourcePreflightId],
    queryFn: () => getSourcePreflight(sourcePreflightId as string),
    enabled: Boolean(sourcePreflightId),
  });

  const selectedManga = useMemo<MangaSeriesSummary | null>(() => {
    if (!draft?.mangaId) {
      return null;
    }
    return (mangaQuery.data?.series || []).find((entry) => entry.mangaId === draft.mangaId) || null;
  }, [draft?.mangaId, mangaQuery.data]);

  const sourceTranslator = useMemo(() => {
    if (!draft?.translatorId || !selectedManga) {
      return null;
    }
    return selectedManga.translators.find((entry) => entry.translatorId === draft.translatorId) || null;
  }, [draft?.translatorId, selectedManga]);

  const sourceChapter = useMemo<ChapterSummary | null>(() => {
    if (!draft?.chapterId || !sourceTranslator) {
      return null;
    }
    return sourceTranslator.chapters.find((entry) => entry.chapterId === draft.chapterId) || null;
  }, [draft?.chapterId, sourceTranslator]);

  useEffect(() => {
    readSettings()
      .then((settings) => {
        setSettingsSnapshot(settings);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedJobId && translationJobs[0]) {
      setSelectedJobId(translationJobs[0].id);
      return;
    }
    if (selectedJobId && !translationJobs.some((job) => job.id === selectedJobId)) {
      setSelectedJobId(translationJobs[0]?.id || null);
    }
  }, [selectedJobId, setSelectedJobId, translationJobs]);

  useEffect(() => {
    if (!editedSceneQuery.data?.exists || !editedSceneQuery.data.editedScene) {
      setDraft(null);
      setSelectedPageId("");
      setSelectedNodeId("");
      return;
    }

    const nextDraft = cloneEditedScene(editedSceneQuery.data.editedScene);
    setDraft(nextDraft);
    const firstPageId = nextDraft.pageOrder[0] || "";
    setSelectedPageId(firstPageId);
    const firstNodeId = firstPageId ? nextDraft.pages[firstPageId]?.nodeOrder[0] || "" : "";
    setSelectedNodeId(firstNodeId);
  }, [editedSceneQuery.data]);

  useEffect(() => {
    if (!selectedTranslationJob || seededJobId === selectedTranslationJob.id) {
      return;
    }

    const nextTranslatorLabel = resolveJobTranslatorLabel(selectedTranslationJob)
      ? `${resolveJobTranslatorLabel(selectedTranslationJob)}（修訂版）`
      : "";
    const nextChapterTitle = resolveJobChapterTitle(selectedTranslationJob);
    const nextReferenceLabel = [resolveJobMangaLabel(selectedTranslationJob), nextTranslatorLabel, nextChapterTitle]
      .filter(Boolean)
      .join(" / ");

    setBranchTranslatorLabel(nextTranslatorLabel);
    setBranchChapterTitle(nextChapterTitle);
    setBranchReferenceLabel(nextReferenceLabel);
    setSeededJobId(selectedTranslationJob.id);
  }, [seededJobId, selectedTranslationJob]);

  const saveMutation = useMutation({
    mutationFn: (payload: EditedSceneDocument) => saveEditedScene(payload.jobId, payload),
    onSuccess: async (result) => {
      setDraft(cloneEditedScene(result.editedScene));
      setStatus(t("postEdit.status.saved"));
      await queryClient.invalidateQueries({ queryKey: ["edited-scene", result.editedScene.jobId] });
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const exportMutation = useMutation({
    mutationFn: ({ jobId, outputDir }: { jobId: string; outputDir: string }) =>
      createPostEditExportJob({ sourceJobId: jobId, outputDir }),
    onSuccess: async (job) => {
      setStatus(t("postEdit.status.exportCreated"));
      setSelectedJobId(job.id);
      setSelectedPage("job-list");
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const branchMutation = useMutation({
    mutationFn: async () => {
      if (!draft) {
        throw new Error("目前沒有可另存的編修文件。");
      }
      if (!draft.jobId) {
        throw new Error("編修文件缺少 jobId。");
      }
      if (!draft.mangaId) {
        throw new Error("這份編修文件沒有綁定漫畫，無法建立新譯者。");
      }

      const translatorLabel = branchTranslatorLabel.trim();
      if (!translatorLabel) {
        throw new Error("請先輸入新譯者名稱。");
      }

      const chapterTitle = branchChapterTitle.trim() || sourceChapter?.chapterTitle || "未命名章節";
      const referenceLabel =
        branchReferenceLabel.trim() ||
        [selectedManga?.label || draft.mangaId, translatorLabel, chapterTitle].filter(Boolean).join(" / ");

      const saved = await saveMutation.mutateAsync(draft);
      const createdTranslator = await createTranslatorProfile(draft.mangaId, {
        label: translatorLabel,
        language: selectedManga?.language || "zh-TW",
      });
      const createdChapter = await createChapter(draft.mangaId, createdTranslator.translator.translatorId, {
        chapterTitle,
      });
      const createdReference = await createPostEditReferenceSet(saved.editedScene.jobId, {
        label: referenceLabel,
        language: selectedManga?.language || "zh-TW",
        referenceKind: "translator",
        mangaId: draft.mangaId,
        mangaLabel: selectedManga?.label || draft.mangaId,
        translatorId: createdTranslator.translator.translatorId,
        translatorLabel: createdTranslator.translator.label,
        chapterId: createdChapter.chapter.chapterId,
        chapterTitle: createdChapter.chapter.chapterTitle || chapterTitle,
      });

      return {
        translator: createdTranslator.translator,
        chapter: createdChapter.chapter,
        referenceSet: createdReference.referenceSet,
      };
    },
    onSuccess: async (result) => {
      setStatus(
        `已建立新譯者「${result.translator.label}」與章節「${
          result.chapter.chapterTitle || result.chapter.chapterId
        }」，並產生可供 Ingestion 使用的 reference。`
      );
      await queryClient.invalidateQueries({ queryKey: ["manga-series"] });
      await queryClient.invalidateQueries({ queryKey: ["reference-sets"] });
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error) => {
      setStatus(error instanceof Error ? error.message : "另存為新譯者失敗。");
    },
  });

  const selectedPage = draft && selectedPageId ? draft.pages[selectedPageId] : null;
  const selectedPageIndex = draft && selectedPageId ? draft.pageOrder.indexOf(selectedPageId) : -1;
  const selectedPagePreviewPath = useMemo(() => {
    if (!selectedPage || selectedPageIndex < 0) {
      return null;
    }
    return resolvePagePreviewPath(
      sourcePreflightQuery.data?.images || [],
      selectedPage.pageName,
      selectedPageIndex
    );
  }, [selectedPage, selectedPageIndex, sourcePreflightQuery.data?.images]);

  const selectedNode = selectedPage && selectedNodeId ? selectedPage.nodes[selectedNodeId] || null : null;

  return (
    <section className="page">
      <h1>{t("postEdit.title")}</h1>
      <p>{status}</p>
      <div className="card-stack">
        <article className="card">
          <h2>{t("postEdit.selection.title")}</h2>
          {translationJobs.length === 0 ? <p>{t("postEdit.selection.empty")}</p> : null}
          <div className="inline-field-row">
            <select
              value={selectedJobId || ""}
              disabled={translationJobs.length === 0}
              onChange={(event) => setSelectedJobId(event.currentTarget.value || null)}
            >
              <option value="">{t("postEdit.selection.placeholder")}</option>
              {translationJobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {resolveJobMangaLabel(job)} / {resolveJobChapterTitle(job) || job.id}
                </option>
              ))}
            </select>
            <button className="secondary-button" type="button" onClick={() => setSelectedPage("job-list")}>
              {t("postEdit.selection.openJobList")}
            </button>
          </div>
        </article>

        <article className="card">
          <h2>{t("postEdit.pageOrder.title")}</h2>
          {!draft ? <p>{t("postEdit.pageOrder.empty")}</p> : null}
          {draft ? (
            <ul className="post-edit-page-list">
              {draft.pageOrder.map((pageId, index) => {
                const page = draft.pages[pageId];
                const previewPath = resolvePagePreviewPath(
                  sourcePreflightQuery.data?.images || [],
                  page.pageName,
                  index
                );
                return (
                  <li
                    key={pageId}
                    className={draggedPageId === pageId ? "post-edit-page-card dragging" : "post-edit-page-card"}
                    draggable
                    onClick={() => {
                      setSelectedPageId(pageId);
                      setSelectedNodeId(page.nodeOrder[0] || "");
                    }}
                    onDragStart={() => setDraggedPageId(pageId)}
                    onDragOver={(event: DragEvent<HTMLLIElement>) => {
                      event.preventDefault();
                      if (!draggedPageId || draggedPageId === pageId || !draft) {
                        return;
                      }
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              pageOrder: moveId(current.pageOrder, draggedPageId, pageId),
                            }
                          : current
                      );
                    }}
                    onDrop={() => setDraggedPageId(null)}
                    onDragEnd={() => setDraggedPageId(null)}
                  >
                    <div className="post-edit-page-thumb">
                      {previewPath ? <img alt={page.pageName} src={previewPath} /> : <span>{t("postEdit.nodeOrder.noPreview")}</span>}
                    </div>
                    <div className="post-edit-page-info">
                      <div className="preflight-image-order">{index + 1}</div>
                      <div className="preflight-image-meta">
                        <strong>{page.pageName}</strong>
                        <span>{pageId}</span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </article>

        <article className="card">
          <h2>{t("postEdit.nodeOrder.title")}</h2>
          {!selectedPage ? <p>{t("postEdit.nodeOrder.empty")}</p> : null}
          {selectedPage ? (
            <div className="post-edit-node-layout">
              <div className="post-edit-node-preview">
                {selectedPagePreviewPath ? (
                  <img alt={selectedPage.pageName} src={selectedPagePreviewPath} />
                ) : (
                  <div className="post-edit-node-preview-empty">{t("postEdit.nodeOrder.noPreview")}</div>
                )}
              </div>
              <div className="post-edit-node-list">
                {selectedPage.nodeOrder.map((nodeId, index) => {
                  const node = selectedPage.nodes[nodeId];
                  return (
                    <button
                      key={nodeId}
                      className={
                        draggedNodeId === nodeId
                          ? "post-edit-node-card dragging"
                          : selectedNodeId === nodeId
                            ? "post-edit-node-card selected"
                            : "post-edit-node-card"
                      }
                      draggable
                      onClick={() => setSelectedNodeId(nodeId)}
                      onDragStart={() => setDraggedNodeId(nodeId)}
                      onDragOver={(event: DragEvent<HTMLButtonElement>) => {
                        event.preventDefault();
                        if (!draggedNodeId || draggedNodeId === nodeId || !draft || !selectedPageId) {
                          return;
                        }
                        setDraft((current) => {
                          if (!current) {
                            return current;
                          }
                          const page = current.pages[selectedPageId];
                          return {
                            ...current,
                            pages: {
                              ...current.pages,
                              [selectedPageId]: {
                                ...page,
                                nodeOrder: moveId(page.nodeOrder, draggedNodeId, nodeId),
                              },
                            },
                          };
                        });
                      }}
                      onDrop={() => setDraggedNodeId(null)}
                      onDragEnd={() => setDraggedNodeId(null)}
                      type="button"
                    >
                      <div className="preflight-image-order">{index + 1}</div>
                      <div className="post-edit-node-copy">
                        <strong>{node.originalText.slice(0, 48) || nodeId}</strong>
                        <span>{node.editedTranslation.slice(0, 72) || t("postEdit.nodeOrder.emptyTranslation")}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </article>

        <article className="card">
          <h2>{t("postEdit.editor.title")}</h2>
          {!selectedNode ? <p>{t("postEdit.editor.empty")}</p> : null}
          {selectedNode ? (
            <div className="card-stack">
              <div className="form-grid">
                <label>
                  <span>{t("postEdit.editor.originalText")}</span>
                  <textarea value={selectedNode.originalText} readOnly rows={3} />
                </label>
                <label>
                  <span>{t("postEdit.editor.translation")}</span>
                  <textarea
                    value={selectedNode.editedTranslation}
                    rows={4}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setDraft((current) => {
                        if (!current || !selectedPageId || !selectedNodeId) {
                          return current;
                        }
                        return {
                          ...current,
                          pages: {
                            ...current.pages,
                            [selectedPageId]: {
                              ...current.pages[selectedPageId],
                              nodes: {
                                ...current.pages[selectedPageId].nodes,
                                [selectedNodeId]: {
                                  ...current.pages[selectedPageId].nodes[selectedNodeId],
                                  editedTranslation: value,
                                },
                              },
                            },
                          },
                        };
                      });
                    }}
                  />
                </label>
              </div>

              <div className="button-row">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!draft || !selectedPageId || !selectedNodeId}
                  onClick={() => {
                    setDraft((current) => {
                      if (!current || !selectedPageId || !selectedNodeId) {
                        return current;
                      }
                      return {
                        ...current,
                        pages: {
                          ...current.pages,
                          [selectedPageId]: {
                            ...current.pages[selectedPageId],
                            nodes: {
                              ...current.pages[selectedPageId].nodes,
                              [selectedNodeId]: {
                                ...current.pages[selectedPageId].nodes[selectedNodeId],
                                editedTranslation:
                                  current.pages[selectedPageId].nodes[selectedNodeId].originalTranslation || "",
                              },
                            },
                          },
                        },
                      };
                    });
                    setStatus(t("postEdit.status.reset"));
                  }}
                >
                  {t("postEdit.button.reset")}
                </button>

                <button
                  className="primary-button"
                  type="button"
                  disabled={!draft || saveMutation.isPending}
                  onClick={() => draft && saveMutation.mutate(draft)}
                >
                  {t("postEdit.button.save")}
                </button>

                <button
                  className="secondary-button"
                  type="button"
                  disabled={!draft || branchMutation.isPending || saveMutation.isPending}
                  onClick={() => void branchMutation.mutateAsync()}
                >
                  另存為新譯者
                </button>

                <button
                  className="primary-button"
                  type="button"
                  disabled={!draft || exportMutation.isPending}
                  onClick={async () => {
                    if (!draft) {
                      return;
                    }
                    const currentSettings = settingsSnapshot || (await readSettings());
                    setSettingsSnapshot(currentSettings);
                    const outputDir = currentSettings.outputFolder.trim();
                    if (!outputDir) {
                      setStatus("請先到 Settings 設定匯出資料夾。");
                      return;
                    }
                    const validation = await validatePaths({
                      sourceFolder: "",
                      outputFolder: outputDir,
                      referenceFolder: currentSettings.referenceFolder,
                      sourceRequired: false,
                    });
                    if (!validation.outputFolder.ok) {
                      setStatus(`匯出資料夾不可用：${validation.outputFolder.reason}`);
                      return;
                    }
                    const saved = await saveMutation.mutateAsync(draft);
                    setDraft(cloneEditedScene(saved.editedScene));
                    exportMutation.mutate({ jobId: saved.editedScene.jobId, outputDir });
                  }}
                >
                  {t("postEdit.button.export")}
                </button>
              </div>

              <div className="form-grid">
                <label>
                  <span>新譯者名稱</span>
                  <input
                    type="text"
                    value={branchTranslatorLabel}
                    onChange={(event) => setBranchTranslatorLabel(event.currentTarget.value)}
                    placeholder="例如：故意做壞版"
                  />
                </label>
                <label>
                  <span>章節名稱</span>
                  <input
                    type="text"
                    value={branchChapterTitle}
                    onChange={(event) => setBranchChapterTitle(event.currentTarget.value)}
                    placeholder="沿用目前章節名稱"
                  />
                </label>
                <label>
                  <span>Reference 名稱</span>
                  <input
                    type="text"
                    value={branchReferenceLabel}
                    onChange={(event) => setBranchReferenceLabel(event.currentTarget.value)}
                    placeholder="顯示在 Reference 頁面的名稱"
                  />
                </label>
              </div>

              <p className="job-subtext">
                另存為新譯者會保留目前編修內容，建立新的譯者與章節綁定，並直接產生可供 Reference Ingestion 使用的譯者
                reference。
              </p>
            </div>
          ) : null}
        </article>
      </div>
    </section>
  );
}
