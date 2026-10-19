const crypto = require("crypto");

function apiError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

function revisionId(rootJobId, sourceImageId, jobId) {
  const digest = crypto
    .createHash("sha256")
    .update(`${rootJobId}\0${sourceImageId}\0${jobId}`)
    .digest("hex")
    .slice(0, 24);
  return `page_revision_${digest}`;
}

class PageRevisionService {
  constructor({ store, translatedImageService, sourcePreflightModule }) {
    this.store = store;
    this.translatedImageService = translatedImageService;
    this.sourcePreflightModule = sourcePreflightModule;
  }

  resolveRootJob(rootJobId) {
    const root = this.store.getJob(rootJobId);
    if (!root || root.type !== "translation") {
      throw apiError("Translation revision root Job was not found.", 404, "revision_root_not_found");
    }
    if (root.payload?.revision?.rootJobId && root.payload.revision.rootJobId !== root.id) {
      throw apiError(
        `Job ${root.id} is not a revision root; use ${root.payload.revision.rootJobId}.`,
        409,
        "revision_root_required"
      );
    }
    return root;
  }

  rootJobIdFor(job) {
    return job?.payload?.revision?.rootJobId || job?.id || null;
  }

  jobsForRoot(rootJobId) {
    return this.store.listJobs({ includeDeleted: false })
      .filter((job) =>
        job.type === "translation" &&
        job.status === "succeeded" &&
        (job.id === rootJobId || job.payload?.revision?.rootJobId === rootJobId)
      )
      .sort((left, right) =>
        String(left.createdAt).localeCompare(String(right.createdAt)) || left.id.localeCompare(right.id)
      );
  }

  loadSourceImages(job) {
    const preflightId = job.payload?.sourcePreflightId;
    if (!preflightId) {
      throw apiError(
        "Translation Job does not retain a source preflight.",
        409,
        "source_preflight_unavailable"
      );
    }
    let manifest;
    try {
      manifest = this.sourcePreflightModule.get(preflightId);
    } catch {
      throw apiError(
        "The retained source preflight is unavailable.",
        409,
        "source_preflight_unavailable"
      );
    }
    const ordered = (manifest.images || []).slice().sort((left, right) => left.orderIndex - right.orderIndex);
    const selectedIds = job.payload?.revision?.reason === "selective_retranslation"
      ? new Set(job.payload.sourceImageIds || [])
      : null;
    const images = selectedIds ? ordered.filter((image) => selectedIds.has(image.id)) : ordered;
    if (selectedIds && images.length !== selectedIds.size) {
      throw apiError(
        "The retranslation source-image selection no longer matches its retained preflight.",
        409,
        "source_preflight_mismatch"
      );
    }
    return { preflightId, manifest, images };
  }

  async synchronizeJob(jobId, { allowRunning = false } = {}) {
    const job = this.store.getJob(jobId);
    if (!job || job.type !== "translation") {
      throw apiError("Translation Job was not found.", 404, "translation_job_not_found");
    }
    if (job.status !== "succeeded" && !(allowRunning && job.status === "running")) return [];
    const rootJobId = this.rootJobIdFor(job);
    const existing = this.store.listTranslationPageRevisions(rootJobId)
      .filter((entry) => entry.jobId === job.id);
    if (existing.length > 0) return existing;

    const { preflightId, images: sourceImages } = this.loadSourceImages(job);
    const artifacts = this.store.getArtifacts(job.id);
    const translated = await this.translatedImageService.prepare({ jobId: job.id, artifacts });
    if (translated.images.length !== sourceImages.length) {
      throw apiError(
        `Translated output count ${translated.images.length} does not match selected source count ${sourceImages.length}.`,
        409,
        "translated_image_mapping_mismatch"
      );
    }

    const current = this.store.listTranslationPageRevisions(rootJobId);
    const pending = [];
    for (let index = 0; index < sourceImages.length; index += 1) {
      const source = sourceImages[index];
      const output = translated.images[index];
      const revisionNumber = current.filter((entry) => entry.sourceImageId === source.id).length + 1;
      pending.push({
        revisionId: revisionId(rootJobId, source.id, job.id),
        rootJobId,
        parentJobId: job.payload?.revision?.parentJobId || null,
        jobId: job.id,
        sourcePreflightId: preflightId,
        sourceImageId: source.id,
        sourceOrderIndex: source.orderIndex,
        jobImageId: output.id,
        jobImageIndex: output.index,
        fileName: output.fileName,
        mediaType: output.mediaType,
        size: output.size,
        revisionNumber,
        translationTarget: job.payload?.translationTarget || job.result?.translationTarget || null,
        sourceLanguage: job.payload?.sourceLanguage || null,
        targetLanguage: job.payload?.targetLanguage || null,
        instructions: job.payload?.instructions || null,
        createdAt: job.createdAt,
      });
    }
    return this.store.registerTranslationPageRevisions(pending, {
      initializeActive: job.id === rootJobId,
    });
  }

