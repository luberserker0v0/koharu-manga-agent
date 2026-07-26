import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DragEvent, useEffect, useMemo, useState } from "react";
import {
  createChapter,
  createManga,
  createTranslatorProfile,
  createSourcePreflight,
  createTranslationJob,
  getMangaSeries,
  inspectTranslationMemory,
  reorderSourcePreflight,
  type ChapterSummary,
  type GuiJob,
  type MangaSeriesSummary,
} from "../api/jobs";
import {
  ChapterSelector,
  CREATE_NEW_CHAPTER_VALUE,
  resolveSelectedChapter,
} from "../components/ChapterSelector";
import {
  resolveSelectedTranslatorProfile,
} from "../components/TranslatorProfileSelector";
import { CREATE_NEW_TRANSLATOR_VALUE } from "../components/TranslatorSelector";
import { ReferenceGlossaryStrategySelector } from "../components/ReferenceGlossaryStrategySelector";
import { pickDirectory, readSettings, validatePaths, writeSettings } from "../services/desktop_api";
import {
  type TranslationDraft,
  type TranslationMode,
  useJobsPageStore,
} from "../stores/jobs_store";
import { useLanguageStore } from "../stores/language_store";
import { useUiStore } from "../stores/ui_store";
import type {
  GuiSettings,
  PathValidationSummary,
  SourcePreflightImage,
  SourcePreflightResult,
} from "../types/settings";
import { buildLocalFileUrl } from "../features/shared/formatters/fileUrl";
import {
  DEFAULT_REFERENCE_LANGUAGE,
  normalizeReferenceLanguage,
  REFERENCE_LANGUAGE_OPTIONS,
} from "../constants/languages";

const CREATE_NEW_LEARNING_PROFILE_VALUE = "__create_new_learning_profile__";
const CREATE_NEW_MANGA_VALUE = "__create_new_manga__";

function sanitizeOptional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toSystemId(prefix: string, value: string): string | undefined {
  const normalized = value.trim().normalize("NFKC");
  if (!normalized) {
    return undefined;
  }
  const asciiSlug = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (asciiSlug) {
    return `${prefix}_${asciiSlug}`;
  }
  const codePointSlug = Array.from(normalized)
    .map((character) => character.codePointAt(0)?.toString(16) || "")
    .filter(Boolean)
    .join("_");
  return `${prefix}_${codePointSlug.slice(0, 48)}`;
}

function moveImageId(imageIds: string[], draggedId: string, targetId: string) {
  if (draggedId === targetId) {
    return imageIds;
  }
  const next = imageIds.slice();
  const from = next.indexOf(draggedId);
  const to = next.indexOf(targetId);
  if (from < 0 || to < 0) {
    return imageIds;
  }
  const [removed] = next.splice(from, 1);
  next.splice(to, 0, removed);
  return next;
}

function orderingFingerprint(imageIds: string[]) {
  return imageIds.join("|");
}

function translationDraftFingerprint(draft: TranslationDraft) {
  return JSON.stringify(draft);
}

type ResolvedTranslationContext = {
  mangaId: string;
  mangaLabel: string;
  translatorId: string;
  translatorLabel: string;
  referenceTranslatorId?: string;
  referenceTranslatorLabel?: string;
  chapterId: string | undefined;
  chapterTitle: string | undefined;
};

type TranslationModeDefinition = {
  value: TranslationMode;
  label: string;
  description: string;
  useReference: boolean;
  writeLocalStyle: boolean;
  consistencyCheck: "hidden" | "optional" | "required";
};

const TRANSLATION_MODE_DEFINITIONS: TranslationModeDefinition[] = [
  {
    value: "quick",
    label: "快速翻譯",
    description: "不使用 Reference 與在地風格記憶，直接進行翻譯。",
    useReference: false,
    writeLocalStyle: false,
    consistencyCheck: "hidden",
  },
  {
    value: "reference_style",
    label: "Reference 風格翻譯",
    description: "使用指定 Reference 提供的術語與風格線索進行翻譯。",
    useReference: true,
    writeLocalStyle: false,
    consistencyCheck: "optional",
  },
  {
    value: "local_style",
    label: "在地風格翻譯",
    description: "使用既有累積的在地風格與知識，進行一致化翻譯。",
    useReference: false,
    writeLocalStyle: true,
    consistencyCheck: "optional",
  },
  {
    value: "learning_style",
    label: "學習式翻譯",
    description: "同時使用 Reference 與在地風格，並持續累積新的翻譯知識。",
    useReference: true,
    writeLocalStyle: true,
    consistencyCheck: "required",
  },
];
function getTranslationModeDefinition(mode: TranslationMode) {
  return (
    TRANSLATION_MODE_DEFINITIONS.find((definition) => definition.value === mode) ||
    TRANSLATION_MODE_DEFINITIONS[0]
  );
}

function isConsistencyCheckEnabled(draft: TranslationDraft) {
  const definition = getTranslationModeDefinition(draft.translationMode);
  if (definition.consistencyCheck === "required") {
    return true;
  }
  if (definition.consistencyCheck === "hidden") {
    return false;
  }
  return draft.qualityCheck;
}

function buildTranslationModeStatus(draft: TranslationDraft) {
  const referenceLabel = draft.referenceLabel.trim() || "Reference";
  switch (draft.translationMode) {
    case "reference_style":
      return `使用 ${referenceLabel} 的術語與風格進行翻譯。`;
    case "local_style":
      return "使用既有在地風格與知識進行翻譯。";
    case "learning_style":
      return `使用 ${referenceLabel} 與在地風格進行學習式翻譯。`;
    case "quick":
    default:
      return "使用快速翻譯模式。";
  }
}

function resolveSelectedManga(selectedValue: string, series: MangaSeriesSummary[]) {
  return series.find((entry) => entry.mangaId === selectedValue) || null;
}

function resolveSelectedOutputTranslator(
  selectedManga: MangaSeriesSummary | null,
  selectedValue: string
) {
  return selectedManga?.translators.find((entry) => entry.translatorId === selectedValue) || null;
}
function buildTranslationStatusMessage(draft: TranslationDraft, referenceLabelOverride?: string) {
  const referenceLabel = referenceLabelOverride || draft.referenceLabel.trim() || "Reference";
  switch (draft.translationMode) {
    case "reference_style":
      return `使用 ${referenceLabel} 的術語與風格進行翻譯。`;
    case "local_style":
      return "使用既有在地風格與知識進行翻譯。";
    case "learning_style":
      return `使用 ${referenceLabel} 與在地風格進行學習式翻譯。`;
    case "quick":
    default:
      return "使用快速翻譯模式。";
  }
}
function buildTranslationChecklist({
  translationDraft,
  resolvedMangaLabel,
  resolvedTranslatorLabel,
  modeDefinition,
  settingsSnapshot,
  translationPathValidation,
  preflightResult,
}: {
  translationDraft: TranslationDraft;
  resolvedMangaLabel: string;
  resolvedTranslatorLabel: string;
  modeDefinition: TranslationModeDefinition;
  settingsSnapshot: GuiSettings | null;
  translationPathValidation: PathValidationSummary | null;
  preflightResult: SourcePreflightResult | null;
}) {
  const items: Array<{ label: string; done: boolean; detail: string }> = [];
  const sourceFolder = translationDraft.sourceFolder.trim();
  const mangaTitle = resolvedMangaLabel.trim();
  const translatorTitle = resolvedTranslatorLabel.trim();

  items.push({
    label: "翻譯模式",
    done: Boolean(modeDefinition.value),
    detail: modeDefinition.label,
  });
  items.push({
    label: "來源資料夾",
    done: Boolean(sourceFolder),
    detail: sourceFolder || "尚未選擇",
  });
  items.push({
    label: "作品 / 譯者",
    done: Boolean(mangaTitle && translatorTitle),
    detail: mangaTitle && translatorTitle ? `${mangaTitle} / ${translatorTitle}` : "尚未指定",
  });
  items.push({
    label: "輸出資料夾",
    done: Boolean(settingsSnapshot?.outputFolder.trim()) && Boolean(translationPathValidation?.outputFolder.ok),
    detail:
      translationPathValidation?.outputFolder.ok
        ? settingsSnapshot?.outputFolder || "可寫入"
        : translationPathValidation?.outputFolder.reason ||
          "尚未設定",
  });
  items.push({
    label: "來源檢查",
    done: Boolean(preflightResult?.ready),
    detail: preflightResult
      ? `${preflightResult.summary.acceptedCount} 張可用圖片`
      : "尚未執行",
  });

  return items;
}

