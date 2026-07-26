import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DragEvent, useMemo, useState } from "react";
import {
  createChapter,
  deleteChapter,
  deleteManga,
  deleteTranslatorProfileRecord,
  getChapters,
  getMangaSeries,
  reorderChapters,
  updateChapter,
  type ChapterSummary,
} from "../api/jobs";
import { confirmDialog } from "../services/desktop_api";
import { useLanguageStore } from "../stores/language_store";

function moveChapterId(chapterIds: string[], draggedId: string, targetId: string) {
  if (draggedId === targetId) {
    return chapterIds;
  }
  const next = chapterIds.slice();
  const from = next.indexOf(draggedId);
  const to = next.indexOf(targetId);
  if (from < 0 || to < 0) {
    return chapterIds;
  }
  const [removed] = next.splice(from, 1);
  next.splice(to, 0, removed);
  return next;
}

export function MangaManagementPage() {
  const t = useLanguageStore((state) => state.t);
  const queryClient = useQueryClient();
  const [selectedMangaId, setSelectedMangaId] = useState("");
  const [selectedTranslatorId, setSelectedTranslatorId] = useState("");
  const [newChapterTitle, setNewChapterTitle] = useState("");
  const [draggedChapterId, setDraggedChapterId] = useState<string | null>(null);
  const [orderedChapterIds, setOrderedChapterIds] = useState<string[]>([]);
  const [status, setStatus] = useState(t("manga.status.ready"));

  const mangaQuery = useQuery({
    queryKey: ["mangaSeries"],
    queryFn: getMangaSeries,
  });
  const chaptersQuery = useQuery({
    queryKey: ["chapters", selectedMangaId, selectedTranslatorId],
    queryFn: () => getChapters(selectedMangaId, selectedTranslatorId),
    enabled: Boolean(selectedMangaId && selectedTranslatorId),
  });

  const selectedManga = useMemo(
    () => (mangaQuery.data?.series || []).find((entry) => entry.mangaId === selectedMangaId) || null,
    [mangaQuery.data, selectedMangaId]
  );
  const translatorOptions = selectedManga?.translators || [];
  const chapters = useMemo(
    () => (chaptersQuery.data?.chapters || []).slice().sort((left, right) => left.sortOrder - right.sortOrder),
    [chaptersQuery.data]
  );

  const effectiveOrderedChapterIds =
    orderedChapterIds.length > 0 ? orderedChapterIds : chapters.map((entry) => entry.chapterId);
  const chapterMap = useMemo(() => new Map(chapters.map((entry) => [entry.chapterId, entry])), [chapters]);
  const displayedChapters = effectiveOrderedChapterIds
    .map((chapterId) => chapterMap.get(chapterId))
    .filter((entry): entry is ChapterSummary => Boolean(entry));

  const createChapterMutation = useMutation({
    mutationFn: () => createChapter(selectedMangaId, selectedTranslatorId, { chapterTitle: newChapterTitle || null }),
    onSuccess: async () => {
      setStatus(t("manga.status.chapterCreated"));
      setNewChapterTitle("");
      setOrderedChapterIds([]);
      await queryClient.invalidateQueries({ queryKey: ["mangaSeries"] });
      await queryClient.invalidateQueries({ queryKey: ["chapters", selectedMangaId, selectedTranslatorId] });
    },
  });

  const reorderMutation = useMutation({
    mutationFn: () => reorderChapters(selectedMangaId, selectedTranslatorId, effectiveOrderedChapterIds),
    onSuccess: async () => {
      setStatus(t("manga.status.chapterOrderUpdated"));
      await queryClient.invalidateQueries({ queryKey: ["mangaSeries"] });
      await queryClient.invalidateQueries({ queryKey: ["chapters", selectedMangaId, selectedTranslatorId] });
    },
  });

  const deleteMangaMutation = useMutation({
    mutationFn: deleteManga,
    onSuccess: async ({ deleted, deletedReferences, deletedJobs }) => {
      setStatus(t("manga.status.mangaDeleted", { label: deleted.label, id: deleted.mangaId }));
      if (selectedMangaId === deleted.mangaId) {
        setSelectedMangaId("");
        setSelectedTranslatorId("");
        setOrderedChapterIds([]);
      }
      await queryClient.invalidateQueries({ queryKey: ["mangaSeries"] });
      await queryClient.invalidateQueries({ queryKey: ["referenceSets"] });
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      setStatus(
        `${t("manga.status.mangaDeleted", { label: deleted.label, id: deleted.mangaId })} ` +
        `${t("manga.status.cascadeDeleted", { references: deletedReferences.length, jobs: deletedJobs.length })}`
      );
    },
  });

  const deleteTranslatorMutation = useMutation({
    mutationFn: ({ mangaId, translatorId }: { mangaId: string; translatorId: string }) =>
      deleteTranslatorProfileRecord(mangaId, translatorId),
    onSuccess: async ({ deleted, deletedReferences, deletedJobs }) => {
      if (selectedMangaId === deleted.mangaId && selectedTranslatorId === deleted.translatorId) {
        setSelectedTranslatorId("");
        setOrderedChapterIds([]);
      }
      await queryClient.invalidateQueries({ queryKey: ["mangaSeries"] });
      await queryClient.invalidateQueries({ queryKey: ["chapters", deleted.mangaId, deleted.translatorId] });
      await queryClient.invalidateQueries({ queryKey: ["referenceSets"] });
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      setStatus(
        `${t("manga.status.translatorDeleted", { label: deleted.label, id: deleted.translatorId })} ` +
        `${t("manga.status.cascadeDeleted", { references: deletedReferences.length, jobs: deletedJobs.length })}`
      );
    },
  });

  const updateChapterMutation = useMutation({
    mutationFn: ({ chapterId, chapterTitle }: { chapterId: string; chapterTitle: string | null }) =>
      updateChapter(selectedMangaId, selectedTranslatorId, chapterId, { chapterTitle }),
    onSuccess: async () => {
      setStatus(t("manga.status.chapterTitleUpdated"));
      await queryClient.invalidateQueries({ queryKey: ["mangaSeries"] });
      await queryClient.invalidateQueries({ queryKey: ["chapters", selectedMangaId, selectedTranslatorId] });
    },
  });

  const deleteChapterMutation = useMutation({
    mutationFn: ({ chapterId }: { chapterId: string }) => deleteChapter(selectedMangaId, selectedTranslatorId, chapterId),
    onSuccess: async ({ deleted }) => {
      setStatus(t("manga.status.chapterDeleted", { id: deleted.chapterId }));
      setOrderedChapterIds([]);
      await queryClient.invalidateQueries({ queryKey: ["mangaSeries"] });
      await queryClient.invalidateQueries({ queryKey: ["chapters", selectedMangaId, selectedTranslatorId] });
    },
  });

  return (
    <section className="page">
      <h1>{t("manga.title")}</h1>
      <p>{status}</p>
      <div className="card-stack">
        <article className="card">
          <h2>{t("manga.list.title")}</h2>
          {mangaQuery.isLoading ? <p>{t("manga.list.loading")}</p> : null}
          {!mangaQuery.isLoading ? (
            <ul className="artifact-list">
              {(mangaQuery.data?.series || []).map((series) => (
                <li key={series.mangaId} className="artifact-item">
                  <div>
                    <strong>{series.label}</strong>
                    <div className="job-subtext">{series.mangaId}</div>
                    <div className="job-subtext">
                      {t("manga.list.translatorProfiles", {
                        language: series.language,
                        count: series.translators.length,
                      })}
                    </div>
                  </div>
                  <div className="job-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => {
                        setSelectedMangaId(series.mangaId);
                        setSelectedTranslatorId("");
                        setOrderedChapterIds([]);
                      }}
                    >
                      {t("manga.list.select")}
                    </button>
                    <button
                      className="secondary-button danger-button"
                      type="button"
                      disabled={deleteMangaMutation.isPending}
                      onClick={async () => {
                        const result = await confirmDialog({
                          title: t("manga.dialog.deleteManga.title"),
                          message: t("manga.dialog.deleteManga.message", {
                            label: series.label,
                            id: series.mangaId,
                          }),
                          detail: t("manga.dialog.deleteManga.detail"),
                          confirmLabel: t("manga.dialog.confirmDelete"),
                          cancelLabel: t("manga.dialog.cancel"),
                        });
                        if (!result.confirmed) {
                          return;
                        }
                        deleteMangaMutation.mutate(series.mangaId);
                      }}
                    >
                      {t("manga.list.delete")}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </article>

        <article className="card">
          <h2>{t("manga.translatorList.title")}</h2>
          {!selectedManga ? <p>{t("manga.translatorList.empty")}</p> : null}
          {selectedManga ? (
            <ul className="artifact-list">
              {translatorOptions.map((translator) => (
                <li key={translator.translatorId} className="artifact-item">
                  <div>
                    <strong>{translator.label}</strong>
                    <div className="job-subtext">{translator.translatorId}</div>
                    <div className="job-subtext">
                      {t("manga.translatorList.chapters", {
                        language: translator.language,
                        count: translator.chapterCount,
                      })}
                    </div>
                  </div>
                  <div className="job-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => {
                        setSelectedTranslatorId(translator.translatorId);
                        setOrderedChapterIds([]);
                      }}
                    >
                      {t("manga.list.select")}
                    </button>
                    <button
                      className="secondary-button danger-button"
                      type="button"
                      disabled={deleteTranslatorMutation.isPending}
                      onClick={async () => {
                        const result = await confirmDialog({
                          title: t("manga.dialog.deleteTranslator.title"),
                          message: t("manga.dialog.deleteTranslator.message", {
                            label: translator.label,
                            id: translator.translatorId,
                          }),
                          detail: t("manga.dialog.deleteTranslator.detail"),
                          confirmLabel: t("manga.dialog.confirmDelete"),
                          cancelLabel: t("manga.dialog.cancel"),
                        });
                        if (!result.confirmed) {
                          return;
                        }
                        deleteTranslatorMutation.mutate({
                          mangaId: selectedManga.mangaId,
                          translatorId: translator.translatorId,
                        });
                      }}
                    >
                      {t("manga.list.delete")}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </article>

        <article className="card">
          <h2>{t("manga.chapterManagement.title")}</h2>
          <div className="form-grid">
            <label>
              <span>{t("manga.chapterManagement.manga")}</span>
              <select
                value={selectedMangaId}
                onChange={(event) => {
                  setSelectedMangaId(event.currentTarget.value);
                  setSelectedTranslatorId("");
                  setOrderedChapterIds([]);
                }}
              >
                <option value="">{t("manga.chapterManagement.selectManga")}</option>
                {(mangaQuery.data?.series || []).map((series) => (
                  <option key={series.mangaId} value={series.mangaId}>
                    {series.label} ({series.mangaId})
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t("manga.chapterManagement.translator")}</span>
              <select
                value={selectedTranslatorId}
                onChange={(event) => {
                  setSelectedTranslatorId(event.currentTarget.value);
                  setOrderedChapterIds([]);
                }}
                disabled={!selectedMangaId}
              >
                <option value="">
                  {selectedMangaId
                    ? t("manga.chapterManagement.selectTranslator")
                    : t("manga.chapterManagement.chooseMangaFirst")}
                </option>
                {translatorOptions.map((translator) => (
                  <option key={translator.translatorId} value={translator.translatorId}>
                    {translator.label} ({translator.translatorId})
                  </option>
                ))}
              </select>
            </label>
          </div>
        </article>

        <article className="card">
          <h2>{t("manga.addChapter.title")}</h2>
          <div className="inline-field-row">
            <input
              placeholder={t("manga.addChapter.placeholder")}
              value={newChapterTitle}
              onChange={(event) => setNewChapterTitle(event.currentTarget.value)}
            />
            <button
              className="primary-button"
              type="button"
              disabled={
                !selectedMangaId ||
                !selectedTranslatorId ||
                !newChapterTitle.trim() ||
                createChapterMutation.isPending
              }
              onClick={() => createChapterMutation.mutate()}
            >
              {t("manga.addChapter.create")}
            </button>
          </div>
        </article>

        <article className="card">
          <h2>{t("manga.order.title")}</h2>
          {!selectedMangaId || !selectedTranslatorId ? <p>{t("manga.order.emptySelection")}</p> : null}
          {chaptersQuery.isLoading ? <p>{t("manga.order.loading")}</p> : null}
          {displayedChapters.length > 0 ? (
            <>
              <ul className="preflight-image-list">
                {displayedChapters.map((chapter, index) => (
                  <li
                    key={chapter.chapterId}
                    className={
                      draggedChapterId === chapter.chapterId
                        ? "preflight-image-card dragging"
                        : "preflight-image-card"
                    }
                    draggable
                    onDragStart={() => setDraggedChapterId(chapter.chapterId)}
                    onDragOver={(event: DragEvent<HTMLLIElement>) => {
                      event.preventDefault();
                      if (!draggedChapterId || draggedChapterId === chapter.chapterId) {
                        return;
                      }
                      setOrderedChapterIds((current) =>
                        moveChapterId(
                          current.length > 0 ? current : chapters.map((entry) => entry.chapterId),
                          draggedChapterId,
                          chapter.chapterId
                        )
                      );
                    }}
                    onDrop={() => setDraggedChapterId(null)}
                    onDragEnd={() => setDraggedChapterId(null)}
                  >
                    <div className="preflight-image-order">{index + 1}</div>
                    <div className="preflight-image-meta">
                      <strong>{chapter.chapterTitle || chapter.chapterId}</strong>
                      <span>{chapter.chapterId}</span>
                    </div>
                    <div className="job-actions">
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => {
                          const nextTitle = window.prompt(
                            t("manga.prompt.chapterTitle"),
                            chapter.chapterTitle || ""
                          );
                          if (nextTitle == null) {
                            return;
                          }
                          updateChapterMutation.mutate({
                            chapterId: chapter.chapterId,
                            chapterTitle: nextTitle.trim() || null,
                          });
                        }}
                      >
                        {t("manga.order.editTitle")}
                      </button>
                      <button
                        className="secondary-button danger-button"
                        type="button"
                        disabled={deleteChapterMutation.isPending}
                        onClick={async () => {
                          const result = await confirmDialog({
                            title: t("manga.dialog.deleteChapter.title"),
                            message: t("manga.dialog.deleteChapter.message", {
                              label: chapter.chapterTitle || chapter.chapterId,
                            }),
                            detail: t("manga.dialog.deleteChapter.detail"),
                            confirmLabel: t("manga.dialog.confirmDelete"),
                            cancelLabel: t("manga.dialog.cancel"),
                          });
                          if (!result.confirmed) {
                            return;
                          }
                          deleteChapterMutation.mutate({
                            chapterId: chapter.chapterId,
                          });
                        }}
                      >
                        {t("manga.list.delete")}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="button-row">
                <button
                  className="primary-button"
                  type="button"
                  disabled={
                    !selectedMangaId ||
                    !selectedTranslatorId ||
                    reorderMutation.isPending ||
                    effectiveOrderedChapterIds.join("|") === chapters.map((entry) => entry.chapterId).join("|")
                  }
                  onClick={() => reorderMutation.mutate()}
                >
                  {t("manga.order.save")}
                </button>
              </div>
            </>
          ) : selectedMangaId && selectedTranslatorId && !chaptersQuery.isLoading ? (
            <p>{t("manga.order.none")}</p>
          ) : null}
        </article>
      </div>
    </section>
  );
}