  async synchronizeRoot(rootJobId) {
    this.resolveRootJob(rootJobId);
    for (const job of this.jobsForRoot(rootJobId)) {
      await this.synchronizeJob(job.id);
    }
  }

  publicRevision(entry, activeRevisionId) {
    const base = `/api/v1/jobs/${encodeURIComponent(entry.jobId)}/translated-images/${encodeURIComponent(entry.jobImageId)}`;
    return {
      revisionId: entry.revisionId,
      revisionNumber: entry.revisionNumber,
      active: entry.revisionId === activeRevisionId,
      jobId: entry.jobId,
      parentJobId: entry.parentJobId,
      translationTarget: entry.translationTarget,
      sourceLanguage: entry.sourceLanguage,
      targetLanguage: entry.targetLanguage,
      instructions: entry.instructions,
      createdAt: entry.createdAt,
      image: {
        id: entry.jobImageId,
        index: entry.jobImageIndex,
        fileName: entry.fileName,
        mediaType: entry.mediaType,
        size: entry.size,
        encodedUrl: base,
        contentUrl: `${base}/content`,
      },
    };
  }

  async list(rootJobId) {
    const root = this.resolveRootJob(rootJobId);
    await this.synchronizeRoot(rootJobId);
    const manifest = this.sourcePreflightModule.get(root.payload.sourcePreflightId);
    const revisions = this.store.listTranslationPageRevisions(rootJobId);
    const activeBySource = new Map(
      this.store.listActiveTranslationPageRevisions(rootJobId)
        .map((entry) => [entry.sourceImageId, entry.revisionId])
    );
    const pages = (manifest.images || [])
      .slice()
      .sort((left, right) => left.orderIndex - right.orderIndex)
      .map((source) => {
        const activeRevisionId = activeBySource.get(source.id) || null;
        return {
          sourceImageId: source.id,
          sourceOrderIndex: source.orderIndex,
          sourceFileName: source.fileName,
          activeRevisionId,
          revisions: revisions
            .filter((entry) => entry.sourceImageId === source.id)
            .map((entry) => this.publicRevision(entry, activeRevisionId)),
        };
      });
    return {
      rootJobId,
      sourcePreflightId: root.payload.sourcePreflightId,
      pageCount: pages.length,
      pages,
    };
  }

  async activate(rootJobId, selections) {
    if (!Array.isArray(selections) || selections.length === 0) {
      throw apiError("selections must be a non-empty array.", 400, "invalid_page_revision_selection");
    }
    const sourceIds = new Set();
    for (const selection of selections) {
      if (!selection || typeof selection !== "object" || Array.isArray(selection) ||
          Object.keys(selection).some((key) => !["sourceImageId", "revisionId"].includes(key))) {
        throw apiError(
          "Every selection must contain only sourceImageId and revisionId.",
          400,
          "invalid_page_revision_selection"
        );
      }
      const sourceImageId = typeof selection?.sourceImageId === "string" ? selection.sourceImageId.trim() : "";
      const selectedRevisionId = typeof selection?.revisionId === "string" ? selection.revisionId.trim() : "";
      if (!sourceImageId || !selectedRevisionId) {
        throw apiError(
          "Every selection requires sourceImageId and revisionId.",
          400,
          "invalid_page_revision_selection"
        );
      }
      if (sourceIds.has(sourceImageId)) {
        throw apiError(
          `Duplicate sourceImageId in selections: ${sourceImageId}.`,
          400,
          "duplicate_source_image_selection"
        );
      }
      sourceIds.add(sourceImageId);
    }
    await this.synchronizeRoot(rootJobId);
    this.store.activateTranslationPageRevisions(rootJobId, selections.map((entry) => ({
      sourceImageId: entry.sourceImageId.trim(),
      revisionId: entry.revisionId.trim(),
    })));
    return this.list(rootJobId);
  }

  async enrichTranslatedImages(jobId, response) {
    const job = this.store.getJob(jobId);
    if (!job || job.type !== "translation" || job.status !== "succeeded") return response;
    await this.synchronizeRoot(this.rootJobIdFor(job));
    const activeBySource = new Map(
      this.store.listActiveTranslationPageRevisions(this.rootJobIdFor(job))
        .map((entry) => [entry.sourceImageId, entry.revisionId])
    );
    const revisions = this.store.listTranslationPageRevisions(this.rootJobIdFor(job))
      .filter((entry) => entry.jobId === jobId);
    const byImageId = new Map(revisions.map((entry) => [entry.jobImageId, entry]));
    return {
      ...response,
      rootJobId: this.rootJobIdFor(job),
      images: response.images.map((image) => {
        const entry = byImageId.get(image.id);
        if (!entry) return image;
        return {
          ...image,
          sourceImageId: entry.sourceImageId,
          sourceOrderIndex: entry.sourceOrderIndex,
          revisionId: entry.revisionId,
          revisionNumber: entry.revisionNumber,
          active: activeBySource.get(entry.sourceImageId) === entry.revisionId,
        };
      }),
    };
  }
}

module.exports = {
  PageRevisionService,
  revisionId,
};
