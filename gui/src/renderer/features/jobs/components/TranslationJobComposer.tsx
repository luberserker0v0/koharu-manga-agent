import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DragEvent, useEffect, useMemo, useState } from "react";
import {
  createChapter,
  createManga,
  createTranslatorProfile,
  createSourcePreflight,
  createTranslationJob,
  getMangaSeries,
  getTranslationPublications,
  inspectTranslationMemory,
  reorderSourcePreflight,
  type ChapterSummary,
  type GuiJob,
  type MangaSeriesSummary,
} from "../../../api/jobs";
import { ChapterSelector, CREATE_NEW_CHAPTER_VALUE, resolveSelectedChapter } from "../../../components/ChapterSelector";
import { resolveSelectedTranslatorProfile } from "../../../components/TranslatorProfileSelector";
import { CREATE_NEW_TRANSLATOR_VALUE } from "../../../components/TranslatorSelector";
import { ReferenceGlossaryStrategySelector } from "../../../components/ReferenceGlossaryStrategySelector";
import { getBackendConfig, getKoharuTranslationCatalog } from "../../../api/runtime";
import { pickDirectory, readSettings, validatePaths, writeSettings } from "../../../services/desktop_api";
import { type TranslationDraft, type TranslationMode, useJobsPageStore } from "../../../stores/jobs_store";
import { useLanguageStore } from "../../../stores/language_store";
import { useUiStore } from "../../../stores/ui_store";
import type {
  GuiSettings,
  PathValidationSummary,
  SourcePreflightImage,
  SourcePreflightResult,
} from "../../../types/settings";
import { buildLocalFileUrl } from "../../shared/formatters/fileUrl";
import { subscribeToJobsStream } from "../../../stream/job_stream";
import {
  DEFAULT_REFERENCE_LANGUAGE,
  normalizeReferenceLanguage,
  REFERENCE_LANGUAGE_OPTIONS,
} from "../../../constants/languages";

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
    TRANSLATION_MODE_DEFINITIONS.find((definition) => definition.value === mode) || TRANSLATION_MODE_DEFINITIONS[0]
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

function resolveSelectedOutputTranslator(selectedManga: MangaSeriesSummary | null, selectedValue: string) {
  return selectedManga?.translators.find((entry) => entry.translatorId === selectedValue) || null;
}

type ContextResolutionInput = {
  draft: TranslationDraft;
  useSeparate: boolean;
  manga: MangaSeriesSummary | null;
  outputTranslator: ReturnType<typeof resolveSelectedOutputTranslator>;
  learningProfile: ReturnType<typeof resolveSelectedTranslatorProfile>;
  chapter: ChapterSummary | null;
};

function selectedChapterFields(input: ContextResolutionInput) {
  const create = input.draft.chapterSelection === CREATE_NEW_CHAPTER_VALUE;
  return {
    chapterId: create ? toSystemId("chapter", input.draft.newChapterTitle) : input.chapter?.chapterId,
    chapterTitle: create ? sanitizeOptional(input.draft.newChapterTitle) : input.chapter?.chapterTitle || undefined,
  };
}

function resolveKnownTranslationContext(input: ContextResolutionInput): ResolvedTranslationContext | null {
  if (input.useSeparate && input.manga && input.outputTranslator && input.learningProfile) {
    if (input.learningProfile.mangaId !== input.manga.mangaId) return null;
    return {
      mangaId: input.manga.mangaId,
      mangaLabel: input.manga.label,
      translatorId: input.learningProfile.translatorId,
      translatorLabel: input.learningProfile.translatorLabel,
      referenceTranslatorId: input.outputTranslator.translatorId,
      referenceTranslatorLabel: input.outputTranslator.label,
      ...selectedChapterFields(input),
    };
  }
  if (!input.useSeparate && input.manga && input.outputTranslator) {
    return {
      mangaId: input.manga.mangaId,
      mangaLabel: input.manga.label,
      translatorId: input.outputTranslator.translatorId,
      translatorLabel: input.outputTranslator.label,
      ...selectedChapterFields(input),
    };
  }
  return null;
}

function resolveNewTranslationContext(input: ContextResolutionInput): ResolvedTranslationContext | null {
  const { draft, manga } = input;
  const translatorLabel = draft.newTranslatorLabel.trim();
  if (manga && draft.translatorSelection === CREATE_NEW_TRANSLATOR_VALUE && translatorLabel) {
    return {
      mangaId: manga.mangaId,
      mangaLabel: manga.label,
      translatorId: toSystemId("translator", translatorLabel) || "",
      translatorLabel,
      ...selectedChapterFields(input),
    };
  }
  if (draft.profileSelection !== CREATE_NEW_MANGA_VALUE) return null;
  const mangaLabel = draft.newMangaLabel.trim();
  if (!mangaLabel || draft.translatorSelection !== CREATE_NEW_TRANSLATOR_VALUE || !translatorLabel) return null;
  return {
    mangaId: toSystemId("manga", mangaLabel) || "",
    mangaLabel,
    translatorId: toSystemId("translator", translatorLabel) || "",
    translatorLabel,
    ...selectedChapterFields(input),
  };
}

function resolveProvisionalTranslationContext(input: ContextResolutionInput) {
  return resolveKnownTranslationContext(input) || resolveNewTranslationContext(input);
}

type Translate = ReturnType<typeof useLanguageStore.getState>["t"];

function providerBlockingIssues(input: {
  fetching: boolean;
  failed: boolean;
  hasProvider: boolean;
  hasModel: boolean;
  ready: boolean;
  languageSupported: boolean;
  t: Translate;
}) {
  if (input.fetching) return [input.t("jobs.translationProvider.loading")];
  if (input.failed) return [input.t("jobs.translationProvider.failed")];
  if (!input.hasProvider || !input.hasModel) return [input.t("jobs.translationProvider.select")];
  if (!input.ready) return [input.t("jobs.translationProvider.notReady")];
  return input.languageSupported ? [] : [input.t("jobs.translationTarget.unsupportedLanguage")];
}

function draftBlockingIssues(input: {
  draft: TranslationDraft;
  context: ResolvedTranslationContext | null;
  needsReference: boolean;
  settings: GuiSettings | null;
  validation: PathValidationSummary | null;
  preflight: SourcePreflightResult | null;
  dirty: boolean;
  t: Translate;
}) {
  const issues: string[] = [];
  if (!input.draft.sourceFolder.trim()) issues.push("Choose a source folder first.");
  if (!input.context?.mangaLabel?.trim()) issues.push("Choose or create a manga.");
  if (!input.context?.translatorId?.trim()) issues.push("Choose or create a translator.");
  if (input.needsReference && !input.context?.referenceTranslatorId?.trim())
    issues.push(input.t("jobs.learning.referenceRequired"));
  if (!input.draft.chapterSelection) issues.push("Choose or create a chapter.");
  if (input.draft.chapterSelection === CREATE_NEW_CHAPTER_VALUE && !input.draft.newChapterTitle.trim()) {
    issues.push("Enter a chapter title when creating a new chapter.");
  }
  if (!input.settings?.outputFolder.trim()) issues.push("Choose an output folder in Settings.");
  if (input.validation && !input.validation.outputFolder.ok)
    issues.push(`Choose a valid output folder: ${input.validation.outputFolder.reason}`);
  if (input.validation && !input.validation.sourceFolder.ok)
    issues.push(`Fix the source folder: ${input.validation.sourceFolder.reason}`);
  if (!input.preflight) issues.push("Run source preflight.");
  else if (!input.preflight.ready) issues.push("Source preflight did not produce any usable images.");
  if (input.dirty) issues.push("Run Validate again after changing translation job settings.");
  return issues;
}

