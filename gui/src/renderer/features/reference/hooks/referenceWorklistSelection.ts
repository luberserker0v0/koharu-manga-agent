import type { WorklistActionParams } from "./useReferenceWorklistActions";

export function selectReferenceMaterial(referenceSetId: string, label: string, params: WorklistActionParams) {
  const ingestion = params.latestReferenceJobForSet(params.referenceJobs, referenceSetId, "reference_ingestion");
  const extraction = params.latestReferenceJobForSet(params.referenceJobs, referenceSetId, "reference_extraction");
  params.setExtractionForm((current) => ({ ...current, referenceSetId }));
  params.setIngestionForm((current) => ({ ...current, referenceSetId }));
  params.setSelectedReferenceJobId(ingestion?.id || extraction?.id || null);
  params.setPageStatus(`已選取 Reference：${label} (${referenceSetId})`);
}
