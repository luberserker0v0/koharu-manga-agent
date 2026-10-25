import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  createChapter, deleteChapter, deleteManga, deleteTranslatorProfileRecord, getChapters,
  getMangaSeries, reorderChapters, updateChapter, type ChapterSummary,
} from "../../../api/jobs";
import { confirmDialog } from "../../../services/desktop_api";
import { useLanguageStore } from "../../../stores/language_store";

export type Translate = (key: string, params?: Record<string, string | number>) => string;

export function moveChapterId(chapterIds: string[], draggedId: string, targetId: string) {
  if (draggedId === targetId) return chapterIds;
  const next = chapterIds.slice();
  const from = next.indexOf(draggedId);
  const to = next.indexOf(targetId);
  if (from < 0 || to < 0) return chapterIds;
  const [removed] = next.splice(from, 1);
  next.splice(to, 0, removed);
  return next;
}

function useMangaState(t: Translate) {
  const [selectedMangaId, setSelectedMangaId] = useState("");
  const [selectedTranslatorId, setSelectedTranslatorId] = useState("");
  const [newChapterTitle, setNewChapterTitle] = useState("");
  const [draggedChapterId, setDraggedChapterId] = useState<string | null>(null);
  const [orderedChapterIds, setOrderedChapterIds] = useState<string[]>([]);
  const [status, setStatus] = useState(t("manga.status.ready"));
  return { selectedMangaId, setSelectedMangaId, selectedTranslatorId, setSelectedTranslatorId,
    newChapterTitle, setNewChapterTitle, draggedChapterId, setDraggedChapterId,
    orderedChapterIds, setOrderedChapterIds, status, setStatus };
}

type MangaState = ReturnType<typeof useMangaState>;

function useMangaQueries(state: MangaState) {
  const mangaQuery = useQuery({ queryKey: ["mangaSeries"], queryFn: getMangaSeries });
  const chaptersQuery = useQuery({ queryKey: ["chapters", state.selectedMangaId, state.selectedTranslatorId],
    queryFn: () => getChapters(state.selectedMangaId, state.selectedTranslatorId),
    enabled: Boolean(state.selectedMangaId && state.selectedTranslatorId) });
  return { mangaQuery, chaptersQuery };
}

function useMangaDerived(state: MangaState, queries: ReturnType<typeof useMangaQueries>) {
  const selectedManga = useMemo(() => (queries.mangaQuery.data?.series || [])
    .find((entry) => entry.mangaId === state.selectedMangaId) || null,
  [queries.mangaQuery.data, state.selectedMangaId]);
  const chapters = useMemo(() => (queries.chaptersQuery.data?.chapters || [])
    .slice().sort((left, right) => left.sortOrder - right.sortOrder), [queries.chaptersQuery.data]);
  const effectiveOrderedChapterIds = state.orderedChapterIds.length
    ? state.orderedChapterIds : chapters.map((entry) => entry.chapterId);
  const chapterMap = useMemo(() => new Map(chapters.map((entry) => [entry.chapterId, entry])), [chapters]);
  const displayedChapters = effectiveOrderedChapterIds.map((id) => chapterMap.get(id))
    .filter((entry): entry is ChapterSummary => Boolean(entry));
  return { selectedManga, translatorOptions: selectedManga?.translators || [], chapters,
    effectiveOrderedChapterIds, displayedChapters };
}

async function invalidateChapterData(queryClient: ReturnType<typeof useQueryClient>, state: MangaState) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["mangaSeries"] }),
    queryClient.invalidateQueries({ queryKey: ["chapters", state.selectedMangaId, state.selectedTranslatorId] }),
  ]);
}

async function handleChapterCreated(queryClient: ReturnType<typeof useQueryClient>, state: MangaState, t: Translate) {
  state.setStatus(t("manga.status.chapterCreated"));
  state.setNewChapterTitle("");
  state.setOrderedChapterIds([]);
  await invalidateChapterData(queryClient, state);
  await Promise.all([queryClient.invalidateQueries({ queryKey: ["translationMemoryInspection"] }),
    queryClient.invalidateQueries({ queryKey: ["jobs"] })]);
}

function useChapterMutations(state: MangaState, queryClient: ReturnType<typeof useQueryClient>, t: Translate,
  order: string[]) {
  const createChapterMutation = useMutation({ mutationFn: () => createChapter(state.selectedMangaId,
    state.selectedTranslatorId, { chapterTitle: state.newChapterTitle || null }),
    onSuccess: () => handleChapterCreated(queryClient, state, t) });
  const reorderMutation = useMutation({ mutationFn: () => reorderChapters(state.selectedMangaId,
    state.selectedTranslatorId, order), onSuccess: async () => {
    state.setStatus(t("manga.status.chapterOrderUpdated")); await invalidateChapterData(queryClient, state); } });
  const updateChapterMutation = useMutation({ mutationFn: ({ chapterId, chapterTitle }: {
    chapterId: string; chapterTitle: string | null }) => updateChapter(state.selectedMangaId,
    state.selectedTranslatorId, chapterId, { chapterTitle }), onSuccess: async () => {
    state.setStatus(t("manga.status.chapterTitleUpdated")); await invalidateChapterData(queryClient, state); } });
  const deleteChapterMutation = useMutation({ mutationFn: ({ chapterId }: { chapterId: string }) =>
    deleteChapter(state.selectedMangaId, state.selectedTranslatorId, chapterId), onSuccess: async ({ deleted }) => {
    state.setStatus(t("manga.status.chapterDeleted", { id: deleted.chapterId }));
    state.setOrderedChapterIds([]); await invalidateChapterData(queryClient, state); } });
  return { createChapterMutation, reorderMutation, updateChapterMutation, deleteChapterMutation };
}