function memoryBlockingIssues(input: {
  enabled: boolean;
  fetching: boolean;
  failed: boolean;
  error: unknown;
  inspection: Awaited<ReturnType<typeof inspectTranslationMemory>> | undefined;
  t: Translate;
}) {
  if (!input.enabled) return [];
  if (input.fetching) return [input.t("jobs.memory.loading")];
  if (input.failed) return [input.error instanceof Error ? input.error.message : input.t("jobs.memory.blocked")];
  return input.inspection?.ready === true ? [] : [input.inspection?.blockingReason || input.t("jobs.memory.blocked")];
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

type ComposerNotice = { message: string; tone: "info" | "success" | "error" };

function reportComposerError(
  setStatus: (value: string) => void,
  setNotice: (value: ComposerNotice | null) => void,
  status: string,
  message: string,
) {
  setStatus(status);
  setNotice({ message, tone: "error" });
}

function reportMissingPreflight(setStatus: (value: string) => void, setNotice: (value: ComposerNotice | null) => void) {
  reportComposerError(setStatus, setNotice, "No preflight result is available.", "No preflight result is available.");
}

function confirmLearningProfileCreation(publication: unknown, chapter: ChapterSummary | null, t: Translate) {
  if (!publication) return true;
  return window.confirm(
    t("jobs.outputChapter.retranslateConfirm", {
      chapter: chapter?.chapterTitle || chapter?.chapterId || "",
    }),
  );
}

async function resolveOutputFolder(
  settings: GuiSettings | null,
  setSettings: (value: GuiSettings) => void,
  setStatus: (value: string) => void,
  setNotice: (value: ComposerNotice | null) => void,
) {
  const current = settings || (await readSettings());
  setSettings(current);
  const outputDir = current.outputFolder.trim();
  if (outputDir) return outputDir;
  reportComposerError(
    setStatus,
    setNotice,
    "Open Settings and choose a valid output folder before starting translation.",
    "Choose a default output folder in Settings first.",
  );
  return null;
}

async function validatePreflightPaths(draft: TranslationDraft, settings: GuiSettings) {
  const validation = await validatePaths({
    sourceFolder: draft.sourceFolder,
    outputFolder: settings.outputFolder,
    referenceFolder: settings.referenceFolder,
    sourceRequired: true,
  });
  let error = "";
  if (!validation.sourceFolder.ok) error = `Source folder validation failed: ${validation.sourceFolder.reason}`;
  else if (!validation.outputFolder.ok) error = `Output folder validation failed: ${validation.outputFolder.reason}`;
  else if (
    draft.sourceFolder.trim() &&
    settings.outputFolder.trim() &&
    draft.sourceFolder.trim() === settings.outputFolder.trim()
  ) {
    error = "Source folder and output folder must be different.";
  }
  return { validation, error };
}

function translationStartError(context: ResolvedTranslationContext | null, preflight: SourcePreflightResult | null) {
  if (!context?.mangaId || !context.translatorId) {
    return ["Manga and translator profile are required.", "Choose or create a manga + translator profile first."];
  }
  if (!preflight) return ["Run source preflight before starting translation.", "Please validate source images first."];
  if (!preflight.ready) {
    return ["Source preflight did not produce any usable images.", "No usable images are ready for translation."];
  }
  return null;
}

async function resolveNewProfile(context: ResolvedTranslationContext, draft: TranslationDraft, separate: boolean) {
  if (!separate && draft.profileSelection === CREATE_NEW_MANGA_VALUE) {
    const manga = await createManga({ label: context.mangaLabel });
    const translator = await createTranslatorProfile(manga.manga.mangaId, { label: context.translatorLabel });
    return { ...context, mangaId: manga.manga.mangaId, translatorId: translator.translator.translatorId };
  }
  if (!separate && draft.translatorSelection === CREATE_NEW_TRANSLATOR_VALUE) {
    const translator = await createTranslatorProfile(context.mangaId, { label: context.translatorLabel });
    return {
      ...context,
      translatorId: translator.translator.translatorId,
      translatorLabel: translator.translator.label,
    };
  }
  return context;
}

async function resolveNewChapter(context: ResolvedTranslationContext, draft: TranslationDraft) {
  if (draft.chapterSelection !== CREATE_NEW_CHAPTER_VALUE) return context;
  const created = await createChapter(context.mangaId, context.translatorId, {
    chapterTitle: sanitizeOptional(draft.newChapterTitle) || null,
  });
  return { ...context, chapterId: created.chapter.chapterId, chapterTitle: created.chapter.chapterTitle || undefined };
}

async function materializeTranslationContext(
  context: ResolvedTranslationContext,
  draft: TranslationDraft,
  separate: boolean,
  refresh: () => Promise<void>,
) {
  const profile = await resolveNewProfile(context, draft, separate);
  const resolved = await resolveNewChapter(profile, draft);
  if (resolved !== context) await refresh();
  return resolved;
}

function buildTranslationJobInput(
  draft: TranslationDraft,
  context: ResolvedTranslationContext,
  preflightId: string,
  outputDir: string,
  mode: TranslationModeDefinition,
  qualityCheck: boolean,
) {
  return {
    sourceFolder: draft.sourceFolder.trim(),
    translationMode: draft.translationMode,
    sourcePreflightId: preflightId,
    targetLanguage: normalizeReferenceLanguage(draft.targetLanguage),
    translationTarget: { providerId: draft.translationProviderId, modelId: draft.translationModelId },
    outputDir,
    mangaId: context.mangaId,
    mangaLabel: sanitizeOptional(context.mangaLabel),
    translatorId: context.translatorId,
    translatorLabel: sanitizeOptional(context.translatorLabel),
    referenceTranslatorId: context.referenceTranslatorId,
    referenceTranslatorLabel: sanitizeOptional(context.referenceTranslatorLabel || ""),
    chapterId: context.chapterId,
    sourceChapterId: sanitizeOptional(draft.sourceChapterSelection),
    chapterTitle: context.chapterTitle,
    chapterLabel: context.chapterTitle,
    glossaryMode: mode.useReference ? draft.glossaryMode : undefined,
    qualityCheck,
  };
}

async function prepareTranslationJobInput(params: {
  context: ResolvedTranslationContext;
  draft: TranslationDraft;
  separate: boolean;
  refresh: () => Promise<void>;
  preflightId: string;
  outputDir: string;
  mode: TranslationModeDefinition;
  qualityCheck: boolean;
}) {
  const context = await materializeTranslationContext(params.context, params.draft, params.separate, params.refresh);
  return buildTranslationJobInput(
    params.draft,
    context,
    params.preflightId,
    params.outputDir,
    params.mode,
    params.qualityCheck,
  );
}
type ChecklistInput = {
  translationDraft: TranslationDraft;
  resolvedMangaLabel: string;
  resolvedTranslatorLabel: string;
  modeDefinition: TranslationModeDefinition;
  settingsSnapshot: GuiSettings | null;
  translationPathValidation: PathValidationSummary | null;
  preflightResult: SourcePreflightResult | null;
};

function buildTranslationChecklist(input: ChecklistInput) {
  const { translationDraft, resolvedMangaLabel, resolvedTranslatorLabel, modeDefinition } = input;
  const { settingsSnapshot, translationPathValidation, preflightResult } = input;
  const sourceFolder = translationDraft.sourceFolder.trim();
  const mangaTitle = resolvedMangaLabel.trim();
  const translatorTitle = resolvedTranslatorLabel.trim();
  const outputDetail = translationPathValidation?.outputFolder.ok
    ? settingsSnapshot?.outputFolder || "可寫入"
    : translationPathValidation?.outputFolder.reason || "尚未設定";
  return [
    { label: "翻譯模式", done: Boolean(modeDefinition.value), detail: modeDefinition.label },
    { label: "來源資料夾", done: Boolean(sourceFolder), detail: sourceFolder || "尚未選擇" },
    {
      label: "作品 / 譯者",
      done: Boolean(mangaTitle && translatorTitle),
      detail: mangaTitle && translatorTitle ? `${mangaTitle} / ${translatorTitle}` : "尚未指定",
    },
    {
      label: "輸出資料夾",
      done: Boolean(settingsSnapshot?.outputFolder.trim()) && Boolean(translationPathValidation?.outputFolder.ok),
      detail: outputDetail,
    },
    {
      label: "來源檢查",
      done: Boolean(preflightResult?.ready),
      detail: preflightResult ? `${preflightResult.summary.acceptedCount} 張可用圖片` : "尚未執行",
    },
  ];
}

type ExtendedChecklistInput = ChecklistInput & {
  t: Translate;
  providerName?: string;
  modelName?: string;
  providerReady: boolean;
  languageSupported: boolean;
  catalogFetching: boolean;
  memoryEnabled: boolean;
  memoryFetching: boolean;
  inspection: Awaited<ReturnType<typeof inspectTranslationMemory>> | undefined;
};

function providerChecklistItem(input: ExtendedChecklistInput) {
  const selected = input.providerName && input.modelName;
  return {
    label: input.t("jobs.translationProvider.label"),
    done: input.providerReady && input.languageSupported,
    detail: selected
      ? `${input.providerName} / ${input.modelName}`
      : input.t(input.catalogFetching ? "jobs.translationProvider.loading" : "jobs.translationProvider.select"),
  };
}

function memoryChecklistItem(input: ExtendedChecklistInput) {
  if (!input.memoryEnabled) return null;
  const inspection = input.inspection;
  return {
    label: inspection?.ready ? input.t("jobs.memory.ready") : input.t("jobs.memory.blocked"),
    done: inspection?.ready === true,
    detail: input.memoryFetching
      ? input.t("jobs.memory.loading")
      : inspection?.blockingReason ||
        inspection?.chapterMapping?.sourceChapterTitle ||
        inspection?.chapterMapping?.sourceChapterId ||
        input.t("jobs.memory.blocked"),
  };
}

function buildExtendedChecklist(input: ExtendedChecklistInput) {
  const items = buildTranslationChecklist(input);
  items.splice(1, 0, providerChecklistItem(input));
  const memory = memoryChecklistItem(input);
  if (memory) items.push(memory);
  return items;
}

type PreflightPreviewCardProps = {
  image: SourcePreflightImage;
  index: number;
  onDragStart: (imageId: string) => void;
  onDragOver: (event: DragEvent<HTMLLIElement>) => void;
  onDrop: (targetId: string) => void;
  onDragEnd: () => void;
  isDragging: boolean;
};

function PreflightPreviewCard(props: PreflightPreviewCardProps) {
  const { image, index, onDragStart, onDragOver, onDrop, onDragEnd, isDragging } = props;
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

type SetTranslationDraft = ReturnType<typeof useJobsPageStore.getState>["setTranslationDraft"];

function useSettingsSnapshotEffect(setSettings: (value: GuiSettings) => void) {
  useEffect(() => {
    readSettings()
      .then(setSettings)
      .catch(() => {});
  }, [setSettings]);
}

function useDefaultTargetEffect(
  catalog: Awaited<ReturnType<typeof getKoharuTranslationCatalog>> | undefined,
  config: Awaited<ReturnType<typeof getBackendConfig>> | undefined,
  setDraft: SetTranslationDraft,
) {
  useEffect(() => {
    if (!catalog || !config) return;
    setDraft((current) => {
      if (current.translationProviderId && current.translationModelId) return current;
      const configured = config.translation?.defaultTarget;
      const configuredProvider = catalog.providers.find((provider) => provider.providerId === configured?.providerId);
      const provider =
        configuredProvider?.status === "ready"
          ? configuredProvider
          : catalog.providers.find((entry) => entry.status === "ready");
      const model = provider?.models.find((entry) => entry.modelId === configured?.modelId) || provider?.models[0];
      return provider && model
        ? { ...current, translationProviderId: provider.providerId, translationModelId: model.modelId }
        : current;
    });
  }, [catalog, config, setDraft]);
}

function useKnowledgeCommitRefreshEffect(queryClient: ReturnType<typeof useQueryClient>) {
  useEffect(
    () =>
      subscribeToJobsStream({
        onEvent: (message) => {
          if (message.kind !== "job" || !message.job || typeof message.job !== "object") return;
          const job = message.job as GuiJob;
          if (job.type !== "translation_knowledge_commit" || !["succeeded", "failed", "canceled"].includes(job.status))
            return;
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: ["translationMemoryInspection"] }),
            queryClient.invalidateQueries({ queryKey: ["mangaSeries"] }),
          ]);
        },
      }),
    [queryClient],
  );
}

