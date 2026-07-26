const fs = require("fs");
const path = require("path");
const { paths } = require("../src/config");
const { JobStore } = require("../src/storage/job_store");
const {
  clearTranslatorIngestionData,
  listKnowledgeSeries,
} = require("../src/modules/knowledge_paths");
const { listReferenceSets, referenceSetPaths } = require("../src/modules/reference_sets");

const DERIVED_JOB_TYPES = new Set([
  "reference_bilingual_enrichment",
  "reference_deep_review",
  "reference_ingestion",
  "reference_ingestion_analysis",
  "reference_ingestion_commit",
  "reference_ingestion_prepare",
  "reference_ingestion_story",
  "reference_knowledge_commit",
  "reference_observation",
  "reference_story_update",
  "reference_style_commit",
]);

function buildResetPlan() {
  const profiles = listKnowledgeSeries().flatMap((series) =>
    (series.translators || []).map((translator) => ({
      mangaId: series.mangaId,
      translatorId: translator.translatorId,
    }))
  );
  const referenceArtifacts = listReferenceSets().flatMap((reference) => {
    const resolved = referenceSetPaths(reference.id);
    return [
      resolved.observationPath,
      resolved.observationRevisionsDir,
      resolved.deepReviewRevisionsDir,
    ].filter((filePath) => fs.existsSync(filePath));
  });
  const store = new JobStore(paths.database);
  const jobs = store.listJobs({ includeDeleted: true })
    .filter((job) => DERIVED_JOB_TYPES.has(job.type));
  return { profiles, referenceArtifacts, jobs };
}

function executeReset(plan) {
  for (const profile of plan.profiles) clearTranslatorIngestionData(profile);
  for (const filePath of plan.referenceArtifacts) {
    fs.rmSync(filePath, { recursive: true, force: true });
  }
  fs.rmSync(paths.legacyReferenceDiagnostics || paths.referenceComparisons, {
    recursive: true,
    force: true,
  });

  const store = new JobStore(paths.database);
  const childJobs = plan.jobs.filter((job) => job.parentJobId);
  const rootJobs = plan.jobs.filter((job) => !job.parentJobId);
  for (const job of [...childJobs, ...rootJobs]) {
    store.deleteJob(job.id);
    fs.rmSync(path.join(paths.workspaceRoot, job.id), { recursive: true, force: true });
  }
}

function main() {
  const execute = process.argv.includes("--execute");
  const plan = buildResetPlan();
  const summary = {
    mode: execute ? "execute" : "dry-run",
    knowledgeProfiles: plan.profiles.length,
    referenceArtifacts: plan.referenceArtifacts.length,
    derivedJobs: plan.jobs.length,
    preservedExtractionJobs: new JobStore(paths.database)
      .listJobs({ includeDeleted: true })
      .filter((job) => job.type === "reference_extraction").length,
  };
  if (execute) executeReset(plan);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = { DERIVED_JOB_TYPES, buildResetPlan, executeReset };
