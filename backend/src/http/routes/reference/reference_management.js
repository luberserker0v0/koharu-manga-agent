const { deleteReferenceSet, listReferenceSets } = require("../../../domains/reference/sets/reference_sets");
const { listKnowledgeSeries } = require("../../../domains/knowledge/registry/knowledge_paths");

function permanentlyDeleteMatchingJobs(jobManager, predicate) {
  const deleted = [];
  for (const job of jobManager.listJobsWithDeleted().filter(predicate)) {
    if (!job.deletedAt) jobManager.deleteJob(job.id);
    const purged = jobManager.purgeJob(job.id);
    if (purged) deleted.push({ id: purged.id, status: purged.status, type: purged.type });
  }
  return deleted;
}

function matchingReferenceJobs(jobManager, predicate) {
  const referenceTypes = new Set([
    "reference_extraction",
    "reference_observation",
    "reference_ingestion",
    "reference_bilingual_enrichment",
  ]);
  return jobManager.listJobsWithDeleted().filter((job) => referenceTypes.has(job.type)).filter(predicate);
}

function assertNoActiveJobs(jobs) {
  const active = jobs.filter((job) => !["succeeded", "failed", "canceled", "blocked"].includes(job.status));
  if (active.length === 0) return;
  const error = new Error(`Cannot delete data while ${active.length} related job(s) are active. Cancel them first.`);
  error.statusCode = 409;
  throw error;
}

function resolveMangaDisplayLabel(mangaId, requestedLabel = null) {
  if (!mangaId) return requestedLabel || null;
  const indexedManga = listKnowledgeSeries().find((entry) => entry.mangaId === mangaId);
  if (indexedManga?.label && indexedManga.label !== mangaId) return indexedManga.label;
  return requestedLabel && requestedLabel !== mangaId ? requestedLabel : null;
}

function hydrateReferenceDisplayLabels(referenceSets) {
  return referenceSets.map((referenceSet) => ({
    ...referenceSet,
    mangaLabel: resolveMangaDisplayLabel(referenceSet.mangaId, referenceSet.mangaLabel),
  }));
}

function deleteBoundReferenceData(jobManager, { mangaId, translatorId = null }) {
  const boundReferences = listReferenceSets().filter((entry) =>
    entry.mangaId === mangaId && (!translatorId || entry.translatorId === translatorId)
  );
  const referenceIds = new Set(boundReferences.map((entry) => entry.id));
  const jobs = matchingReferenceJobs(jobManager, (job) =>
    referenceIds.has(job.payload?.referenceSetId) ||
    (job.payload?.mangaId === mangaId && (!translatorId || job.payload?.translatorId === translatorId))
  );
  assertNoActiveJobs(jobs);
  return {
    deletedReferences: boundReferences.map((entry) => deleteReferenceSet(entry.id)),
    deletedJobs: permanentlyDeleteMatchingJobs(jobManager, (job) => jobs.some((candidate) => candidate.id === job.id)),
  };
}

module.exports = {
  assertNoActiveJobs,
  deleteBoundReferenceData,
  hydrateReferenceDisplayLabels,
  matchingReferenceJobs,
  permanentlyDeleteMatchingJobs,
  resolveMangaDisplayLabel,
};