function useCenterNoticeEffect(notice: ComposerNotice | null, setNotice: (value: ComposerNotice | null) => void) {
  useEffect(() => {
    if (!notice) return;
    const timeoutId = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timeoutId);
  }, [notice, setNotice]);
}

function resolveCoreProfiles(draft: TranslationDraft, series: MangaSeriesSummary[]) {
  const selectedManga = resolveSelectedManga(draft.profileSelection, series);
  return {
    selectedManga,
    selectedOutputTranslator: resolveSelectedOutputTranslator(selectedManga, draft.translatorSelection),
    selectedLearningProfile: resolveSelectedTranslatorProfile(draft.learningProfileSelection, series),
    usesSeparateReferenceProfile: getTranslationModeDefinition(draft.translationMode).useReference,
  };
}

function filterReferenceProfileSeries(series: MangaSeriesSummary[]) {
  return series
    .map((manga) => ({
      ...manga,
      translators: (manga.translators || []).filter(
        (translator) =>
          translator.translatorId !== "translator_original" && translator.profileKind !== "learning_clone",
      ),
    }))
    .filter((manga) => manga.translators.length > 0);
}

function resolveOutputProfile(core: ReturnType<typeof resolveCoreProfiles>) {
  if (core.usesSeparateReferenceProfile) return core.selectedLearningProfile;
  const translator = core.selectedOutputTranslator;
  const manga = core.selectedManga;
  return translator && manga
    ? {
        mangaId: manga.mangaId,
        mangaLabel: manga.label,
        translatorId: translator.translatorId,
        translatorLabel: translator.label,
      }
    : null;
}

