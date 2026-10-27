function apiError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

function requireCoordinateSpace(page) {
  const { width, height } = page.coordinateSpace || {};
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) return;
  throw apiError(
    `Text-region coordinate space is unavailable for source image ${page.sourceImageId}.`,
    409,
    "text_region_coordinate_space_unavailable",
  );
}

function publicRegion(region) {
  return {
    id: region.id,
    readingOrder: region.readingOrder,
    geometry: region.geometry,
    sourceText: region.sourceText,
    translatedText: region.translatedText,
    ...(region.ocrConfidence == null ? {} : { ocrConfidence: region.ocrConfidence }),
    ...(region.sourceDirection ? { sourceDirection: region.sourceDirection } : {}),
  };
}

function publicPage(page, pageRevisionId) {
  requireCoordinateSpace(page);
  return {
    sourceImageId: page.sourceImageId,
    sourceOrderIndex: page.sourceOrderIndex,
    sourceFileName: page.sourceFileName,
    pageRevisionId,
    regionSetRevisionId: page.regionSetRevisionId,
    coordinateSpace: page.coordinateSpace,
    regions: page.regions.map(publicRegion),
  };
}

class TextRegionQueryService {
  constructor({ store, pageRevisionService, snapshotRepository }) {
    this.store = store;
    this.pageRevisionService = pageRevisionService;
    this.snapshotRepository = snapshotRepository;
  }

  resolveJob(jobId) {
    const job = this.store.getJob(jobId);
    if (!job || job.type !== "translation") {
      throw apiError("Translation Job was not found.", 404, "translation_job_not_found");
    }
    return job;
  }

  loadSnapshot(job) {
    const snapshot = this.snapshotRepository.loadForJob(this.store, job);
    if (snapshot) return snapshot;
    throw apiError(
      "This Translation Job does not retain a text-region snapshot.",
      409,
      "text_region_snapshot_unavailable",
    );
  }

  async revisionMap(job, snapshot) {
    await this.pageRevisionService?.synchronizeJob(job.id);
    const revisions = this.store.listTranslationPageRevisions(snapshot.rootJobId);
    return new Map(
      revisions
        .filter((entry) => entry.jobId === job.id)
        .map((entry) => [entry.sourceImageId, entry.revisionId]),
    );
  }

  selectPages(snapshot, sourceImageId) {
    if (!sourceImageId) return snapshot.pages;
    const pages = snapshot.pages.filter((page) => page.sourceImageId === sourceImageId);
    if (pages.length) return pages;
    throw apiError("Source image was not found in this text-region snapshot.", 404, "text_region_page_not_found");
  }

  async get(jobId, { sourceImageId = null } = {}) {
    const job = this.resolveJob(jobId);
    const snapshot = this.loadSnapshot(job);
    const revisions = await this.revisionMap(job, snapshot);
    const pages = this.selectPages(snapshot, sourceImageId).map((page) => {
      const pageRevisionId = revisions.get(page.sourceImageId);
      if (!pageRevisionId) throw apiError(
        `Page revision is unavailable for source image ${page.sourceImageId}.`, 409,
        "text_region_page_revision_unavailable",
      );
      return publicPage(page, pageRevisionId);
    });
    return { jobId: job.id, rootJobId: snapshot.rootJobId, snapshotFingerprint: snapshot.fingerprint, pages };
  }
}

module.exports = { TextRegionQueryService };
