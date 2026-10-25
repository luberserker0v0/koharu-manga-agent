import type { ReferenceExtractionPayload, ReferenceIngestionPayload } from "../../../api/jobs";
import type { ImportedReferenceBinding } from "../types";
import type { BindingResolution, WorklistActionParams } from "./useReferenceWorklistActions";

export type CompleteBinding = BindingResolution & {
  translatorId: string;
  translatorLabel: string;
  chapterId: string;
};

export async function resolveEntryBinding(
  entry: ImportedReferenceBinding,
  fallback: CompleteBinding | null,
  params: WorklistActionParams,
): Promise<CompleteBinding> {
  const mangaId = entry.mangaId || fallback?.mangaId;
  const mangaLabel = entry.mangaLabel || fallback?.mangaLabel;
  const translatorId = entry.translatorId || fallback?.translatorId;
  const translatorLabel = entry.translatorLabel || fallback?.translatorLabel;
  let chapterId = entry.chapterId || fallback?.chapterId;
  let chapterTitle = entry.chapterTitle || fallback?.chapterTitle;
  if (mangaId && translatorId && !chapterId) {
    const chapter = await params.createChapterForBinding(
      mangaId,
      translatorId,
      params.normalizeChapterTitleLabel(entry.label),
    );
    chapterId = chapter.chapterId;
    chapterTitle = chapter.chapterTitle;
  }
  if (!mangaId || !mangaLabel || !translatorId || !chapterId) throw new Error(`Missing binding for ${entry.label}.`);
  return {
    mangaId,
    mangaLabel,
    translatorId,
    translatorLabel: translatorLabel || translatorId,
    chapterId,
    chapterTitle,
  };
}

export function mergeBinding(entry: ImportedReferenceBinding, binding: CompleteBinding): ImportedReferenceBinding {
  return { ...entry, ...binding };
}

export function extractionPayload(
  entry: ImportedReferenceBinding,
  binding: CompleteBinding,
  params: WorklistActionParams,
): ReferenceExtractionPayload {
  return {
    referenceSetId: entry.referenceSetId,
    targetLanguage: entry.language,
    ...binding,
    chapterLabel: binding.chapterTitle,
    referenceKind: params.isSourceReferenceKind(entry.referenceKind) ? "source" : "translator",
  };
}

export function ingestionPayload(
  entry: ImportedReferenceBinding,
  binding: CompleteBinding,
  params: WorklistActionParams,
): ReferenceIngestionPayload {
  const source = params.isSourceReferenceKind(entry.referenceKind);
  return {
    referenceSetId: entry.referenceSetId,
    ...binding,
    chapterLabel: binding.chapterTitle,
    referenceKind: source ? "source" : "translator",
    useForTerminology: params.ingestionForm.useForTerminology,
    useForStyle: params.ingestionForm.useForStyle && !source,
    analysisDepth: params.ingestionForm.analysisDepth,
    translator: binding.translatorLabel,
  };
}