function resolveProfileCollections(series: MangaSeriesSummary[], core: ReturnType<typeof resolveCoreProfiles>) {
  const manga = series.find((entry) => entry.mangaId === core.selectedManga?.mangaId);
  const learningProfiles = (manga?.translators || []).filter(
    (entry) =>
      entry.profileKind === "learning_clone" &&
      entry.styleSourceTranslatorId === core.selectedOutputTranslator?.translatorId,
  );
  const output = resolveOutputProfile(core);
  const outputManga = series.find((entry) => entry.mangaId === output?.mangaId);
  const translator = outputManga?.translators.find((entry) => entry.translatorId === output?.translatorId);
  const chapters = (translator?.chapters || []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
  const original = manga?.translators.find((entry) => entry.translatorId === "translator_original");
  const sourceChapters = (original?.chapters || []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
  return {
    availableLearningProfiles: learningProfiles,
    availableChapters: chapters,
    availableSourceChapters: sourceChapters,
  };
}

function resolveComposerSelection(draft: TranslationDraft, series: MangaSeriesSummary[]) {
  const core = resolveCoreProfiles(draft, series);
  const collections = resolveProfileCollections(series, core);
  const selectedChapter = resolveSelectedChapter(draft.chapterSelection, collections.availableChapters);
  const context = resolveProvisionalTranslationContext({
    draft,
    useSeparate: core.usesSeparateReferenceProfile,
    manga: core.selectedManga,
    outputTranslator: core.selectedOutputTranslator,
    learningProfile: core.selectedLearningProfile,
    chapter: selectedChapter,
  });
  return {
    ...core,
    ...collections,
    selectedChapter,
    provisionalTranslationContext: context,
    referenceProfileSeries: filterReferenceProfileSeries(series),
  };
}

function resolveTranslationTarget(
  draft: TranslationDraft,
  catalog: Awaited<ReturnType<typeof getKoharuTranslationCatalog>> | undefined,
) {
  const translationModeDefinition = getTranslationModeDefinition(draft.translationMode);
  const translationProviders = catalog?.providers || [];
  const selectedTranslationProvider =
    translationProviders.find((provider) => provider.providerId === draft.translationProviderId) || null;
  const selectedTranslationModel =
    selectedTranslationProvider?.models.find((model) => model.modelId === draft.translationModelId) || null;
  const normalizedTargetLanguage = normalizeReferenceLanguage(draft.targetLanguage);
  const translationTargetSupportsLanguage = Boolean(
    selectedTranslationModel &&
      (!selectedTranslationModel.languages.length ||
        selectedTranslationModel.languages.includes(normalizedTargetLanguage)),
  );
  return {
    translationModeDefinition,
    translationProviders,
    selectedTranslationProvider,
    selectedTranslationModel,
    normalizedTargetLanguage,
    translationTargetSupportsLanguage,
    consistencyCheckEnabled: isConsistencyCheckEnabled(draft),
  };
}

function buildMemoryInspectionInput(
  draft: TranslationDraft,
  context: ResolvedTranslationContext | null,
  qualityCheck: boolean,
) {
  return {
    translationMode: draft.translationMode,
    qualityCheck,
    mangaId: context?.mangaId,
    translatorId: context?.translatorId,
    referenceTranslatorId: context?.referenceTranslatorId,
    chapterId: context?.chapterId,
    chapterTitle: context?.chapterTitle,
    sourceChapterId: sanitizeOptional(draft.sourceChapterSelection),
    glossaryMode: draft.glossaryMode,
    targetLanguage: normalizeReferenceLanguage(draft.targetLanguage),
    translationTarget:
      draft.translationProviderId && draft.translationModelId
        ? { providerId: draft.translationProviderId, modelId: draft.translationModelId }
        : undefined,
  };
}

function useTranslationMemoryInspection(
  draft: TranslationDraft,
  context: ResolvedTranslationContext | null,
  qualityCheck: boolean,
) {
  const input = buildMemoryInspectionInput(draft, context, qualityCheck);
  return useQuery({
    queryKey: [
      "translationMemoryInspection",
      draft.translationMode,
      context?.mangaId,
      context?.translatorId,
      context?.referenceTranslatorId,
      context?.chapterId,
      draft.sourceChapterSelection,
      draft.glossaryMode,
      draft.translationProviderId,
      draft.translationModelId,
      qualityCheck,
    ],
    queryFn: () => inspectTranslationMemory(input),
    enabled: draft.translationMode !== "quick" && Boolean(context?.mangaId && context?.translatorId),
    retry: false,
    refetchOnMount: "always",
  });
}

function useTranslationPublications(context: ResolvedTranslationContext | null) {
  return useQuery({
    queryKey: ["translationPublications", context?.mangaId, context?.translatorId],
    queryFn: () => getTranslationPublications(context!.mangaId, context!.translatorId),
    enabled: Boolean(context?.mangaId && context?.translatorId),
  });
}

function publicationStatus(
  publication: Awaited<ReturnType<typeof getTranslationPublications>>["chapters"][string] | undefined,
  t: Translate,
) {
  const active = publication?.revisions.find((revision) => revision.revisionId === publication.activeRevisionId);
  if (!active) return t("jobs.outputChapter.status.untranslated");
  if (["pending", "queued"].includes(active.knowledgeStatus)) return t("jobs.outputChapter.status.learning");
  const partial =
    active.completenessStatus === "incomplete" ||
    active.qualityOutcome === "partial" ||
    active.knowledgeOutcome === "partial";
  return t(partial ? "jobs.outputChapter.status.translatedPartial" : "jobs.outputChapter.status.translated");
}

function buildPublicationLabels(
  chapters: ChapterSummary[],
  publications: Awaited<ReturnType<typeof getTranslationPublications>> | undefined,
  t: Translate,
) {
  return Object.fromEntries(
    chapters.map((chapter) => [chapter.chapterId, publicationStatus(publications?.chapters[chapter.chapterId], t)]),
  );
}

type JobsState = ReturnType<typeof useJobsPageStore.getState>;
type UiState = ReturnType<typeof useUiStore.getState>;
type MutationContext = {
  queryClient: ReturnType<typeof useQueryClient>;
  setNotice: (value: ComposerNotice | null) => void;
  setStatus: JobsState["setStatus"];
  setPreflightResult: JobsState["setPreflightResult"];
  setOrderedImageIds: JobsState["setOrderedImageIds"];
  setSelectedJobId: UiState["setSelectedJobId"];
  setSelectedMangaId: UiState["setSelectedMangaId"];
  setSelectedTranslatorId: UiState["setSelectedTranslatorId"];
};

function selectComposerJob(context: MutationContext, job: GuiJob) {
  context.setSelectedJobId(job.id);
  const mangaId = typeof job.payload.mangaId === "string" ? job.payload.mangaId.trim() : "";
  const translatorId = typeof job.payload.translatorId === "string" ? job.payload.translatorId.trim() : "";
  if (mangaId) context.setSelectedMangaId(mangaId);
  if (translatorId) context.setSelectedTranslatorId(translatorId);
}

async function completeComposerJob(context: MutationContext, job: GuiJob, message: string) {
  selectComposerJob(context, job);
  context.setStatus(`${message} Job 已建立成功，可到 Job List 查看。`);
  context.setNotice({ message, tone: "success" });
  await context.queryClient.invalidateQueries({ queryKey: ["jobs"] });
}

function useTranslationMutation(context: MutationContext) {
  return useMutation({
    mutationFn: createTranslationJob,
    onSuccess: (job) => completeComposerJob(context, job, `Translation job created: ${job.id}`),
    onError: () => {
      context.setStatus("Failed to create translation job.");
      context.setNotice({ message: "建立翻譯 Job 失敗。", tone: "error" });
    },
  });
}

function useSourcePreflightMutation(context: MutationContext) {
  return useMutation({
    mutationFn: createSourcePreflight,
    onSuccess: (result) => {
      context.setPreflightResult(result);
      context.setOrderedImageIds(result.images.map((image) => image.id));
      context.setStatus(`Source preflight ready: ${result.summary.acceptedCount} images accepted.`);
      context.setNotice({
        message: `Validate completed: ${result.summary.acceptedCount} usable images ready.`,
        tone: "success",
      });
    },
    onError: () => {
      context.setStatus("Failed to preflight source images.");
      context.setNotice({ message: "Validate failed.", tone: "error" });
    },
  });
}

function useReorderMutation(context: MutationContext) {
  return useMutation({
    mutationFn: ({ preflightId, orderedIds }: { preflightId: string; orderedIds: string[] }) =>
      reorderSourcePreflight(preflightId, orderedIds),
    onSuccess: (result) => {
      context.setPreflightResult(result);
      context.setOrderedImageIds(result.images.map((image) => image.id));
      context.setStatus("Source image order applied.");
      context.setNotice({ message: "Image order applied.", tone: "success" });
    },
    onError: () => {
      context.setStatus("Failed to apply source image order.");
      context.setNotice({ message: "Apply image order failed.", tone: "error" });
    },
  });
}

function useComposerMutations(context: MutationContext, creatingProfile: boolean) {
  const translationMutation = useTranslationMutation(context);
  const sourcePreflightMutation = useSourcePreflightMutation(context);
  const reorderMutation = useReorderMutation(context);
  const busy =
    translationMutation.isPending || sourcePreflightMutation.isPending || reorderMutation.isPending || creatingProfile;
  return { translationMutation, sourcePreflightMutation, reorderMutation, busy };
}

function useComposerQueries() {
  const backendConfigQuery = useQuery({ queryKey: ["backend-config"], queryFn: getBackendConfig, retry: false });
  const translationCatalogQuery = useQuery({
    queryKey: ["koharu-translation-catalog"],
    queryFn: getKoharuTranslationCatalog,
    retry: false,
  });
  const mangaSeriesQuery = useQuery({
    queryKey: ["mangaSeries"],
    queryFn: getMangaSeries,
    refetchOnMount: "always",
  });
  return { backendConfigQuery, translationCatalogQuery, mangaSeriesQuery };
}

function useComposerLocalState() {
  const [settingsSnapshot, setSettingsSnapshot] = useState<GuiSettings | null>(null);
  const [draggedImageId, setDraggedImageId] = useState<string | null>(null);
  const [creatingLearningProfile, setCreatingLearningProfile] = useState(false);
  const [centerNotice, setCenterNotice] = useState<{
    message: string;
    tone: "info" | "success" | "error";
  } | null>(null);
  return {
    settingsSnapshot, setSettingsSnapshot, draggedImageId, setDraggedImageId,
    creatingLearningProfile, setCreatingLearningProfile, centerNotice, setCenterNotice,
  };
}

function useComposerJobsState() {
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
  return {
    translationDraft, setTranslationDraft, translationPathValidation, setTranslationPathValidation,
    preflightResult, setPreflightResult, orderedImageIds, setOrderedImageIds, status, setStatus,
    lastPickedSourceFolder, setLastPickedSourceFolder, preflightDraftFingerprint,
    setPreflightDraftFingerprint, clearPreflightState,
  };
}

function useComposerUiState() {
  const setSelectedJobId = useUiStore((state) => state.setSelectedJobId);
  const setSelectedMangaId = useUiStore((state) => state.setSelectedMangaId);
  const setSelectedTranslatorId = useUiStore((state) => state.setSelectedTranslatorId);
  const setSelectedPage = useUiStore((state) => state.setSelectedPage);
  return { setSelectedJobId, setSelectedMangaId, setSelectedTranslatorId, setSelectedPage };
}

function useComposerFoundation() {
  const t = useLanguageStore((state) => state.t);
  const queryClient = useQueryClient();
  const queries = useComposerQueries();
  const jobs = useComposerJobsState();
  const local = useComposerLocalState();
  const ui = useComposerUiState();
  useSettingsSnapshotEffect(local.setSettingsSnapshot);
  useDefaultTargetEffect(queries.translationCatalogQuery.data, queries.backendConfigQuery.data, jobs.setTranslationDraft);
  useKnowledgeCommitRefreshEffect(queryClient);
  useCenterNoticeEffect(local.centerNotice, local.setCenterNotice);
  const mutations = useComposerMutations({
    queryClient, setNotice: local.setCenterNotice, setStatus: jobs.setStatus,
    setPreflightResult: jobs.setPreflightResult, setOrderedImageIds: jobs.setOrderedImageIds,
    setSelectedJobId: ui.setSelectedJobId, setSelectedMangaId: ui.setSelectedMangaId,
    setSelectedTranslatorId: ui.setSelectedTranslatorId,
  }, local.creatingLearningProfile);
  return { t, queryClient, ...queries, ...jobs, ...local, ...ui, ...mutations };
}

type ReadinessInput = {
  draft: TranslationDraft; context: ResolvedTranslationContext | null; settings: GuiSettings | null;
  validation: PathValidationSummary | null; preflight: SourcePreflightResult | null; orderedImageIds: string[];
  preflightFingerprint: string | null; target: ReturnType<typeof resolveTranslationTarget>;
  catalogFetching: boolean; catalogError: boolean; memoryFetching: boolean; memoryError: boolean;
  memoryErrorValue: unknown; inspection: Awaited<ReturnType<typeof inspectTranslationMemory>> | undefined; t: Translate;
};

function resolvePreflightState(input: ReadinessInput) {
  const imageMap = new Map((input.preflight?.images || []).map((image) => [image.id, image]));
  const orderedImages = input.orderedImageIds.map((id) => imageMap.get(id))
    .filter((image): image is SourcePreflightImage => Boolean(image));
  const orderingDirty = Boolean(input.preflight
    && orderingFingerprint(input.orderedImageIds) !== input.preflight.currentFingerprint);
  const draftDirty = Boolean(input.preflight && input.preflightFingerprint
    && input.preflightFingerprint !== translationDraftFingerprint(input.draft));
  return { orderedImages, orderingDirty, draftDirty };
}

function collectReadinessIssues(input: ReadinessInput, draftDirty: boolean) {
  return [
    ...providerBlockingIssues({ fetching: input.catalogFetching, failed: input.catalogError,
      hasProvider: Boolean(input.target.selectedTranslationProvider),
      hasModel: Boolean(input.target.selectedTranslationModel),
      ready: input.target.selectedTranslationProvider?.status === "ready",
      languageSupported: input.target.translationTargetSupportsLanguage, t: input.t }),
    ...draftBlockingIssues({ draft: input.draft, context: input.context,
      needsReference: input.target.translationModeDefinition.useReference, settings: input.settings,
      validation: input.validation, preflight: input.preflight, dirty: draftDirty, t: input.t }),
    ...memoryBlockingIssues({ enabled: input.draft.translationMode !== "quick", fetching: input.memoryFetching,
      failed: input.memoryError, error: input.memoryErrorValue, inspection: input.inspection, t: input.t }),
  ];
}

function buildReadinessChecklist(input: ReadinessInput) {
  return buildExtendedChecklist({
    translationDraft: input.draft, resolvedMangaLabel: input.context?.mangaLabel || "",
    resolvedTranslatorLabel: input.context?.translatorLabel || "",
    modeDefinition: input.target.translationModeDefinition, settingsSnapshot: input.settings,
    translationPathValidation: input.validation, preflightResult: input.preflight, t: input.t,
    providerName: input.target.selectedTranslationProvider?.name, modelName: input.target.selectedTranslationModel?.name,
    providerReady: input.target.selectedTranslationProvider?.status === "ready",
    languageSupported: input.target.translationTargetSupportsLanguage, catalogFetching: input.catalogFetching,
    memoryEnabled: input.draft.translationMode !== "quick", memoryFetching: input.memoryFetching,
    inspection: input.inspection,
  });
}

function resolveComposerReadiness(input: ReadinessInput) {
  const preflight = resolvePreflightState(input);
  return { ...preflight, translationChecklist: buildReadinessChecklist(input),
    translationBlockingIssues: collectReadinessIssues(input, preflight.draftDirty) };
}

type ComposerFoundation = ReturnType<typeof useComposerFoundation>;

function useComposerSelectionState(foundation: ComposerFoundation) {
  const mangaSeriesOptions = useMemo(
    () => foundation.mangaSeriesQuery.data?.series || [],
    [foundation.mangaSeriesQuery.data],
  );
  const selection = useMemo(
    () => resolveComposerSelection(foundation.translationDraft, mangaSeriesOptions),
    [foundation.translationDraft, mangaSeriesOptions],
  );
  const publications = useTranslationPublications(selection.provisionalTranslationContext);
  const chapterPublicationStatusLabels = useMemo(
    () => buildPublicationLabels(selection.availableChapters, publications.data, foundation.t),
    [selection.availableChapters, publications.data, foundation.t],
  );
  const selectedActivePublication = selection.selectedChapter
    ? publications.data?.chapters[selection.selectedChapter.chapterId] || null
    : null;
  return { ...selection, mangaSeriesOptions, publications, chapterPublicationStatusLabels, selectedActivePublication };
}

type ComposerSelectionState = ReturnType<typeof useComposerSelectionState>;

function useComposerTranslationState(foundation: ComposerFoundation, selection: ComposerSelectionState) {
  const target = resolveTranslationTarget(foundation.translationDraft, foundation.translationCatalogQuery.data);
  const memory = useTranslationMemoryInspection(
    foundation.translationDraft,
    selection.provisionalTranslationContext,
    target.consistencyCheckEnabled,
  );
  const readiness = resolveComposerReadiness({
    draft: foundation.translationDraft, context: selection.provisionalTranslationContext,
    settings: foundation.settingsSnapshot, validation: foundation.translationPathValidation,
    preflight: foundation.preflightResult, orderedImageIds: foundation.orderedImageIds,
    preflightFingerprint: foundation.preflightDraftFingerprint, target,
    catalogFetching: foundation.translationCatalogQuery.isFetching,
    catalogError: foundation.translationCatalogQuery.isError, memoryFetching: memory.isFetching,
    memoryError: memory.isError, memoryErrorValue: memory.error, inspection: memory.data, t: foundation.t,
  });
  const translationIds = {
    mangaId: selection.provisionalTranslationContext?.mangaId,
    translatorId: selection.provisionalTranslationContext?.translatorId,
    chapterId: selection.provisionalTranslationContext?.chapterId,
  };
  const startTranslationDisabled = foundation.busy || !selection.provisionalTranslationContext?.mangaLabel?.trim()
    || !foundation.preflightResult?.ready || readiness.translationBlockingIssues.length > 0;
  return { ...target, ...readiness, memory, translationIds, startTranslationDisabled };
}

type ComposerTranslationState = ReturnType<typeof useComposerTranslationState>;
type ComposerContext = ComposerFoundation & ComposerSelectionState & ComposerTranslationState;

function createRunPreflight(context: ComposerContext) {
  return async () => {
    if (!context.translationDraft.sourceFolder.trim()) {
      context.setStatus("Please choose a source folder first.");
      return;
    }
    const settings = context.settingsSnapshot || (await readSettings());
    context.setSettingsSnapshot(settings);
    const { validation, error } = await validatePreflightPaths(context.translationDraft, settings);
    context.setTranslationPathValidation(validation);
    if (error) return context.setStatus(error);
    await context.sourcePreflightMutation.mutateAsync({ sourceFolder: context.translationDraft.sourceFolder.trim() });
    context.setPreflightDraftFingerprint(translationDraftFingerprint(context.translationDraft));
  };
}

function createApplyCurrentOrdering(context: ComposerContext) {
  return async () => {
    if (!context.preflightResult || !context.orderingDirty) return context.preflightResult;
    return context.reorderMutation.mutateAsync({
      preflightId: context.preflightResult.preflightId,
      orderedIds: context.orderedImageIds,
    });
  };
}

function createStartTranslation(context: ComposerContext, applyCurrentOrdering: () => Promise<SourcePreflightResult | null>) {
  return async () => {
    const error = translationStartError(context.provisionalTranslationContext, context.preflightResult);
    if (error) return reportComposerError(context.setStatus, context.setCenterNotice, error[0], error[1]);
    const activePreflight = context.orderingDirty ? await applyCurrentOrdering() : context.preflightResult;
    if (!activePreflight) return reportMissingPreflight(context.setStatus, context.setCenterNotice);
    const outputDir = await resolveOutputFolder(
      context.settingsSnapshot, context.setSettingsSnapshot, context.setStatus, context.setCenterNotice,
    );
    if (!outputDir) return;
    context.setCenterNotice({ message: buildTranslationStatusMessage(context.translationDraft), tone: "info" });
    const input = await prepareTranslationJobInput({
      context: context.provisionalTranslationContext!, draft: context.translationDraft,
      separate: context.usesSeparateReferenceProfile,
      refresh: () => context.queryClient.invalidateQueries({ queryKey: ["mangaSeries"] }),
      preflightId: activePreflight.preflightId, outputDir, mode: context.translationModeDefinition,
      qualityCheck: context.consistencyCheckEnabled,
    });
    await context.translationMutation.mutateAsync(input);
  };
}

function createLearningProfileAction(context: ComposerContext) {
  return async () => {
    const label = context.translationDraft.newLearningTranslatorLabel.trim();
    if (!context.selectedManga || !context.selectedOutputTranslator || !label) {
      context.setStatus(context.t("jobs.learning.profile.createMissing"));
      return;
    }
    if (!confirmLearningProfileCreation(context.selectedActivePublication, context.selectedChapter, context.t)) return;
    context.setCreatingLearningProfile(true);
    try {
      const created = await createTranslatorProfile(context.selectedManga.mangaId, {
        label, language: normalizeReferenceLanguage(context.translationDraft.targetLanguage),
        styleSourceTranslatorId: context.selectedOutputTranslator.translatorId,
      });
      await context.queryClient.invalidateQueries({ queryKey: ["mangaSeries"] });
      context.setTranslationDraft((current) => ({ ...current,
        learningProfileSelection: `${context.selectedManga!.mangaId}::${created.translator.translatorId}`,
        newLearningTranslatorLabel: "", chapterSelection: "" }));
      context.setStatus(context.t("jobs.learning.profile.created"));
    } catch (error) {
      context.setStatus(error instanceof Error ? error.message : context.t("jobs.learning.profile.createFailed"));
    } finally {
      context.setCreatingLearningProfile(false);
    }
  };
}

function preferredSourceFolder(context: ComposerContext) {
  return context.translationDraft.sourceFolder || context.lastPickedSourceFolder
    || context.settingsSnapshot?.lastPickedSourceFolder || context.settingsSnapshot?.referenceFolder
    || context.settingsSnapshot?.outputFolder || undefined;
}

function applyPickedSourceFolder(context: ComposerContext, path: string) {
  context.setTranslationDraft((current) => ({ ...current, sourceFolder: path }));
  context.setLastPickedSourceFolder(path);
  context.setSettingsSnapshot((current) => (current ? { ...current, lastPickedSourceFolder: path } : current));
  void writeSettings({ lastPickedSourceFolder: path });
  context.clearPreflightState();
}

function createPickSourceFolderAction(context: ComposerContext) {
  return async () => {
    try {
      const result = await pickDirectory({ title: "Select source folder", defaultPath: preferredSourceFolder(context) });
      if (!result.canceled && result.path) applyPickedSourceFolder(context, result.path);
    } catch (error) {
      context.setStatus(error instanceof Error ? error.message : "Failed to choose source folder.");
    }
  };
}

function createComposerActions(context: ComposerContext) {
  const applyCurrentOrdering = createApplyCurrentOrdering(context);
  const openSettingsForOutputFix = () => {
    context.setSelectedPage("settings");
    context.setStatus("Open Settings and choose a valid output folder before starting translation.");
  };
  return {
    applyCurrentOrdering,
    runPreflight: createRunPreflight(context),
    startTranslation: createStartTranslation(context, applyCurrentOrdering),
    createLearningProfile: createLearningProfileAction(context),
    pickSourceFolder: createPickSourceFolderAction(context),
    openSettingsForOutputFix,
  };
}

function useTranslationJobComposer() {
  const foundation = useComposerFoundation();
  const selection = useComposerSelectionState(foundation);
  const translation = useComposerTranslationState(foundation, selection);
  const context = { ...foundation, ...selection, ...translation };
  const actions = createComposerActions(context);
  return { ...context, ...actions };
}
type TranslationJobComposerController = ReturnType<typeof useTranslationJobComposer>;

function SourceFolderField(c: TranslationJobComposerController) {
  const change = (nextValue: string) => {
    c.setTranslationDraft((current) => ({ ...current, sourceFolder: nextValue }));
    if (c.preflightResult?.sourceFolder !== nextValue) c.clearPreflightState();
  };
  return (
    <label>
      <span>來源資料夾</span>
      <small className="muted-text">必填。系統只會讀取這個資料夾，並在其他位置建立處理用檔案。</small>
      <div className="field-with-action">
        <input value={c.translationDraft.sourceFolder} onChange={(event) => change(event.currentTarget.value)} />
        <button className="secondary-button" onClick={c.pickSourceFolder} type="button">
          瀏覽
        </button>
      </div>
    </label>
  );
}

function TargetLanguageField(c: TranslationJobComposerController) {
  const change = (targetLanguage: string) => c.setTranslationDraft((current) => ({ ...current, targetLanguage }));
  return (
    <label>
      <span>{c.t("jobs.targetLanguage.label")}</span>
      <select
        value={normalizeReferenceLanguage(c.translationDraft.targetLanguage || DEFAULT_REFERENCE_LANGUAGE)}
        onChange={(event) => change(event.currentTarget.value)}
      >
        {REFERENCE_LANGUAGE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function providerPlaceholder(c: TranslationJobComposerController) {
  if (c.translationCatalogQuery.isFetching) return c.t("jobs.translationProvider.loading");
  return c.translationCatalogQuery.isError
    ? c.t("jobs.translationProvider.failed")
    : c.t("jobs.translationProvider.select");
}

function TranslationProviderField(c: TranslationJobComposerController) {
  const change = (providerId: string) => {
    const provider = c.translationProviders.find((entry) => entry.providerId === providerId);
    const model =
      provider?.models.find((item) => !item.languages.length || item.languages.includes(c.normalizedTargetLanguage)) ||
      provider?.models[0];
    c.setTranslationDraft((current) => ({
      ...current,
      translationProviderId: providerId,
      translationModelId: model?.modelId || "",
    }));
  };
  return (
    <label>
      <span>{c.t("jobs.translationProvider.label")}</span>
      <small className="muted-text">{c.t("jobs.translationProvider.help")}</small>
      <select value={c.translationDraft.translationProviderId} onChange={(event) => change(event.currentTarget.value)}>
        <option value="">{providerPlaceholder(c)}</option>
        {c.translationProviders.map((provider) => (
          <option key={provider.providerId} value={provider.providerId}>
            {provider.name}
            {provider.status === "ready" ? "" : ` — ${c.t("jobs.translationProvider.notReady")}`}
          </option>
        ))}
      </select>
    </label>
  );
}

function translationTargetStatus(c: TranslationJobComposerController) {
  if (!c.selectedTranslationProvider || !c.selectedTranslationModel) return "";
  if (c.selectedTranslationProvider.status !== "ready") return c.t("jobs.translationProvider.notReady");
  if (!c.translationTargetSupportsLanguage) return c.t("jobs.translationTarget.unsupportedLanguage");
  const machinePostEdit =
    c.selectedTranslationProvider.kind === "machine_translation" && c.translationDraft.translationMode !== "quick";
  return c.t(machinePostEdit ? "jobs.translationTarget.machinePostEdit" : "jobs.translationTarget.ready");
}

function TranslationModelField(c: TranslationJobComposerController) {
  const change = (translationModelId: string) =>
    c.setTranslationDraft((current) => ({ ...current, translationModelId }));
  const status = translationTargetStatus(c);
  return (
    <label>
      <span>{c.t("jobs.translationModel.label")}</span>
      <small className="muted-text">{c.t("jobs.translationModel.help")}</small>
      <select
        value={c.translationDraft.translationModelId}
        disabled={!c.selectedTranslationProvider}
        onChange={(event) => change(event.currentTarget.value)}
      >
        <option value="">{c.t("jobs.translationModel.select")}</option>
        {(c.selectedTranslationProvider?.models || []).map((model) => (
          <option key={model.modelId} value={model.modelId}>
            {model.name}
          </option>
        ))}
      </select>
      {status && <small className="muted-text">{status}</small>}
    </label>
  );
}

function SourceConfiguration(c: TranslationJobComposerController) {
  return (
    <div className="form-grid">
      <SourceFolderField {...c} />
      <TargetLanguageField {...c} />
      <TranslationProviderField {...c} />
      <TranslationModelField {...c} />
    </div>
  );
}

function TranslationModeFields(c: TranslationJobComposerController) {
  return (
    <article className="compact-grid">
      <h3>Translation mode</h3>
      <div className="translation-mode-grid">
        {TRANSLATION_MODE_DEFINITIONS.map((definition) => (
          <TranslationModeButton key={definition.value} c={c} definition={definition} />
        ))}
      </div>
    </article>
  );
}

function TranslationModeButton({
  c,
  definition,
}: {
  c: TranslationJobComposerController;
  definition: TranslationModeDefinition;
}) {
  const selected = c.translationDraft.translationMode === definition.value;
  const select = () =>
    c.setTranslationDraft((current) => ({
      ...current,
      translationMode: definition.value,
      qualityCheck: nextQualityCheck(definition, current.qualityCheck),
      referenceLabel: definition.useReference ? current.referenceLabel : "",
      glossaryMode: definition.useReference ? current.glossaryMode : "canonical",
    }));
  return (
    <button
      className={selected ? "translation-mode-card active" : "translation-mode-card"}
      onClick={select}
      type="button"
    >
      <strong>{definition.label}</strong>
      <span>{definition.description}</span>
    </button>
  );
}

function nextQualityCheck(definition: TranslationModeDefinition, current: boolean) {
  if (definition.consistencyCheck === "required") return true;
  return definition.consistencyCheck === "hidden" ? false : current;
}

function TranslationModeSummary(c: TranslationJobComposerController) {
  const { translationModeDefinition } = c;
  return (
    <article className="compact-grid">
      <h3>模式說明</h3>
      <div className="artifact-summary-card">
        <strong>{translationModeDefinition.label}</strong>
        <p className="muted-text">{translationModeDefinition.description}</p>
        <ul className="plain-list">
          <li>{translationModeDefinition.useReference ? "會在翻譯前使用 Reference。" : "不使用外部 Reference。"}</li>
          <li>
            {translationModeDefinition.writeLocalStyle ? "翻譯完成後會更新本地風格資料。" : "不會更新本地風格資料。"}
          </li>
          <li>{consistencyDescription(translationModeDefinition.consistencyCheck)}</li>
        </ul>
      </div>
    </article>
  );
}

function consistencyDescription(value: TranslationModeDefinition["consistencyCheck"]) {
  if (value === "required") return "翻譯後一定會執行品質檢查。";
  return value === "optional" ? "可選擇是否在翻譯後執行品質檢查。" : "不執行品質檢查。";
}

function OutputMangaField(c: TranslationJobComposerController) {
  return (
    <label>
      <span>{c.t("jobs.outputManga.label")}</span>
      <small className="muted-text">{c.t("jobs.outputManga.help")}</small>
      <div className="stacked-field-row">
        <select
          value={c.translationDraft.profileSelection}
          onChange={(event) => selectOutputManga(c, event.currentTarget.value)}
        >
          <option value="">{outputMangaPlaceholder(c)}</option>
          {c.mangaSeriesOptions.map((manga) => (
            <option key={manga.mangaId} value={manga.mangaId}>
              {manga.label}
            </option>
          ))}
          {!c.usesSeparateReferenceProfile && (
            <option value={CREATE_NEW_MANGA_VALUE}>{c.t("jobs.outputManga.create")}</option>
          )}
        </select>
        <NewMangaInput {...c} />
      </div>
    </label>
  );
}

function NewMangaInput(c: TranslationJobComposerController) {
  if (c.translationDraft.profileSelection !== CREATE_NEW_MANGA_VALUE) return null;
  const rename = (newMangaLabel: string) => c.setTranslationDraft((current) => ({ ...current, newMangaLabel }));
  return (
    <input
      placeholder={c.t("jobs.outputManga.newPlaceholder")}
      value={c.translationDraft.newMangaLabel}
      onChange={(event) => rename(event.currentTarget.value)}
    />
  );
}

function selectOutputManga(c: TranslationJobComposerController, profileSelection: string) {
  c.setTranslationDraft((current) => ({
    ...current,
    profileSelection,
    translatorSelection: "",
    learningProfileSelection: "",
    chapterSelection: "",
    sourceChapterSelection: "",
  }));
}

function outputMangaPlaceholder(c: TranslationJobComposerController) {
  if (c.mangaSeriesQuery.isLoading) return c.t("jobs.outputManga.loading");
  return c.mangaSeriesQuery.isError ? c.t("jobs.outputManga.failed") : c.t("jobs.outputManga.select");
}

function outputTranslators(c: TranslationJobComposerController) {
  return (c.selectedManga?.translators || []).filter((translator) => {
    if (c.translationDraft.translationMode === "local_style") return translator.profileKind === "learning_clone";
    return translator.translatorId !== "translator_original" && translator.profileKind !== "learning_clone";
  });
}

function OutputTranslatorField(c: TranslationJobComposerController) {
  const rename = (newTranslatorLabel: string) =>
    c.setTranslationDraft((current) => ({ ...current, newTranslatorLabel }));
  const prefix = c.usesSeparateReferenceProfile ? "jobs.learning.referenceProfile" : "jobs.outputTranslator";
  const disabled = !c.selectedManga && c.translationDraft.profileSelection !== CREATE_NEW_MANGA_VALUE;
  return (
    <label>
      <span>{c.t(`${prefix}.label`)}</span>
      <small className="muted-text">{c.t(`${prefix}.help`)}</small>
      <div className="stacked-field-row">
        <select
          value={c.translationDraft.translatorSelection}
          disabled={disabled}
          onChange={(event) => selectOutputTranslator(c, event.currentTarget.value)}
        >
          <OutputTranslatorOptions {...c} />
        </select>
        {c.translationDraft.translatorSelection === CREATE_NEW_TRANSLATOR_VALUE && (
          <input
            placeholder={c.t("jobs.outputTranslator.newPlaceholder")}
            value={c.translationDraft.newTranslatorLabel}
            onChange={(event) => rename(event.currentTarget.value)}
          />
        )}
      </div>
    </label>
  );
}

function OutputTranslatorOptions(c: TranslationJobComposerController) {
  const placeholder = c.translationDraft.profileSelection
    ? "jobs.outputTranslator.select"
    : "jobs.outputTranslator.chooseMangaFirst";
  return (
    <>
      <option value="">{c.t(placeholder)}</option>
      {outputTranslators(c).map((translator) => (
        <option key={translator.translatorId} value={translator.translatorId}>
          {translator.label}
        </option>
      ))}
      {!c.usesSeparateReferenceProfile && (
        <option value={CREATE_NEW_TRANSLATOR_VALUE}>{c.t("jobs.outputTranslator.create")}</option>
      )}
    </>
  );
}

function selectOutputTranslator(c: TranslationJobComposerController, translatorSelection: string) {
  c.setTranslationDraft((current) => ({
    ...current,
    translatorSelection,
    learningProfileSelection: "",
    chapterSelection: "",
  }));
}

function LearningProfileCreation(c: TranslationJobComposerController) {
  if (c.translationDraft.learningProfileSelection !== CREATE_NEW_LEARNING_PROFILE_VALUE) return null;
  const disabled =
    c.creatingLearningProfile ||
    !c.selectedManga ||
    !c.selectedOutputTranslator ||
    !c.translationDraft.newLearningTranslatorLabel.trim();
  const rename = (newLearningTranslatorLabel: string) =>
    c.setTranslationDraft((current) => ({ ...current, newLearningTranslatorLabel }));
  return (
    <div className="field-with-action">
      <input
        placeholder={c.t("jobs.learning.profile.newPlaceholder")}
        value={c.translationDraft.newLearningTranslatorLabel}
        onChange={(event) => rename(event.currentTarget.value)}
      />
      <button
        className="secondary-button"
        disabled={disabled}
        onClick={() => void c.createLearningProfile()}
        type="button"
      >
        {c.t(c.creatingLearningProfile ? "jobs.learning.profile.creating" : "jobs.learning.profile.createAction")}
      </button>
    </div>
  );
}

function LearningProfileField(c: TranslationJobComposerController) {
  if (!c.usesSeparateReferenceProfile) return null;
  const select = (learningProfileSelection: string) =>
    c.setTranslationDraft((current) => ({ ...current, learningProfileSelection, chapterSelection: "" }));
  return (
    <label>
      <span>{c.t("jobs.learning.profile.label")}</span>
      <small className="muted-text">{c.t("jobs.learning.profile.help")}</small>
      <select
        value={c.translationDraft.learningProfileSelection}
        disabled={!c.selectedManga || !c.selectedOutputTranslator}
        onChange={(event) => select(event.currentTarget.value)}
      >
        <option value="">{c.t("jobs.learning.profile.select")}</option>
        {c.availableLearningProfiles.map((profile) => (
          <option key={profile.translatorId} value={`${c.selectedManga?.mangaId || ""}::${profile.translatorId}`}>
            {profile.label}
          </option>
        ))}
        <option value={CREATE_NEW_LEARNING_PROFILE_VALUE}>{c.t("jobs.learning.profile.create")}</option>
      </select>
      <LearningProfileCreation {...c} />
    </label>
  );
}

function OutputChapterField(c: TranslationJobComposerController) {
  const disabled = c.usesSeparateReferenceProfile
    ? !c.selectedLearningProfile && c.translationDraft.learningProfileSelection !== CREATE_NEW_LEARNING_PROFILE_VALUE
    : !c.selectedOutputTranslator && c.translationDraft.translatorSelection !== CREATE_NEW_TRANSLATOR_VALUE;
  const select = (chapterSelection: string) => c.setTranslationDraft((current) => ({ ...current, chapterSelection }));
  const rename = (newChapterTitle: string) => c.setTranslationDraft((current) => ({ ...current, newChapterTitle }));
  return (
    <ChapterSelector
      label={c.t("jobs.outputChapter.label")}
      helpText={c.t(c.usesSeparateReferenceProfile ? "jobs.learning.outputChapter.help" : "jobs.outputChapter.help")}
      selectedValue={c.translationDraft.chapterSelection}
      chapters={c.availableChapters}
      newChapterTitle={c.translationDraft.newChapterTitle}
      chapterStatusLabels={c.chapterPublicationStatusLabels}
      disabled={disabled}
      onSelectionChange={select}
      onNewChapterTitleChange={rename}
    />
  );
}

function SourceChapterField(c: TranslationJobComposerController) {
  if (!c.translationModeDefinition.useReference) return null;
  const select = (sourceChapterSelection: string) =>
    c.setTranslationDraft((current) => ({ ...current, sourceChapterSelection }));
  return (
    <label>
      <span>{c.t("jobs.sourceChapter.label")}</span>
      <small className="muted-text">{c.t("jobs.sourceChapter.help")}</small>
      <select value={c.translationDraft.sourceChapterSelection} onChange={(event) => select(event.currentTarget.value)}>
        <option value="">{c.t("jobs.sourceChapter.auto")}</option>
        {c.availableSourceChapters.map((chapter) => (
          <option key={chapter.chapterId} value={chapter.chapterId}>
            {chapter.chapterTitle || chapter.chapterId}
          </option>
        ))}
      </select>
    </label>
  );
}

function OptionalQualityField(c: TranslationJobComposerController) {
  if (c.translationModeDefinition.consistencyCheck !== "optional") return null;
  const change = (qualityCheck: boolean) => c.setTranslationDraft((current) => ({ ...current, qualityCheck }));
  return (
    <label>
      <span>執行品質驗證</span>
      <div className="switch-row">
        <label className="switch">
          <input
            checked={c.translationDraft.qualityCheck}
            type="checkbox"
            onChange={(event) => change(event.currentTarget.checked)}
          />
          <span className="switch-slider" />
        </label>
        <span>{c.translationDraft.qualityCheck ? "啟用" : "停用"}</span>
      </div>
    </label>
  );
}

function RequiredQualityField(c: TranslationJobComposerController) {
  const { translationModeDefinition } = c;
  return (
    <>
      {translationModeDefinition.consistencyCheck === "required" && (
        <label>
          {" "}
          <span>執行品質驗證</span>{" "}
          <div className="switch-row">
            {" "}
            <span className="mode-lock-badge">此模式固定啟用</span>{" "}
          </div>{" "}
        </label>
      )}{" "}
    </>
  );
}

function TranslationContextFields(c: TranslationJobComposerController) {
  return (
    <div className="form-grid">
      <OutputMangaField {...c} />
      <OutputTranslatorField {...c} />
      <LearningProfileField {...c} />
      <OutputChapterField {...c} />
      <SourceChapterField {...c} />
      <OptionalQualityField {...c} />
      <RequiredQualityField {...c} />
    </div>
  );
}

function ReferenceConfiguration(c: TranslationJobComposerController) {
  const { setTranslationDraft, t, translationDraft, translationModeDefinition } = c;
  return (
    <>
      {translationModeDefinition.useReference && (
        <article className="compact-grid">
          {" "}
          <h3>Reference 設定</h3>{" "}
          <ul className="plain-list">
            {" "}
            <li>這個模式會在翻譯前使用 Reference 衍生出的術語與上下文。</li>{" "}
            <li>所選 Reference 會影響 glossary 與 prompt context。</li>{" "}
            <li>系統會使用目前作品已完成的原文與譯者 Reference 記憶，不會在翻譯時重跑 Ingestion。</li>{" "}
          </ul>{" "}
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
          />{" "}
        </article>
      )}{" "}
    </>
  );
}

function QualityConfiguration(c: TranslationJobComposerController) {
  const { backendConfigQuery, consistencyCheckEnabled, t } = c;
  if (!consistencyCheckEnabled) return null;
  return (
    <article className="compact-grid">
      <h3>{t("settings.ao.qualitySummary")}</h3>
      <div className="summary-grid">
        <QualityValue
          label={t("settings.ao.model.label")}
          value={backendConfigQuery.data?.agent?.model || t("settings.ao.model.unavailable")}
        />
        <QualityValue
          label={t("settings.ao.baseUrl.label")}
          value={backendConfigQuery.data?.agent?.baseUrl || t("settings.ao.baseUrl.unavailable")}
        />
      </div>
    </article>
  );
}

function QualityValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <strong>{label}</strong>
      <div className="muted-text">{value}</div>
    </div>
  );
}

function LocalStyleSummary(c: TranslationJobComposerController) {
  const { translationModeDefinition } = c;
  return (
    <>
      {translationModeDefinition.writeLocalStyle && (
        <article className="compact-grid">
          {" "}
          <h3>本地風格更新</h3>{" "}
          <ul className="plain-list">
            {" "}
            <li>此模式會為目前漫畫累積術語、語氣與風格資料。</li> <li>章節名稱為可選，會作為人類可讀的章節描述。</li>{" "}
            <li>更新後的本地風格檔案會出現在 Job artifacts。</li>{" "}
          </ul>{" "}
        </article>
      )}{" "}
    </>
  );
}

function PreflightChecklist(c: TranslationJobComposerController) {
  const { translationChecklist } = c;
  return (
    <>
      <article className="compact-grid">
        {" "}
        <h3>前置檢查</h3>{" "}
        <ul className="plain-list checklist-list">
          {" "}
          {translationChecklist.map((item) => (
            <li key={item.label} className={item.done ? "checklist-item done" : "checklist-item pending"}>
              {" "}
              <strong>{item.done ? "完成" : "待處理"}：</strong> {item.label}{" "}
              <div className="muted-text">{item.detail}</div>{" "}
            </li>
          ))}{" "}
        </ul>{" "}
      </article>{" "}
    </>
  );
}

function TranslationActions(c: TranslationJobComposerController) {
  const title = c.startTranslationDisabled
    ? c.translationBlockingIssues.join(" ")
    : buildTranslationStatusMessage(c.translationDraft);
  return (
    <div className="button-row">
      <button
        className="secondary-button"
        disabled={c.busy || !c.translationDraft.sourceFolder.trim()}
        onClick={() => void c.runPreflight()}
        type="button"
      >
        執行檢查
      </button>
      <span className={c.startTranslationDisabled ? "disabled-control-wrap" : "enabled-control-wrap"} title={title}>
        <button
          className="primary-button"
          disabled={c.startTranslationDisabled}
          onClick={() => void c.startTranslation()}
          type="button"
        >
          開始翻譯
        </button>
      </span>
    </div>
  );
}

function TranslationBlockers(c: TranslationJobComposerController) {
  const { translationBlockingIssues } = c;
  return (
    <>
      {translationBlockingIssues.length > 0 && (
        <div className="artifact-summary-card warning-card">
          {" "}
          <strong>需先完成以下項目才能開始翻譯</strong>{" "}
          <ul className="plain-list">
            {" "}
            {translationBlockingIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}{" "}
          </ul>{" "}
        </div>
      )}{" "}
    </>
  );
}

function PathValidationSummary(c: TranslationJobComposerController) {
  const { openSettingsForOutputFix, pickSourceFolder, settingsSnapshot, translationPathValidation } = c;
  if (!translationPathValidation) return null;
  const source = translationPathValidation.sourceFolder;
  const output = translationPathValidation.outputFolder;
  return (
    <article className="compact-grid">
      <h3>路徑驗證</h3>
      <div className="summary-grid">
        <PathStatus
          label="來源資料夾"
          ok={source.ok}
          detail={source.ok ? "可讀取" : source.reason}
          actionLabel="重新選擇來源資料夾"
          onFix={pickSourceFolder}
        />
        <PathStatus
          label="輸出資料夾"
          ok={output.ok}
          detail={output.ok ? settingsSnapshot?.outputFolder || "可寫入" : output.reason}
          actionLabel="開啟 Settings"
          onFix={openSettingsForOutputFix}
        />
      </div>
    </article>
  );
}

function PathStatus(props: { label: string; ok: boolean; detail: string; actionLabel: string; onFix: () => void }) {
  return (
    <div>
      <strong>{props.label}</strong>
      <div className="muted-text">{props.detail}</div>
      {!props.ok && (
        <button className="secondary-button" onClick={props.onFix} type="button">
          {props.actionLabel}
        </button>
      )}
    </div>
  );
}

function GeneratedIdentifiers(c: TranslationJobComposerController) {
  const { translationIds } = c;
  return (
    <>
      <article className="compact-grid">
        {" "}
        <h3>System-generated identifiers</h3>{" "}
        <div className="summary-grid">
          {" "}
          <div>
            {" "}
            <strong>Manga ID</strong> <div className="muted-text">{translationIds.mangaId ?? "尚未產生"}</div>{" "}
          </div>{" "}
          <div>
            {" "}
            <strong>Translator ID</strong>{" "}
            <div className="muted-text">{translationIds.translatorId ?? "尚未產生"}</div>{" "}
          </div>{" "}
          <div>
            {" "}
            <strong>Chapter ID</strong> <div className="muted-text">{translationIds.chapterId ?? "選填"}</div>{" "}
          </div>{" "}
        </div>{" "}
      </article>{" "}
    </>
  );
}

function PreflightMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <strong>{label}</strong>
      <div className="muted-text">{value}</div>
    </div>
  );
}

function PreflightResultSummary(c: TranslationJobComposerController) {
  const result = c.preflightResult!;
  const order = c.orderingDirty ? "尚未套用變更" : result.orderChanged ? "已套用自訂排序" : "使用原始排序";
  return (
    <div className="summary-grid">
      <PreflightMetric label="可用圖片" value={result.summary.acceptedCount} />
      <PreflightMetric label="已轉檔" value={result.summary.convertedCount} />
      <PreflightMetric label="已排除" value={result.summary.rejectedCount} />
      <PreflightMetric label="排序狀態" value={order} />
    </div>
  );
}

function RejectedSourceFiles(c: TranslationJobComposerController) {
  const files = c.preflightResult?.rejectedFiles || [];
  if (!files.length) return null;
  return (
    <div className="artifact-summary-card">
      <strong>拒絕檔案</strong>
      <ul className="plain-list">
        {files.map((file) => (
          <li key={file.path}>
            <strong>{file.fileName}</strong>: {file.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

function dragImageOver(c: TranslationJobComposerController, targetId: string, event: DragEvent<HTMLLIElement>) {
  event.preventDefault();
  if (!c.draggedImageId || c.draggedImageId === targetId) return;
  c.setOrderedImageIds((current) => moveImageId(current, c.draggedImageId!, targetId));
}

function dropImage(c: TranslationJobComposerController, targetId: string) {
  if (!c.draggedImageId) return;
  c.setOrderedImageIds((current) => moveImageId(current, c.draggedImageId!, targetId));
  c.setDraggedImageId(null);
}

function PreflightImageOrdering(c: TranslationJobComposerController) {
  if (!c.orderedImages.length) return null;
  return (
    <>
      <PreflightOrderIntro {...c} />
      <div className="button-row">
        <button
          className="secondary-button"
          disabled={c.busy || !c.orderingDirty}
          onClick={() => void c.applyCurrentOrdering()}
          type="button"
        >
          套用圖片排序
        </button>
      </div>
      <PreflightImageList {...c} />
    </>
  );
}

function PreflightOrderIntro(c: TranslationJobComposerController) {
  return (
    <div className="artifact-summary-card">
      <strong>預覽與排序</strong>
      <p className="muted-text">執行來源檢查後，可以在這裡預覽圖片並拖曳調整順序。</p>
      {c.orderingDirty && <p className="muted-text">目前排序尚未套用，按下「套用圖片排序」後才會寫回這次檢查結果。</p>}
    </div>
  );
}

function PreflightImageList(c: TranslationJobComposerController) {
  return (
    <ul className="preflight-image-list">
      {c.orderedImages.map((image, index) => (
        <PreflightPreviewCard
          key={image.id}
          image={image}
          index={index}
          onDragStart={c.setDraggedImageId}
          onDragOver={(event) => dragImageOver(c, image.id, event)}
          onDrop={(id) => dropImage(c, id)}
          onDragEnd={() => c.setDraggedImageId(null)}
          isDragging={c.draggedImageId === image.id}
        />
      ))}
    </ul>
  );
}

function PreflightResults(c: TranslationJobComposerController) {
  if (!c.preflightResult) return null;
  return (
    <article className="compact-grid">
      <h3>來源檢查結果</h3>
      <PreflightResultSummary {...c} />
      <RejectedSourceFiles {...c} />
      <PreflightImageOrdering {...c} />
    </article>
  );
}

function ComposerHeader(c: TranslationJobComposerController) {
  return (
    <>
      <h1>Create Translation Job</h1>
      <p>{c.status}</p>
      <div className="button-row">
        <button
          className="secondary-button"
          onClick={() => void c.queryClient.invalidateQueries({ queryKey: ["jobs"] })}
          type="button"
        >
          重新整理相關 Jobs
        </button>
      </div>
    </>
  );
}

function StartTranslationCard(c: TranslationJobComposerController) {
  return (
    <article className="card">
      <h2>Start translation</h2>
      <p className="muted-text">依序選擇來源、翻譯模式、作品上下文，系統會先做前置檢查，再開始翻譯。</p>
      <SourceConfiguration {...c} />
      <TranslationModeFields {...c} />
      <TranslationModeSummary {...c} />
      <TranslationContextFields {...c} />
      <ReferenceConfiguration {...c} />
      <QualityConfiguration {...c} />
      <LocalStyleSummary {...c} />
      <PreflightChecklist {...c} />
      <TranslationActions {...c} />
      <TranslationBlockers {...c} />
      <PathValidationSummary {...c} />
      <GeneratedIdentifiers {...c} />
      <PreflightResults {...c} />
    </article>
  );
}

function ReferencePageCard(c: TranslationJobComposerController) {
  return (
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
        <button className="secondary-button" onClick={() => c.setSelectedPage("reference")} type="button">
          開啟 Reference 頁面
        </button>
      </div>
    </article>
  );
}

function TranslationJobComposerView(c: TranslationJobComposerController) {
  return (
    <section className="page">
      {c.centerNotice && (
        <div className="center-notice-layer" aria-live="polite">
          <div className={`center-notice center-notice-${c.centerNotice.tone}`}>{c.centerNotice.message}</div>
        </div>
      )}
      <ComposerHeader {...c} />
      <div className="card-stack">
        <StartTranslationCard {...c} />
        <ReferencePageCard {...c} />
      </div>
    </section>
  );
}

export function TranslationJobComposer() {
  return <TranslationJobComposerView {...useTranslationJobComposer()} />;
}
