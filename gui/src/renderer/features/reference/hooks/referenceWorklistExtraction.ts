import type { ReferenceSetSummary } from "../../../api/jobs";
import type { ImportedReferenceBinding } from "../types";
import { extractionPayload, mergeBinding, resolveEntryBinding } from "./referenceWorklistBindings";
import { selectReferenceMaterial } from "./referenceWorklistSelection";
import type { WorklistActionParams } from "./useReferenceWorklistActions";

async function createExtraction(
  entry: ImportedReferenceBinding,
  fallback: Awaited<ReturnType<WorklistActionParams["resolveProfileAndChapter"]>>,
  params: WorklistActionParams,
) {
  const binding = await resolveEntryBinding(entry, fallback, params);
  params.setPageStatus(`正在為 ${entry.label} 建立 Extraction Job...`);
  const job = await params.createReferenceExtractionJobFn(extractionPayload(entry, binding, params));
  return { job, entry: mergeBinding(entry, binding) };
}

export async function runWorklistExtraction(params: WorklistActionParams) {
  if (!params.referenceWorklist.length) {
    params.setPageStatus("工作區目前為空，無法建立 Extraction。");
    return;
  }
  params.setIsWorklistExtracting(true);
  try {
    const fallback = await params.resolveProfileAndChapter();
    const created = [];
    for (const entry of params.referenceWorklist) created.push(await createExtraction(entry, fallback, params));
    params.appendWorklistEntries(created.map((item) => item.entry));
    params.setSelectedReferenceJobId(created.at(-1)?.job.id || null);
    params.setPageStatus(`已建立 ${created.length} 筆 Extraction Job。`);
    await params.queryClient.invalidateQueries({ queryKey: ["jobs"] });
  } catch (error) {
    params.setPageStatus(error instanceof Error ? error.message : "建立 Extraction Job 失敗。");
  } finally {
    params.setIsWorklistExtracting(false);
  }
}

export async function runWorklistItemExtraction(
  referenceSet: ReferenceSetSummary,
  entry: ImportedReferenceBinding | null,
  params: WorklistActionParams,
) {
  if (!entry) return params.setPageStatus("缺少工作區項目，無法建立單筆 Extraction Job。");
  const binding = await resolveEntryBinding(entry, null, params);
  await params.createReferenceExtractionJobFn(extractionPayload(entry, binding, params));
  selectReferenceMaterial(referenceSet.id, referenceSet.label, params);
  await params.queryClient.invalidateQueries({ queryKey: ["jobs"] });
}
