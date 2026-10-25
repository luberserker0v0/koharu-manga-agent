import type { ReferenceIngestionPayload, ReferenceSetSummary } from "../../../api/jobs";
import type { ImportedReferenceBinding } from "../types";
import { ingestionPayload, mergeBinding, resolveEntryBinding } from "./referenceWorklistBindings";
import { selectReferenceMaterial } from "./referenceWorklistSelection";
import type { WorklistActionParams } from "./useReferenceWorklistActions";

function batchValidationError(params: WorklistActionParams): string | null {
  if (!params.referenceWorklist.length) return "工作區目前為空，無法建立 Ingestion。";
  if (params.styleOptionDisabledForWorklist && !params.ingestionForm.useForTerminology) {
    return "原文 Reference 不會建立翻譯風格，至少需要啟用專有名詞用途。";
  }
  if (!params.ingestionForm.useForTerminology && !params.ingestionForm.useForStyle)
    return "請至少選擇一個 Ingestion 用途。";
  if (params.worklistEntriesMissingExtraction.length) {
    return `需先完成 Extraction：${params.worklistEntriesMissingExtraction.map((entry) => entry.label).join(", ")}`;
  }
  return null;
}

function itemValidationError(
  referenceSet: ReferenceSetSummary,
  entry: ImportedReferenceBinding | null,
  params: WorklistActionParams,
) {
  if (!entry) return "缺少工作區項目，無法建立單筆 Ingestion Job。";
  const extraction = params.latestReferenceJobForSet(params.referenceJobs, referenceSet.id, "reference_extraction");
  if (referenceSet.extractionAvailable !== true && extraction?.status !== "succeeded") {
    return `需先完成 ${referenceSet.label} 的 Extraction，才能執行 Ingestion。`;
  }
  if (params.isSourceReferenceKind(entry.referenceKind) && !params.ingestionForm.useForTerminology) {
    return "原文 Reference 不會建立翻譯風格，至少需要啟用專有名詞用途。";
  }
  if (!params.ingestionForm.useForTerminology && !params.ingestionForm.useForStyle)
    return "請至少選擇一個 Ingestion 用途。";
  if (!entry.mangaId || !entry.translatorId || !entry.chapterId)
    return `缺少 ${referenceSet.label} 的漫畫、譯者或章節綁定，無法執行 Ingestion。`;
  return null;
}

async function buildBatchPayloads(params: WorklistActionParams) {
  const fallback = await params.resolveProfileAndChapter();
  if (!fallback && params.referenceWorklist.some((entry) => !entry.mangaId || !entry.translatorId)) {
    throw new Error("Worklist Ingestion 需要漫畫、譯者與章節綁定，請先完成 Reference 匯入綁定。");
  }
  const payloads: ReferenceIngestionPayload[] = [];
  const entries: ImportedReferenceBinding[] = [];
  for (const entry of params.referenceWorklist) {
    const binding = await resolveEntryBinding(entry, fallback, params);
    payloads.push(ingestionPayload(entry, binding, params));
    entries.push(mergeBinding(entry, binding));
  }
  return { payloads, entries };
}

export async function runWorklistIngestion(params: WorklistActionParams) {
  const validationError = batchValidationError(params);
  if (validationError) return params.setPageStatus(validationError);
  params.setIsWorklistIngesting(true);
  try {
    const { payloads, entries } = await buildBatchPayloads(params);
    params.setPageStatus(`正在依章節順序建立 ${payloads.length} 筆 Ingestion Job...`);
    const { jobs } = await params.createReferenceIngestionJobsFn(payloads);
    params.appendWorklistEntries(entries);
    params.setSelectedReferenceJobId(jobs.at(-1)?.id || null);
    params.setPageStatus(`已建立 ${jobs.length} 筆 Ingestion Job。`);
    await params.queryClient.invalidateQueries({ queryKey: ["jobs"] });
  } catch (error) {
    params.setPageStatus(error instanceof Error ? error.message : "建立 Ingestion Job 失敗。");
  } finally {
    params.setIsWorklistIngesting(false);
  }
}

export async function runWorklistItemIngestion(
  referenceSet: ReferenceSetSummary,
  entry: ImportedReferenceBinding | null,
  params: WorklistActionParams,
) {
  const validationError = itemValidationError(referenceSet, entry, params);
  if (validationError || !entry) return params.setPageStatus(validationError || "缺少工作區項目。");
  const binding = await resolveEntryBinding(entry, null, params);
  await params.createReferenceIngestionJobFn(ingestionPayload(entry, binding, params));
  selectReferenceMaterial(referenceSet.id, referenceSet.label, params);
  await params.queryClient.invalidateQueries({ queryKey: ["jobs"] });
}