function PreflightPreviewCard({
  image,
  index,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragging,
}: {
  image: SourcePreflightImage;
  index: number;
  onDragStart: (imageId: string) => void;
  onDragOver: (event: DragEvent<HTMLLIElement>) => void;
  onDrop: (targetId: string) => void;
  onDragEnd: () => void;
  isDragging: boolean;
}) {
  return (
    <li
      className={isDragging ? "preflight-image-card dragging" : "preflight-image-card"}
      draggable
      onDragStart={() => onDragStart(image.id)}
      onDragOver={onDragOver}
      onDrop={() => onDrop(image.id)}
      onDragEnd={onDragEnd}
    >
      <div className="preflight-image-order">{index + 1}</div>
      <img
        alt={image.fileName}
        className="preflight-image-thumb"
        draggable={false}
        onDragStart={(event) => event.preventDefault()}
        src={buildLocalFileUrl(image.previewPath)}
      />
      <div className="preflight-image-meta">
        <strong>{image.fileName}</strong>
        <span>{image.actualFormat}</span>
        <span>{image.converted ? "Converted to supported format" : "Used as-is"}</span>
      </div>
    </li>
  );
}

export function JobsPage() {
  const t = useLanguageStore((state) => state.t);
  const queryClient = useQueryClient();
  const mangaSeriesQuery = useQuery({
    queryKey: ["mangaSeries"],
    queryFn: getMangaSeries,
    refetchOnMount: "always",
  });
  const translationDraft = useJobsPageStore((state) => state.translationDraft);
  const setTranslationDraft = useJobsPageStore((state) => state.setTranslationDraft);
  const translationPathValidation = useJobsPageStore((state) => state.translationPathValidation);
  const setTranslationPathValidation = useJobsPageStore((state) => state.setTranslationPathValidation);
  const preflightResult = useJobsPageStore((state) => state.preflightResult);
  const setPreflightResult = useJobsPageStore((state) => state.setPreflightResult);
  const orderedImageIds = useJobsPageStore((state) => state.orderedImageIds);
  const setOrderedImageIds = useJobsPageStore((state) => state.setOrderedImageIds);
  const status = useJobsPageStore((state) => state.status);
  const setStatus = useJobsPageStore((state) => state.setStatus);
  const lastPickedSourceFolder = useJobsPageStore((state) => state.lastPickedSourceFolder);
  const setLastPickedSourceFolder = useJobsPageStore((state) => state.setLastPickedSourceFolder);
  const preflightDraftFingerprint = useJobsPageStore((state) => state.preflightDraftFingerprint);
  const setPreflightDraftFingerprint = useJobsPageStore((state) => state.setPreflightDraftFingerprint);
  const clearPreflightState = useJobsPageStore((state) => state.clearPreflightState);
  const [settingsSnapshot, setSettingsSnapshot] = useState<GuiSettings | null>(null);
  const [draggedImageId, setDraggedImageId] = useState<string | null>(null);
  const [creatingLearningProfile, setCreatingLearningProfile] = useState(false);
  const [centerNotice, setCenterNotice] = useState<{
    message: string;
    tone: "info" | "success" | "error";
  } | null>(null);

  const setSelectedJobId = useUiStore((state) => state.setSelectedJobId);
  const setSelectedMangaId = useUiStore((state) => state.setSelectedMangaId);
  const setSelectedTranslatorId = useUiStore((state) => state.setSelectedTranslatorId);
  const setSelectedPage = useUiStore((state) => state.setSelectedPage);

  useEffect(() => {
    readSettings()
      .then((settings) => {
        setSettingsSnapshot(settings);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!centerNotice) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setCenterNotice(null);
    }, 3200);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [centerNotice]);

  const selectJobContext = (job: GuiJob) => {
    setSelectedJobId(job.id);
    if (typeof job.payload.mangaId === "string" && job.payload.mangaId.trim()) {
      setSelectedMangaId(job.payload.mangaId);
    }
    if (typeof job.payload.translatorId === "string" && job.payload.translatorId.trim()) {
      setSelectedTranslatorId(job.payload.translatorId);
    }
  };

  const commonSuccess = async (job: GuiJob, message: string) => {
    selectJobContext(job);
      setStatus(`${message} Job 已建立成功，可到 Job List 查看。`);
    setCenterNotice({
      message,
      tone: "success",
    });
    await queryClient.invalidateQueries({ queryKey: ["jobs"] });
  };

  const translationMutation = useMutation({
    mutationFn: createTranslationJob,
    onSuccess: async (job) => {
      await commonSuccess(job, `Translation job created: ${job.id}`);
    },
    onError: () => {
      setStatus("Failed to create translation job.");
      setCenterNotice({
        message: "建立翻譯 Job 失敗。",
        tone: "error",
      });
    },
  });

  const sourcePreflightMutation = useMutation({
    mutationFn: createSourcePreflight,
    onSuccess: (result) => {
      setPreflightResult(result);
      setOrderedImageIds(result.images.map((image) => image.id));
      setStatus(`Source preflight ready: ${result.summary.acceptedCount} images accepted.`);
      setCenterNotice({
        message: `Validate completed: ${result.summary.acceptedCount} usable images ready.`,
        tone: "success",
      });
    },
    onError: () => {
      setStatus("Failed to preflight source images.");
      setCenterNotice({
        message: "Validate failed.",
        tone: "error",
      });
    },
  });

  const reorderMutation = useMutation({
    mutationFn: ({ preflightId, orderedIds }: { preflightId: string; orderedIds: string[] }) =>
      reorderSourcePreflight(preflightId, orderedIds),
    onSuccess: (result) => {
      setPreflightResult(result);
      setOrderedImageIds(result.images.map((image) => image.id));
      setStatus("Source image order applied.");
      setCenterNotice({
        message: "Image order applied.",
        tone: "success",
      });
    },
    onError: () => {
      setStatus("Failed to apply source image order.");
      setCenterNotice({
        message: "Apply image order failed.",
        tone: "error",
      });
    },
  });

  const busy = useMemo(
    () =>
      translationMutation.isPending ||
      sourcePreflightMutation.isPending ||
      reorderMutation.isPending ||
      creatingLearningProfile,
    [
      creatingLearningProfile,
      reorderMutation.isPending,
      sourcePreflightMutation.isPending,
      translationMutation.isPending,
    ]
  );

  const mangaSeriesOptions = useMemo(
    () => mangaSeriesQuery.data?.series || [],
    [mangaSeriesQuery.data]
  );
  const selectedManga = useMemo(
    () => resolveSelectedManga(translationDraft.profileSelection, mangaSeriesOptions),
    [mangaSeriesOptions, translationDraft.profileSelection]
  );
  const selectedOutputTranslator = useMemo(
    () => resolveSelectedOutputTranslator(selectedManga, translationDraft.translatorSelection),
    [selectedManga, translationDraft.translatorSelection]
  );
  const selectedLearningProfile = useMemo(
    () => resolveSelectedTranslatorProfile(translationDraft.learningProfileSelection, mangaSeriesOptions),
    [mangaSeriesOptions, translationDraft.learningProfileSelection]
  );
  const usesSeparateReferenceProfile = getTranslationModeDefinition(
    translationDraft.translationMode
  ).useReference;
  const referenceProfileSeries = useMemo(
    () =>
      mangaSeriesOptions
        .map((manga) => ({
          ...manga,
          translators: (manga.translators || []).filter(
            (translator) =>
              translator.translatorId !== "translator_original" &&
              translator.profileKind !== "learning_clone"
          ),
        }))
        .filter((manga) => manga.translators.length > 0),
    [mangaSeriesOptions]
  );
  const outputProfile = usesSeparateReferenceProfile
    ? selectedLearningProfile
    : selectedOutputTranslator && selectedManga
      ? {
          mangaId: selectedManga.mangaId,
          mangaLabel: selectedManga.label,
          translatorId: selectedOutputTranslator.translatorId,
          translatorLabel: selectedOutputTranslator.label,
        }
      : null;
  const availableLearningProfiles = useMemo(() => {
    if (!selectedOutputTranslator || !selectedManga) return [];
    const manga = mangaSeriesOptions.find((entry) => entry.mangaId === selectedManga.mangaId);
    return (manga?.translators || []).filter(
      (entry) =>
        entry.profileKind === "learning_clone" &&
        entry.styleSourceTranslatorId === selectedOutputTranslator.translatorId
    );
  }, [mangaSeriesOptions, selectedManga, selectedOutputTranslator]);
  const availableChapters = useMemo(() => {
    if (!outputProfile) {
      return [];
    }
    const manga = mangaSeriesOptions.find((entry) => entry.mangaId === outputProfile.mangaId);
    const translator = manga?.translators.find((entry) => entry.translatorId === outputProfile.translatorId);
    return (translator?.chapters || []).slice().sort((left, right) => left.sortOrder - right.sortOrder);
  }, [mangaSeriesOptions, outputProfile]);
  const availableSourceChapters = useMemo(() => {
    if (!selectedManga) return [];
    const manga = mangaSeriesOptions.find((entry) => entry.mangaId === selectedManga.mangaId);
    const original = manga?.translators.find((entry) => entry.translatorId === "translator_original");
    return (original?.chapters || []).slice().sort((left, right) => left.sortOrder - right.sortOrder);
  }, [mangaSeriesOptions, selectedManga]);
  const selectedChapter = useMemo(
    () => resolveSelectedChapter(translationDraft.chapterSelection, availableChapters),
    [availableChapters, translationDraft.chapterSelection]
  );
  const provisionalTranslationContext = useMemo((): ResolvedTranslationContext | null => {
    if (usesSeparateReferenceProfile && selectedOutputTranslator && selectedManga) {
      if (selectedLearningProfile) {
        if (selectedLearningProfile.mangaId !== selectedManga.mangaId) return null;
        return {
          mangaId: selectedManga.mangaId,
          mangaLabel: selectedManga.label,
          translatorId: selectedLearningProfile.translatorId,
          translatorLabel: selectedLearningProfile.translatorLabel,
          referenceTranslatorId: selectedOutputTranslator.translatorId,
          referenceTranslatorLabel: selectedOutputTranslator.label,
          chapterId: selectedChapter?.chapterId,
          chapterTitle: selectedChapter?.chapterTitle || undefined,
        };
      }
      return null;
    }
    if (selectedManga && selectedOutputTranslator) {
      return {
        mangaId: selectedManga.mangaId,
        mangaLabel: selectedManga.label,
        translatorId: selectedOutputTranslator.translatorId,
        translatorLabel: selectedOutputTranslator.label,
        chapterId: selectedChapter?.chapterId,
        chapterTitle: selectedChapter?.chapterTitle || undefined,
      };
    }
    if (
      selectedManga &&
      translationDraft.translatorSelection === CREATE_NEW_TRANSLATOR_VALUE &&
      translationDraft.newTranslatorLabel.trim()
    ) {
      const translatorLabel = translationDraft.newTranslatorLabel.trim();
      return {
        mangaId: selectedManga.mangaId,
        mangaLabel: selectedManga.label,
        translatorId: toSystemId("translator", translatorLabel) || "",
        translatorLabel,
        chapterId:
          translationDraft.chapterSelection === CREATE_NEW_CHAPTER_VALUE
            ? toSystemId("chapter", translationDraft.newChapterTitle)
            : selectedChapter?.chapterId,
        chapterTitle:
          translationDraft.chapterSelection === CREATE_NEW_CHAPTER_VALUE
            ? sanitizeOptional(translationDraft.newChapterTitle)
            : selectedChapter?.chapterTitle || undefined,
      };
    }

    if (translationDraft.profileSelection !== CREATE_NEW_MANGA_VALUE) {
      return null;
    }

    const mangaLabel = translationDraft.newMangaLabel.trim();
    const translatorLabel = translationDraft.newTranslatorLabel.trim();
    if (!mangaLabel || translationDraft.translatorSelection !== CREATE_NEW_TRANSLATOR_VALUE || !translatorLabel) {
      return null;
    }

    return {
      mangaId: toSystemId("manga", mangaLabel) || "",
      mangaLabel,
      translatorId: toSystemId("translator", translatorLabel) || "",
      translatorLabel,
      chapterId:
        translationDraft.chapterSelection === CREATE_NEW_CHAPTER_VALUE
          ? toSystemId("chapter", translationDraft.newChapterTitle)
          : selectedChapter?.chapterId,
      chapterTitle:
        translationDraft.chapterSelection === CREATE_NEW_CHAPTER_VALUE
          ? sanitizeOptional(translationDraft.newChapterTitle)
          : selectedChapter?.chapterTitle || undefined,
    };
  }, [
    selectedChapter,
    selectedLearningProfile,
    selectedManga,
    selectedOutputTranslator,
    translationDraft.chapterSelection,
    translationDraft.newChapterTitle,
    translationDraft.newMangaLabel,
    translationDraft.newLearningTranslatorLabel,
    translationDraft.newTranslatorLabel,
    translationDraft.profileSelection,
    translationDraft.translatorSelection,
    translationDraft.learningProfileSelection,
    usesSeparateReferenceProfile,
  ]);
  const translationIds = {
    mangaId: provisionalTranslationContext?.mangaId,
    translatorId: provisionalTranslationContext?.translatorId,
    chapterId: provisionalTranslationContext?.chapterId,
  };
  const translationModeDefinition = useMemo(
    () => getTranslationModeDefinition(translationDraft.translationMode),
    [translationDraft.translationMode]
  );
  const consistencyCheckEnabled = useMemo(
    () => isConsistencyCheckEnabled(translationDraft),
    [translationDraft]
  );
  const translationMemoryInspectionQuery = useQuery({
    queryKey: [
      "translationMemoryInspection",
      translationDraft.translationMode,
      provisionalTranslationContext?.mangaId,
      provisionalTranslationContext?.translatorId,
      provisionalTranslationContext?.referenceTranslatorId,
      provisionalTranslationContext?.chapterId,
      translationDraft.sourceChapterSelection,
      translationDraft.glossaryMode,
      consistencyCheckEnabled,
    ],
    queryFn: () =>
      inspectTranslationMemory({
        translationMode: translationDraft.translationMode,
        qualityCheck: consistencyCheckEnabled,
        mangaId: provisionalTranslationContext?.mangaId,
        translatorId: provisionalTranslationContext?.translatorId,
        referenceTranslatorId: provisionalTranslationContext?.referenceTranslatorId,
        chapterId: provisionalTranslationContext?.chapterId,
        chapterTitle: provisionalTranslationContext?.chapterTitle,
        sourceChapterId: sanitizeOptional(translationDraft.sourceChapterSelection),
        glossaryMode: translationDraft.glossaryMode,
        targetLanguage: normalizeReferenceLanguage(translationDraft.targetLanguage),
      }),
    enabled:
      translationDraft.translationMode !== "quick" &&
      Boolean(provisionalTranslationContext?.mangaId) &&
      Boolean(provisionalTranslationContext?.translatorId),
    retry: false,
  });

  const orderedImages = useMemo(() => {
    if (!preflightResult) {
      return [];
    }
    const imageMap = new Map(preflightResult.images.map((image) => [image.id, image]));
    return orderedImageIds
      .map((imageId) => imageMap.get(imageId))
      .filter((image): image is SourcePreflightImage => Boolean(image));
  }, [orderedImageIds, preflightResult]);

  const orderingDirty = useMemo(() => {
    if (!preflightResult) {
      return false;
    }
    return orderingFingerprint(orderedImageIds) !== preflightResult.currentFingerprint;
  }, [orderedImageIds, preflightResult]);

  const draftDirtySincePreflight = useMemo(() => {
    if (!preflightResult || !preflightDraftFingerprint) {
      return false;
    }
    return preflightDraftFingerprint !== translationDraftFingerprint(translationDraft);
  }, [preflightDraftFingerprint, preflightResult, translationDraft]);

  const translationChecklist = useMemo(() => {
    const items = buildTranslationChecklist({
        translationDraft,
        resolvedMangaLabel: provisionalTranslationContext?.mangaLabel || "",
        resolvedTranslatorLabel: provisionalTranslationContext?.translatorLabel || "",
        modeDefinition: translationModeDefinition,
        settingsSnapshot,
        translationPathValidation,
        preflightResult,
      });
    if (translationDraft.translationMode !== "quick") {
      const inspection = translationMemoryInspectionQuery.data;
      items.push({
        label: inspection?.ready ? t("jobs.memory.ready") : t("jobs.memory.blocked"),
        done: inspection?.ready === true,
        detail: translationMemoryInspectionQuery.isFetching
          ? t("jobs.memory.loading")
          : inspection?.blockingReason ||
            inspection?.chapterMapping?.sourceChapterTitle ||
            inspection?.chapterMapping?.sourceChapterId ||
            t("jobs.memory.blocked"),
      });
    }
    return items;
  },
    [
      preflightResult,
      provisionalTranslationContext?.mangaLabel,
      provisionalTranslationContext?.translatorLabel,
      settingsSnapshot,
      translationDraft,
      translationMemoryInspectionQuery.data,
      translationMemoryInspectionQuery.isFetching,
      translationModeDefinition,
      translationPathValidation,
      t,
    ]
  );

  const translationBlockingIssues = useMemo(() => {
    const issues: string[] = [];

    if (!translationDraft.sourceFolder.trim()) {
      issues.push("Choose a source folder first.");
    }
    if (!provisionalTranslationContext?.mangaLabel?.trim()) {
      issues.push("Choose or create a manga.");
    }
    if (!provisionalTranslationContext?.translatorId?.trim()) {
      issues.push("Choose or create a translator.");
    }
    if (
      translationModeDefinition.useReference &&
      !provisionalTranslationContext?.referenceTranslatorId?.trim()
    ) {
      issues.push(t("jobs.learning.referenceRequired"));
    }
    if (!translationDraft.chapterSelection) {
      issues.push("Choose or create a chapter.");
    }
    if (
      translationDraft.chapterSelection === CREATE_NEW_CHAPTER_VALUE &&
      !translationDraft.newChapterTitle.trim()
    ) {
      issues.push("Enter a chapter title when creating a new chapter.");
    }
    if (!settingsSnapshot?.outputFolder.trim()) {
      issues.push("Choose an output folder in Settings.");
    }
    if (translationPathValidation && !translationPathValidation.outputFolder.ok) {
      issues.push(`Choose a valid output folder: ${translationPathValidation.outputFolder.reason}`);
    }
    if (translationPathValidation && !translationPathValidation.sourceFolder.ok) {
      issues.push(`Fix the source folder: ${translationPathValidation.sourceFolder.reason}`);
    }
    if (!preflightResult) {
      issues.push("Run source preflight.");
    } else if (!preflightResult.ready) {
      issues.push("Source preflight did not produce any usable images.");
    }
    if (draftDirtySincePreflight) {
      issues.push("Run Validate again after changing translation job settings.");
    }
    if (translationDraft.translationMode !== "quick") {
      if (translationMemoryInspectionQuery.isFetching) {
        issues.push(t("jobs.memory.loading"));
      } else if (translationMemoryInspectionQuery.isError) {
        issues.push(
          translationMemoryInspectionQuery.error instanceof Error
            ? translationMemoryInspectionQuery.error.message
            : t("jobs.memory.blocked")
        );
      } else if (translationMemoryInspectionQuery.data?.ready !== true) {
        issues.push(
          translationMemoryInspectionQuery.data?.blockingReason || t("jobs.memory.blocked")
        );
      }
    }

    return issues;
  }, [
    draftDirtySincePreflight,
    preflightResult,
    settingsSnapshot,
    translationDraft,
    translationMemoryInspectionQuery.data,
    translationMemoryInspectionQuery.error,
    translationMemoryInspectionQuery.isError,
    translationMemoryInspectionQuery.isFetching,
    translationModeDefinition.useReference,
    translationPathValidation,
    t,
  ]);

  const startTranslationDisabled =
    busy ||
    !provisionalTranslationContext?.mangaLabel?.trim() ||
    !preflightResult?.ready ||
    translationBlockingIssues.length > 0;

  const runPreflight = async () => {
    if (!translationDraft.sourceFolder.trim()) {
      setStatus("Please choose a source folder first.");
      return;
    }

    const currentSettings = settingsSnapshot || (await readSettings());
    setSettingsSnapshot(currentSettings);
    const validation = await validatePaths({
      sourceFolder: translationDraft.sourceFolder,
      outputFolder: currentSettings.outputFolder,
      referenceFolder: currentSettings.referenceFolder,
      sourceRequired: true,
    });
    setTranslationPathValidation(validation);

    if (!validation.sourceFolder.ok) {
      setStatus(`Source folder validation failed: ${validation.sourceFolder.reason}`);
      return;
    }
    if (!validation.outputFolder.ok) {
      setStatus(`Output folder validation failed: ${validation.outputFolder.reason}`);
      return;
    }
    if (
      translationDraft.sourceFolder.trim() &&
      currentSettings.outputFolder.trim() &&
      translationDraft.sourceFolder.trim() === currentSettings.outputFolder.trim()
    ) {
      setStatus("Source folder and output folder must be different.");
      return;
    }

    await sourcePreflightMutation.mutateAsync({
      sourceFolder: translationDraft.sourceFolder.trim(),
    });
    setPreflightDraftFingerprint(translationDraftFingerprint(translationDraft));
  };

  const applyCurrentOrdering = async () => {
    if (!preflightResult || !orderingDirty) {
      return preflightResult;
    }
    return reorderMutation.mutateAsync({
      preflightId: preflightResult.preflightId,
      orderedIds: orderedImageIds,
    });
  };

  const startTranslation = async () => {
    if (!provisionalTranslationContext?.mangaId || !provisionalTranslationContext.translatorId) {
      setStatus("Manga and translator profile are required.");
      setCenterNotice({
        message: "Choose or create a manga + translator profile first.",
        tone: "error",
      });
      return;
    }
    if (!preflightResult) {
      setStatus("Run source preflight before starting translation.");
      setCenterNotice({
        message: "Please validate source images first.",
        tone: "error",
      });
      return;
    }
    if (!preflightResult.ready) {
      setStatus("Source preflight did not produce any usable images.");
      setCenterNotice({
        message: "No usable images are ready for translation.",
        tone: "error",
      });
      return;
    }

    const activePreflight =
      orderingDirty && preflightResult ? await applyCurrentOrdering() : preflightResult;

    if (!activePreflight) {
      setStatus("No preflight result is available.");
      setCenterNotice({
        message: "No preflight result is available.",
        tone: "error",
      });
      return;
    }

    const currentSettings = settingsSnapshot || (await readSettings());
    setSettingsSnapshot(currentSettings);
    const outputDir = currentSettings.outputFolder.trim();
    if (!outputDir) {
      setStatus("Open Settings and choose a valid output folder before starting translation.");
      setCenterNotice({
        message: "Choose a default output folder in Settings first.",
        tone: "error",
      });
      return;
    }

    setCenterNotice({
      message: buildTranslationStatusMessage(translationDraft),
      tone: "info",
    });

    let resolvedContext = provisionalTranslationContext;
    if (!usesSeparateReferenceProfile && translationDraft.profileSelection === CREATE_NEW_MANGA_VALUE) {
      const createdManga = await createManga({
        label: resolvedContext.mangaLabel,
      });
      const createdTranslator = await createTranslatorProfile(createdManga.manga.mangaId, {
        label: resolvedContext.translatorLabel,
      });
      resolvedContext = {
        ...resolvedContext,
        mangaId: createdManga.manga.mangaId,
        translatorId: createdTranslator.translator.translatorId,
      };
      await queryClient.invalidateQueries({ queryKey: ["mangaSeries"] });
    } else if (
      !usesSeparateReferenceProfile &&
      translationDraft.translatorSelection === CREATE_NEW_TRANSLATOR_VALUE
    ) {
      const createdTranslator = await createTranslatorProfile(resolvedContext.mangaId, {
        label: resolvedContext.translatorLabel,
      });
      resolvedContext = {
        ...resolvedContext,
        translatorId: createdTranslator.translator.translatorId,
        translatorLabel: createdTranslator.translator.label,
      };
      await queryClient.invalidateQueries({ queryKey: ["mangaSeries"] });
    }
    if (translationDraft.chapterSelection === CREATE_NEW_CHAPTER_VALUE) {
      const createdChapter = await createChapter(resolvedContext.mangaId, resolvedContext.translatorId, {
        chapterTitle: sanitizeOptional(translationDraft.newChapterTitle) || null,
      });
      resolvedContext = {
        ...resolvedContext,
        chapterId: createdChapter.chapter.chapterId,
        chapterTitle: createdChapter.chapter.chapterTitle || undefined,
      };
      await queryClient.invalidateQueries({ queryKey: ["mangaSeries"] });
    }

    await translationMutation.mutateAsync({
      sourceFolder: translationDraft.sourceFolder.trim(),
      translationMode: translationDraft.translationMode,
      sourcePreflightId: activePreflight.preflightId,
      targetLanguage: normalizeReferenceLanguage(translationDraft.targetLanguage),
      outputDir,
      mangaId: resolvedContext.mangaId,
      mangaLabel: sanitizeOptional(resolvedContext.mangaLabel),
      translatorId: resolvedContext.translatorId,
      translatorLabel: sanitizeOptional(resolvedContext.translatorLabel),
      referenceTranslatorId: resolvedContext.referenceTranslatorId,
      referenceTranslatorLabel: sanitizeOptional(resolvedContext.referenceTranslatorLabel || ""),
      chapterId: resolvedContext.chapterId,
      sourceChapterId: sanitizeOptional(translationDraft.sourceChapterSelection),
      chapterTitle: resolvedContext.chapterTitle,
      chapterLabel: resolvedContext.chapterTitle,
      glossaryMode: translationModeDefinition.useReference ? translationDraft.glossaryMode : undefined,
      qualityCheck: consistencyCheckEnabled,
    });
  };

  const createLearningProfile = async () => {
    if (!selectedManga || !selectedOutputTranslator || !translationDraft.newLearningTranslatorLabel.trim()) {
      setStatus(t("jobs.learning.profile.createMissing"));
      return;
    }
    setCreatingLearningProfile(true);
    try {
      const created = await createTranslatorProfile(selectedManga.mangaId, {
        label: translationDraft.newLearningTranslatorLabel.trim(),
        language: normalizeReferenceLanguage(translationDraft.targetLanguage),
        styleSourceTranslatorId: selectedOutputTranslator.translatorId,
      });
      await queryClient.invalidateQueries({ queryKey: ["mangaSeries"] });
      setTranslationDraft((current) => ({
        ...current,
        learningProfileSelection: `${selectedManga.mangaId}::${created.translator.translatorId}`,
        newLearningTranslatorLabel: "",
        chapterSelection: "",
      }));
      setStatus(t("jobs.learning.profile.created"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("jobs.learning.profile.createFailed"));
    } finally {
      setCreatingLearningProfile(false);
    }
  };

  const pickSourceFolder = async () => {
    try {
      const result = await pickDirectory({
        title: "Select source folder",
        defaultPath:
          translationDraft.sourceFolder ||
          lastPickedSourceFolder ||
          settingsSnapshot?.lastPickedSourceFolder ||
          settingsSnapshot?.referenceFolder ||
          settingsSnapshot?.outputFolder ||
          undefined,
      });
      if (result.canceled || !result.path) {
        return;
      }
      setTranslationDraft((current) => ({
        ...current,
        sourceFolder: result.path || "",
      }));
      setLastPickedSourceFolder(result.path || "");
      setSettingsSnapshot((current) =>
        current
          ? {
              ...current,
              lastPickedSourceFolder: result.path || "",
            }
          : current
      );
      void writeSettings({
        lastPickedSourceFolder: result.path || "",
      });
      clearPreflightState();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to choose source folder.");
    }
  };

  const openSettingsForOutputFix = () => {
    setSelectedPage("settings");
    setStatus("Open Settings and choose a valid output folder before starting translation.");
  };

  return (
    <section className="page">
      {centerNotice && (
        <div className="center-notice-layer" aria-live="polite">
          <div className={`center-notice center-notice-${centerNotice.tone}`}>
            {centerNotice.message}
          </div>
        </div>
      )}
      <h1>Create Translation Job</h1>
      <p>{status}</p>
      <div className="button-row">
        <button className="secondary-button" onClick={() => void queryClient.invalidateQueries({ queryKey: ["jobs"] })} type="button">
          重新整理相關 Jobs
        </button>
      </div>
      <div className="card-stack">
        <article className="card">
          <h2>Start translation</h2>
          <p className="muted-text">
            依序選擇來源、翻譯模式、作品上下文，系統會先做前置檢查，再開始翻譯。
          </p>
          <div className="form-grid">
            <label>
              <span>來源資料夾</span>
              <small className="muted-text">必填。系統只會讀取這個資料夾，並在其他位置建立處理用檔案。</small>
              <div className="field-with-action">
                <input
                  value={translationDraft.sourceFolder}
                  onChange={(event) => {
                    const nextValue = event.currentTarget.value;
                    setTranslationDraft((current) => ({ ...current, sourceFolder: nextValue }));
                    if (preflightResult && preflightResult.sourceFolder !== nextValue) {
                      clearPreflightState();
                    }
                  }}
                />
                <button className="secondary-button" onClick={pickSourceFolder} type="button">
                  瀏覽
                </button>
              </div>
            </label>
            <label>
              <span>{t("jobs.targetLanguage.label")}</span>
              <select
                value={normalizeReferenceLanguage(
                  translationDraft.targetLanguage || DEFAULT_REFERENCE_LANGUAGE
                )}
                onChange={(event) => {
                  const nextValue = event.currentTarget.value;
                  setTranslationDraft((current) => ({ ...current, targetLanguage: nextValue }));
                }}
              >
                {REFERENCE_LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <article className="compact-grid">
            <h3>Translation mode</h3>
            <div className="translation-mode-grid">
              {TRANSLATION_MODE_DEFINITIONS.map((definition) => (
                <button
                  key={definition.value}
                  className={
                    translationDraft.translationMode === definition.value
                      ? "translation-mode-card active"
                      : "translation-mode-card"
                  }
                  onClick={() =>
                    setTranslationDraft((current) => ({
                      ...current,
                      translationMode: definition.value,
                      qualityCheck:
                        definition.consistencyCheck === "required"
                          ? true
                          : definition.consistencyCheck === "hidden"
                            ? false
                            : current.qualityCheck,
                      referenceLabel: definition.useReference ? current.referenceLabel : "",
                      glossaryMode: definition.useReference ? current.glossaryMode : "canonical",
                    }))
                  }
                  type="button"
                >
                  <strong>{definition.label}</strong>
                  <span>{definition.description}</span>
                </button>
              ))}
            </div>
          </article>

          <article className="compact-grid">
            <h3>模式說明</h3>
            <div className="artifact-summary-card">
              <strong>{translationModeDefinition.label}</strong>
              <p className="muted-text">{translationModeDefinition.description}</p>
              <ul className="plain-list">
                <li>{translationModeDefinition.useReference ? "會在翻譯前使用 Reference。" : "不使用外部 Reference。"}</li>
                <li>{translationModeDefinition.writeLocalStyle ? "翻譯完成後會更新本地風格資料。" : "不會更新本地風格資料。"}</li>
                <li>
                  {translationModeDefinition.consistencyCheck === "required"
                    ? "翻譯後一定會執行品質檢查。"
                    : translationModeDefinition.consistencyCheck === "optional"
                      ? "可選擇是否在翻譯後執行品質檢查。"
                      : "不執行品質檢查。"}
                </li>
              </ul>
            </div>
          </article>

          <div className="form-grid">
            <label>
              <span>{t("jobs.outputManga.label")}</span>
              <small className="muted-text">{t("jobs.outputManga.help")}</small>
              <div className="stacked-field-row">
                <select
                  value={translationDraft.profileSelection}
                  onChange={(event) => {
                    const nextValue = event.currentTarget.value;
                    setTranslationDraft((current) => ({
                      ...current,
                      profileSelection: nextValue,
                      translatorSelection: "",
                      learningProfileSelection: "",
                      chapterSelection: "",
                      sourceChapterSelection: "",
                    }));
                  }}
                >
                  <option value="">
                    {mangaSeriesQuery.isLoading
                      ? t("jobs.outputManga.loading")
                      : mangaSeriesQuery.isError
                        ? t("jobs.outputManga.failed")
                        : t("jobs.outputManga.select")}
                  </option>
                  {mangaSeriesOptions.map((manga) => (
                    <option key={manga.mangaId} value={manga.mangaId}>
                      {manga.label}
                    </option>
                  ))}
                  {!usesSeparateReferenceProfile ? (
                    <option value={CREATE_NEW_MANGA_VALUE}>{t("jobs.outputManga.create")}</option>
                  ) : null}
                </select>
                {translationDraft.profileSelection === CREATE_NEW_MANGA_VALUE ? (
                  <input
                    placeholder={t("jobs.outputManga.newPlaceholder")}
                    value={translationDraft.newMangaLabel}
                    onChange={(event) =>
                      setTranslationDraft((current) => ({
                        ...current,
                        newMangaLabel: event.currentTarget.value,
                      }))
                    }
                  />
                ) : null}
              </div>
            </label>
            <label>
              <span>
                {usesSeparateReferenceProfile
                  ? t("jobs.learning.referenceProfile.label")
                  : t("jobs.outputTranslator.label")}
              </span>
              <small className="muted-text">
                {usesSeparateReferenceProfile
                  ? t("jobs.learning.referenceProfile.help")
                  : t("jobs.outputTranslator.help")}
              </small>
              <div className="stacked-field-row">
                <select
                  value={translationDraft.translatorSelection}
                  disabled={!selectedManga && translationDraft.profileSelection !== CREATE_NEW_MANGA_VALUE}
                  onChange={(event) => {
                    const nextValue = event.currentTarget.value;
                    setTranslationDraft((current) => ({
                      ...current,
                      translatorSelection: nextValue,
                      learningProfileSelection: "",
                      chapterSelection: "",
                    }));
                  }}
                >
                  <option value="">
                    {translationDraft.profileSelection ? t("jobs.outputTranslator.select") : t("jobs.outputTranslator.chooseMangaFirst")}
                  </option>
                  {(selectedManga?.translators || [])
                    .filter((translator) =>
                      usesSeparateReferenceProfile
                        ? translator.translatorId !== "translator_original" &&
                          translator.profileKind !== "learning_clone"
                        : translator.profileKind !== "learning_clone"
                    )
                    .map((translator) => (
                      <option key={translator.translatorId} value={translator.translatorId}>
                        {translator.label}
                      </option>
                    ))}
                  {!usesSeparateReferenceProfile ? (
                    <option value={CREATE_NEW_TRANSLATOR_VALUE}>{t("jobs.outputTranslator.create")}</option>
                  ) : null}
                </select>
                {translationDraft.translatorSelection === CREATE_NEW_TRANSLATOR_VALUE ? (
                  <input
                    placeholder={t("jobs.outputTranslator.newPlaceholder")}
                    value={translationDraft.newTranslatorLabel}
                    onChange={(event) =>
                      setTranslationDraft((current) => ({
                        ...current,
                        newTranslatorLabel: event.currentTarget.value,
                      }))
                    }
                  />
                ) : null}
              </div>
            </label>
            {usesSeparateReferenceProfile ? (
              <label>
                <span>{t("jobs.learning.profile.label")}</span>
                <small className="muted-text">{t("jobs.learning.profile.help")}</small>
                <select
                  value={translationDraft.learningProfileSelection}
                  disabled={!selectedManga || !selectedOutputTranslator}
                  onChange={(event) => {
                    const nextValue = event.currentTarget.value;
                    setTranslationDraft((current) => ({
                      ...current,
                      learningProfileSelection: nextValue,
                      chapterSelection: "",
                    }));
                  }}
                >
                  <option value="">{t("jobs.learning.profile.select")}</option>
                  {availableLearningProfiles.map((profile) => (
                    <option
                      key={profile.translatorId}
                      value={`${selectedManga?.mangaId || ""}::${profile.translatorId}`}
                    >
                      {profile.label}
                    </option>
                  ))}
                  <option value={CREATE_NEW_LEARNING_PROFILE_VALUE}>
                    {t("jobs.learning.profile.create")}
                  </option>
                </select>
                {translationDraft.learningProfileSelection ===
                CREATE_NEW_LEARNING_PROFILE_VALUE ? (
                  <div className="field-with-action">
                    <input
                      placeholder={t("jobs.learning.profile.newPlaceholder")}
                      value={translationDraft.newLearningTranslatorLabel}
                      onChange={(event) => {
                        const nextValue = event.currentTarget.value;
                        setTranslationDraft((current) => ({
                          ...current,
                          newLearningTranslatorLabel: nextValue,
                        }));
                      }}
                    />
                    <button
                      className="secondary-button"
                      disabled={
                        creatingLearningProfile ||
                        !selectedManga ||
                        !selectedOutputTranslator ||
                        !translationDraft.newLearningTranslatorLabel.trim()
                      }
                      onClick={() => void createLearningProfile()}
                      type="button"
                    >
                      {creatingLearningProfile
                        ? t("jobs.learning.profile.creating")
                        : t("jobs.learning.profile.createAction")}
                    </button>
                  </div>
                ) : null}
              </label>
            ) : null}
            <ChapterSelector
              label={t("jobs.outputChapter.label")}
              helpText={
                usesSeparateReferenceProfile
                  ? t("jobs.learning.outputChapter.help")
                  : t("jobs.outputChapter.help")
              }
              selectedValue={translationDraft.chapterSelection}
              chapters={availableChapters}
              newChapterTitle={translationDraft.newChapterTitle}
              disabled={
                usesSeparateReferenceProfile
                  ? !selectedLearningProfile &&
                    translationDraft.learningProfileSelection !== CREATE_NEW_LEARNING_PROFILE_VALUE
                  : !selectedOutputTranslator &&
                    translationDraft.translatorSelection !== CREATE_NEW_TRANSLATOR_VALUE
              }
              onSelectionChange={(value) =>
                setTranslationDraft((current) => ({
                  ...current,
                  chapterSelection: value,
                }))
              }
              onNewChapterTitleChange={(value) =>
                setTranslationDraft((current) => ({
                  ...current,
                  newChapterTitle: value,
                }))
              }
            />
            {translationModeDefinition.useReference && (
              <label>
                <span>{t("jobs.sourceChapter.label")}</span>
                <small className="muted-text">{t("jobs.sourceChapter.help")}</small>
                <select
                  value={translationDraft.sourceChapterSelection}
                  onChange={(event) => {
                    const nextValue = event.currentTarget.value;
                    setTranslationDraft((current) => ({ ...current, sourceChapterSelection: nextValue }));
                  }}
                >
                  <option value="">{t("jobs.sourceChapter.auto")}</option>
                  {availableSourceChapters.map((chapter) => (
                    <option key={chapter.chapterId} value={chapter.chapterId}>
                      {chapter.chapterTitle || chapter.chapterId}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {translationModeDefinition.consistencyCheck === "optional" && (
              <label>
                <span>執行品質驗證</span>
                <div className="switch-row">
                  <label className="switch">
                    <input
                      checked={translationDraft.qualityCheck}
                      type="checkbox"
                      onChange={(event) => {
                        const nextValue = Boolean((event.target as HTMLInputElement | null)?.checked);
                        setTranslationDraft((current) => ({ ...current, qualityCheck: nextValue }));
                      }}
                    />
                    <span className="switch-slider" />
                  </label>
                  <span>{translationDraft.qualityCheck ? "啟用" : "停用"}</span>
                </div>
              </label>
            )}
            {translationModeDefinition.consistencyCheck === "required" && (
              <label>
                <span>執行品質驗證</span>
                <div className="switch-row">
                  <span className="mode-lock-badge">此模式固定啟用</span>
                </div>
              </label>
            )}
          </div>

          {translationModeDefinition.useReference && (
            <article className="compact-grid">
              <h3>Reference 設定</h3>
              <ul className="plain-list">
                <li>這個模式會在翻譯前使用 Reference 衍生出的術語與上下文。</li>
                <li>所選 Reference 會影響 glossary 與 prompt context。</li>
                <li>系統會使用目前作品已完成的原文與譯者 Reference 記憶，不會在翻譯時重跑 Ingestion。</li>
              </ul>
              <ReferenceGlossaryStrategySelector
                label={t("referenceGlossaryStrategy.title")}
                helpText="選擇這個 Job 要如何把 Reference 衍生出的術語帶入翻譯 prompt。"
                value={translationDraft.glossaryMode}
                onChange={(value) =>
                  setTranslationDraft((current) => ({
                    ...current,
                    glossaryMode: value,
                  }))
                }
              />
            </article>
          )}

          {consistencyCheckEnabled && (
            <article className="compact-grid">
              <h3>品質檢查設定</h3>
              <div className="summary-grid">
                <div>
                  <strong>Model ID</strong>
                  <div className="muted-text">
                    {settingsSnapshot?.quality.modelId || "若要指定模型，請到 Settings 設定。"}
                  </div>
                </div>
                <div>
                  <strong>Server URL</strong>
                  <div className="muted-text">
                    {settingsSnapshot?.quality.serverUrl || "若模型由遠端服務提供，請到 Settings 設定。"}
                  </div>
                </div>
              </div>
            </article>
          )}

          {translationModeDefinition.writeLocalStyle && (
            <article className="compact-grid">
              <h3>本地風格更新</h3>
              <ul className="plain-list">
                <li>此模式會為目前漫畫累積術語、語氣與風格資料。</li>
                <li>章節名稱為可選，會作為人類可讀的章節描述。</li>
                <li>更新後的本地風格檔案會出現在 Job artifacts。</li>
              </ul>
            </article>
          )}

          <article className="compact-grid">
            <h3>前置檢查</h3>
            <ul className="plain-list checklist-list">
              {translationChecklist.map((item) => (
                <li key={item.label} className={item.done ? "checklist-item done" : "checklist-item pending"}>
                  <strong>{item.done ? "完成" : "待處理"}：</strong> {item.label}
                  <div className="muted-text">{item.detail}</div>
                </li>
              ))}
            </ul>
          </article>

          <div className="button-row">
                <button
                  className="secondary-button"
                  disabled={busy || !translationDraft.sourceFolder.trim()}
                  onClick={() => void runPreflight()}
                  type="button"
                >
                  執行檢查
                </button>
                <span
                  className={startTranslationDisabled ? "disabled-control-wrap" : "enabled-control-wrap"}
                title={
                  startTranslationDisabled
                    ? translationBlockingIssues.join(" ")
                    : buildTranslationStatusMessage(translationDraft)
                }
                >
                  <button
                    className="primary-button"
                    disabled={startTranslationDisabled}
                    onClick={() => void startTranslation()}
                    type="button"
                  >
                    開始翻譯
                  </button>
                </span>
          </div>

          {translationBlockingIssues.length > 0 && (
            <div className="artifact-summary-card warning-card">
              <strong>需先完成以下項目才能開始翻譯</strong>
              <ul className="plain-list">
                {translationBlockingIssues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </div>
          )}

          {translationPathValidation && (
            <article className="compact-grid">
              <h3>路徑驗證</h3>
              <div className="summary-grid">
                <div>
                  <strong>來源資料夾</strong>
                  <div className="muted-text">
                    {translationPathValidation.sourceFolder.ok
                      ? "可讀取"
                      : translationPathValidation.sourceFolder.reason}
                  </div>
                  {!translationPathValidation.sourceFolder.ok && (
                    <button className="secondary-button" onClick={pickSourceFolder} type="button">
                      重新選擇來源資料夾
                    </button>
                  )}
                </div>
                <div>
                  <strong>輸出資料夾</strong>
                  <div className="muted-text">
                    {translationPathValidation.outputFolder.ok
                      ? settingsSnapshot?.outputFolder || "可寫入"
                      : translationPathValidation.outputFolder.reason}
                  </div>
                  {!translationPathValidation.outputFolder.ok && (
                    <button className="secondary-button" onClick={openSettingsForOutputFix} type="button">
                      開啟 Settings
                    </button>
                  )}
                </div>
              </div>
            </article>
          )}

          <article className="compact-grid">
            <h3>System-generated identifiers</h3>
            <div className="summary-grid">
              <div>
                <strong>Manga ID</strong>
                <div className="muted-text">{translationIds.mangaId ?? "尚未產生"}</div>
              </div>
              <div>
                <strong>Translator ID</strong>
                <div className="muted-text">{translationIds.translatorId ?? "尚未產生"}</div>
              </div>
              <div>
                <strong>Chapter ID</strong>
                <div className="muted-text">{translationIds.chapterId ?? "選填"}</div>
              </div>
            </div>
          </article>

          {preflightResult && (
            <article className="compact-grid">
              <h3>來源檢查結果</h3>
              <div className="summary-grid">
                <div>
                  <strong>可用圖片</strong>
                  <div className="muted-text">{preflightResult.summary.acceptedCount}</div>
                </div>
                <div>
                  <strong>已轉檔</strong>
                  <div className="muted-text">{preflightResult.summary.convertedCount}</div>
                </div>
                <div>
                  <strong>已排除</strong>
                  <div className="muted-text">{preflightResult.summary.rejectedCount}</div>
                </div>
                <div>
                  <strong>排序狀態</strong>
                  <div className="muted-text">
                    {orderingDirty ? "尚未套用變更" : preflightResult.orderChanged ? "已套用自訂排序" : "使用原始排序"}
                  </div>
                </div>
              </div>

              {preflightResult.rejectedFiles.length > 0 && (
                <div className="artifact-summary-card">
                  <strong>拒絕檔案</strong>
                  <ul className="plain-list">
                    {preflightResult.rejectedFiles.map((file) => (
                      <li key={file.path}>
                        <strong>{file.fileName}</strong>: {file.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {orderedImages.length > 0 && (
                <>
                  <div className="artifact-summary-card">
                    <strong>預覽與排序</strong>
                    <p className="muted-text">
                      執行來源檢查後，可以在這裡預覽圖片並拖曳調整順序。
                    </p>
                    {orderingDirty && (
                      <p className="muted-text">
                        目前排序尚未套用，按下「套用圖片排序」後才會寫回這次檢查結果。
                      </p>
                    )}
                  </div>
                  <div className="button-row">
                    <button
                      className="secondary-button"
                      disabled={busy || !orderingDirty}
                      onClick={() => void applyCurrentOrdering()}
                      type="button"
                    >
                      套用圖片排序
                    </button>
                  </div>
                  <ul className="preflight-image-list">
                    {orderedImages.map((image, index) => (
                    <PreflightPreviewCard
                      key={image.id}
                      image={image}
                      index={index}
                      onDragStart={setDraggedImageId}
                      onDragOver={(event) => {
                        event.preventDefault();
                        if (!draggedImageId || draggedImageId === image.id) {
                          return;
                        }
                        setOrderedImageIds((current) => moveImageId(current, draggedImageId, image.id));
                      }}
                      onDrop={(targetId) => {
                        if (!draggedImageId) {
                          return;
                        }
                        setOrderedImageIds((current) => moveImageId(current, draggedImageId, targetId));
                        setDraggedImageId(null);
                      }}
                      onDragEnd={() => setDraggedImageId(null)}
                      isDragging={draggedImageId === image.id}
                    />
                  ))}
                </ul>
                </>
              )}
            </article>
          )}
        </article>
        <article className="card">
          <h2>Reference 工作已移至獨立頁面</h2>
          <p className="muted-text">
            Reference 的 extraction、OCR 結果檢視、ingestion 與報告查看，都集中在 `Reference` 頁面。
          </p>
          <ul className="plain-list">
            <li>用 `Reference` 執行 extraction 與 ingestion，避免和翻譯建立流程混在一起。</li>
            <li>用 `Reference` 檢視 OCR / extracted texts、編輯 JSON 輸出，或刪除擷取檔案。</li>
            <li>用 `Reference` 預覽 glossary、story context、style profile 等 ingestion artifacts。</li>
          </ul>
          <div className="button-row">
            <button className="secondary-button" onClick={() => setSelectedPage("reference")} type="button">
              開啟 Reference 頁面
            </button>
          </div>
        </article>

      </div>
    </section>
  );
}
