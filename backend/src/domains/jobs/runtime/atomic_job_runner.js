const { assertJobType } = require("../contracts/job_contracts");

function atomicEngineMethod(job) {
  if (["translation", "translation_quality_repair"].includes(job.type)) return "runTranslationJob";
  if (job.type === "reference_extraction") return "runReferenceExtractionJob";
  if (job.type === "reference_deep_review") return "runReferenceDeepReviewJob";
  if (job.type === "reference_story_update") return "runReferenceIngestionStoryJob";
  if (["reference_knowledge_commit", "reference_style_commit"].includes(job.type)) {
    return "runReferenceIngestionCommitJob";
  }
  if (job.type === "reference_bilingual_evidence_window") return "runReferenceBilingualEvidenceWindowJob";
  if (job.type === "reference_bilingual_commit") return "runReferenceBilingualCommitJob";
  if (job.type === "post_edit_export") return "runPostEditExportJob";
  if (job.type === "translation_knowledge_commit") return "runTranslationKnowledgeCommitJob";
  if (job.type === "translation_deep_audit") return "runTranslationDeepAuditJob";
  if (job.type === "translation_deep_audit_apply") return "runTranslationDeepAuditApplyJob";
  return null;
}

async function runAtomicJob(manager, job, hooks) {
  assertJobType(job.type, job.executionKind || "job");
  if (job.type === "reference_observation") {
    const method = job.parentJobId ? "runReferenceIngestionAnalysisJob" : "runReferenceObservationJob";
    return manager.engine[method](job.payload, hooks);
  }
  const method = atomicEngineMethod(job);
  if (!method) throw new Error(`No atomic job handler is registered for ${job.type}.`);
  return manager.engine[method](job.payload, hooks);
}

module.exports = { runAtomicJob };