async function invalidateDeletedRecords(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([queryClient.invalidateQueries({ queryKey: ["mangaSeries"] }),
    queryClient.invalidateQueries({ queryKey: ["referenceSets"] }),
    queryClient.invalidateQueries({ queryKey: ["jobs"] })]);
}

function useDeleteMutations(state: MangaState, queryClient: ReturnType<typeof useQueryClient>, t: Translate) {
  const deleteMangaMutation = useMutation({ mutationFn: deleteManga,
    onSuccess: async ({ deleted, deletedReferences, deletedJobs }) => {
      if (state.selectedMangaId === deleted.mangaId) {
        state.setSelectedMangaId(""); state.setSelectedTranslatorId(""); state.setOrderedChapterIds([]);
      }
      await invalidateDeletedRecords(queryClient);
      state.setStatus(`${t("manga.status.mangaDeleted", { label: deleted.label, id: deleted.mangaId })} ` +
        `${t("manga.status.cascadeDeleted", { references: deletedReferences.length, jobs: deletedJobs.length })}`);
    } });
  const deleteTranslatorMutation = useMutation({ mutationFn: ({ mangaId, translatorId }: {
    mangaId: string; translatorId: string }) => deleteTranslatorProfileRecord(mangaId, translatorId),
    onSuccess: async ({ deleted, deletedReferences, deletedJobs }) => {
      if (state.selectedMangaId === deleted.mangaId && state.selectedTranslatorId === deleted.translatorId) {
        state.setSelectedTranslatorId(""); state.setOrderedChapterIds([]);
      }
      await invalidateDeletedRecords(queryClient);
      state.setStatus(`${t("manga.status.translatorDeleted", { label: deleted.label, id: deleted.translatorId })} ` +
        `${t("manga.status.cascadeDeleted", { references: deletedReferences.length, jobs: deletedJobs.length })}`);
    } });
  return { deleteMangaMutation, deleteTranslatorMutation };
}

function confirmationOptions(t: Translate, type: "Manga" | "Translator" | "Chapter", label: string, id?: string) {
  const key = type.toLowerCase();
  return { title: t(`manga.dialog.delete${type}.title`),
    message: t(`manga.dialog.delete${type}.message`, id ? { label, id } : { label }),
    detail: t(`manga.dialog.delete${type}.detail`), confirmLabel: t("manga.dialog.confirmDelete"),
    cancelLabel: t("manga.dialog.cancel") };
}

function createConfirmations(model: { state: MangaState; derived: ReturnType<typeof useMangaDerived>;
  chapters: ReturnType<typeof useChapterMutations>; deletion: ReturnType<typeof useDeleteMutations>; t: Translate }) {
  const confirmDeleteManga = async (series: { mangaId: string; label: string }) => {
    const result = await confirmDialog(confirmationOptions(model.t, "Manga", series.label, series.mangaId));
    if (result.confirmed) model.deletion.deleteMangaMutation.mutate(series.mangaId);
  };
  const confirmDeleteTranslator = async (translator: { translatorId: string; label: string }) => {
    if (!model.derived.selectedManga) return;
    const result = await confirmDialog(confirmationOptions(model.t, "Translator", translator.label, translator.translatorId));
    if (result.confirmed) model.deletion.deleteTranslatorMutation.mutate({
      mangaId: model.derived.selectedManga.mangaId, translatorId: translator.translatorId });
  };
  const confirmDeleteChapter = async (chapter: { chapterId: string; chapterTitle: string | null }) => {
    const result = await confirmDialog(confirmationOptions(model.t, "Chapter", chapter.chapterTitle || chapter.chapterId));
    if (result.confirmed) model.chapters.deleteChapterMutation.mutate({ chapterId: chapter.chapterId });
  };
  return { confirmDeleteManga, confirmDeleteTranslator, confirmDeleteChapter };
}

export function useMangaManagementModel() {
  const t = useLanguageStore((current) => current.t);
  const queryClient = useQueryClient();
  const state = useMangaState(t);
  const queries = useMangaQueries(state);
  const derived = useMangaDerived(state, queries);
  const chapters = useChapterMutations(state, queryClient, t, derived.effectiveOrderedChapterIds);
  const deletion = useDeleteMutations(state, queryClient, t);
  const confirmations = createConfirmations({ state, derived, chapters, deletion, t });
  const selectManga = (id: string) => {
    state.setSelectedMangaId(id); state.setSelectedTranslatorId(""); state.setOrderedChapterIds([]);
  };
  const selectTranslator = (id: string) => {
    state.setSelectedTranslatorId(id); state.setOrderedChapterIds([]);
  };
  return { ...state, ...queries, ...derived, ...chapters, ...deletion, ...confirmations,
    selectManga, selectTranslator, t };
}

export type MangaManagementModel = ReturnType<typeof useMangaManagementModel>;
