function staleError(sourceImageId) {
  return Object.assign(new Error(`The active text-region snapshot for ${sourceImageId} has changed.`), {
    statusCode: 409,
    code: "stale_region_set_revision",
    details: { sourceImageId },
  });
}

function activeRevision(store, rootJobId, sourceImageId) {
  const active = store.listActiveTranslationPageRevisions(rootJobId)
    .find((entry) => entry.sourceImageId === sourceImageId);
  const revision = active && store.getTranslationPageRevision(active.revisionId);
  if (!revision) throw staleError(sourceImageId);
  return revision;
}

function activeRegionPage(store, snapshotRepository, rootJobId, sourceImageId) {
  const revision = activeRevision(store, rootJobId, sourceImageId);
  const producer = store.getJob(revision.jobId);
  const snapshot = producer && snapshotRepository.loadForJob(store, producer);
  const page = snapshot?.pages?.find((entry) => entry.sourceImageId === sourceImageId);
  if (!page) throw staleError(sourceImageId);
  return { revision, page };
}

function assertCurrentRegionSets({ store, snapshotRepository, rootJobId, pages }) {
  return pages.map((expected) => {
    const current = activeRegionPage(store, snapshotRepository, rootJobId, expected.sourceImageId);
    if (current.page.regionSetRevisionId !== expected.baseRegionSetRevisionId) {
      throw staleError(expected.sourceImageId);
    }
    return { sourceImageId: expected.sourceImageId, revisionId: current.revision.revisionId };
  });
}

module.exports = { assertCurrentRegionSets };
