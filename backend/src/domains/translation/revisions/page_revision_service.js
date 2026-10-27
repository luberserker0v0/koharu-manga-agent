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
      throw apiError(
        "Translation revision root Job was not found.",
        404,
        "revision_root_not_found",
      );
    }
    if (
      root.payload?.revision?.rootJobId &&
      root.payload.revision.rootJobId !== root.id
    ) {
      throw apiError(
        `Job ${root.id} is not a revision root; use ${root.payload.revision.rootJobId}.`,
        409,
        "revision_root_required",
      );
    }
    return root;
  }

  rootJobIdFor(job) {
    return job?.payload?.revision?.rootJobId || job?.id || null;
  }

  jobsForRoot(rootJobId) {
    return this.store
      .listJobs({ includeDeleted: false })
      .filter(
        (job) =>
          job.type === "translation" &&
          job.status === "succeeded" &&
          (job.id === rootJobId ||
            job.payload?.revision?.rootJobId === rootJobId),
      )
      .sort(
        (left, right) =>
          String(left.createdAt).localeCompare(String(right.createdAt)) ||
          left.id.localeCompare(right.id),
      );
  }

  loadSourceImages(job) {
    const preflightId = job.payload?.sourcePreflightId;
    if (!preflightId) {
      throw apiError(
        "Translation Job does not retain a source preflight.",
        409,
        "source_preflight_unavailable",
      );
    }
    const manifest = this.getPreflightManifest(preflightId);
    const images = this.selectSourceImages(manifest, job);
    return { preflightId, manifest, images };
  }

  getPreflightManifest(preflightId) {
    try {
      return this.sourcePreflightModule.get(preflightId);
    } catch {
      throw apiError(
        "The retained source preflight is unavailable.",
        409,
        "source_preflight_unavailable",
      );
    }
  }

  selectSourceImages(manifest, job) {
    const ordered = (manifest.images || [])
      .slice()
      .sort((left, right) => left.orderIndex - right.orderIndex);
    const revisionImageIds = job.payload?.revision?.sourceImageIds;
    const selectedIds = Array.isArray(revisionImageIds) ? new Set(revisionImageIds) : null;
    const images = selectedIds
      ? ordered.filter((image) => selectedIds.has(image.id))
      : ordered;
    if (selectedIds && images.length !== selectedIds.size) {
      throw apiError(
        "The translation revision source-image selection no longer matches its retained preflight.",
        409,
        "source_preflight_mismatch",
      );
    }
    return images;
  }

  synchronizableJob(jobId, allowRunning) {
    const job = this.store.getJob(jobId);
    if (!job || job.type !== "translation") {
      throw apiError("Translation Job was not found.", 404, "translation_job_not_found");
    }
    const eligible = job.status === "succeeded" || (allowRunning && job.status === "running");
    return { job, eligible };
  }

  assertOutputCount(translated, sourceImages) {
    if (translated.images.length === sourceImages.length) return;
    throw apiError(
      `Translated output count ${translated.images.length} does not match selected source count ${sourceImages.length}.`,
      409,
      "translated_image_mapping_mismatch",
    );
  }

  async synchronizeJob(jobId, { allowRunning = false } = {}) {
    const { job, eligible } = this.synchronizableJob(jobId, allowRunning);
    if (!eligible) return [];
    const rootJobId = this.rootJobIdFor(job);
    const existing = this.store
      .listTranslationPageRevisions(rootJobId)
      .filter((entry) => entry.jobId === job.id);
    if (existing.length > 0) return existing;

    const { preflightId, images: sourceImages } = this.loadSourceImages(job);
    const artifacts = this.store.getArtifacts(job.id);
    const translated = await this.translatedImageService.prepare({
      jobId: job.id,
      artifacts,
    });
    this.assertOutputCount(translated, sourceImages);
    const current = this.store.listTranslationPageRevisions(rootJobId);
    const pending = this.buildPendingRevisions(
      rootJobId,
      job,
      preflightId,
      sourceImages,
      translated.images,
      current,
    );
    return this.store.registerTranslationPageRevisions(pending, {
      initializeActive: job.id === rootJobId,
    });
  }

  buildPendingRevisions(
    rootJobId,
    job,
    preflightId,
    sourceImages,
    translatedImages,
    current,
  ) {
    return sourceImages.map((source, index) =>
      this.buildPendingRevision(
        rootJobId,
        job,
        preflightId,
        source,
        translatedImages[index],
        current,
      ),
    );
  }

  buildPendingRevision(rootJobId, job, preflightId, source, output, current) {
    const revisionNumber =
      current.filter((entry) => entry.sourceImageId === source.id).length + 1;
    return {
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
      translationTarget:
        job.payload?.translationTarget || job.result?.translationTarget || null,
      sourceLanguage: job.payload?.sourceLanguage || null,
      targetLanguage: job.payload?.targetLanguage || null,
      instructions: job.payload?.instructions || null,
      createdAt: job.createdAt,
    };
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
    const manifest = this.sourcePreflightModule.get(
      root.payload.sourcePreflightId,
    );
    const revisions = this.store.listTranslationPageRevisions(rootJobId);
    const activeBySource = this.activeRevisionMap(rootJobId);
    const pages = this.buildRevisionPages(manifest, revisions, activeBySource);
    return {
      rootJobId,
      sourcePreflightId: root.payload.sourcePreflightId,
      pageCount: pages.length,
      pages,
    };
  }

  activeRevisionMap(rootJobId) {
    return new Map(
      this.store
        .listActiveTranslationPageRevisions(rootJobId)
        .map((entry) => [entry.sourceImageId, entry.revisionId]),
    );
  }

  buildRevisionPages(manifest, revisions, activeBySource) {
    return (manifest.images || [])
      .slice()
      .sort((left, right) => left.orderIndex - right.orderIndex)
      .map((source) =>
        this.buildRevisionPage(source, revisions, activeBySource),
      );
  }

  buildRevisionPage(source, revisions, activeBySource) {
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
  }

  async activate(rootJobId, selections) {
    this.validatePageRevisionSelections(selections);
    await this.synchronizeRoot(rootJobId);
    this.store.activateTranslationPageRevisions(
      rootJobId,
      selections.map((entry) => ({
        sourceImageId: entry.sourceImageId.trim(),
        revisionId: entry.revisionId.trim(),
      })),
    );
    return this.list(rootJobId);
  }

  validatePageRevisionSelections(selections) {
    if (!Array.isArray(selections) || selections.length === 0) {
      throw apiError(
        "selections must be a non-empty array.",
        400,
        "invalid_page_revision_selection",
      );
    }
    const sourceIds = new Set();
    for (const selection of selections)
      this.validatePageRevisionSelection(selection, sourceIds);
  }

  validateSelectionShape(selection) {
    const invalid = !selection || typeof selection !== "object" || Array.isArray(selection)
      || Object.keys(selection).some((key) => !["sourceImageId", "revisionId"].includes(key));
    if (invalid) throw apiError(
      "Every selection must contain only sourceImageId and revisionId.",
      400,
      "invalid_page_revision_selection",
    );
  }

  selectionIds(selection) {
    const sourceImageId = typeof selection.sourceImageId === "string" ? selection.sourceImageId.trim() : "";
    const selectedRevisionId = typeof selection.revisionId === "string" ? selection.revisionId.trim() : "";
    if (!sourceImageId || !selectedRevisionId) throw apiError(
      "Every selection requires sourceImageId and revisionId.", 400, "invalid_page_revision_selection",
    );
    return { sourceImageId, selectedRevisionId };
  }

  validatePageRevisionSelection(selection, sourceIds) {
    this.validateSelectionShape(selection);
    const { sourceImageId } = this.selectionIds(selection);
    if (sourceIds.has(sourceImageId)) {
      throw apiError(
        `Duplicate sourceImageId in selections: ${sourceImageId}.`,
        400,
        "duplicate_source_image_selection",
      );
    }
    sourceIds.add(sourceImageId);
  }

  revisionLookup(rootJobId, jobId) {
    const activeBySource = new Map(this.store.listActiveTranslationPageRevisions(rootJobId)
      .map((entry) => [entry.sourceImageId, entry.revisionId]));
    const byImageId = new Map(this.store.listTranslationPageRevisions(rootJobId)
      .filter((entry) => entry.jobId === jobId)
      .map((entry) => [entry.jobImageId, entry]));
    return { activeBySource, byImageId };
  }

  enrichImage(image, lookup) {
    const entry = lookup.byImageId.get(image.id);
    if (!entry) return image;
    return {
      ...image,
      sourceImageId: entry.sourceImageId,
      sourceOrderIndex: entry.sourceOrderIndex,
      revisionId: entry.revisionId,
      revisionNumber: entry.revisionNumber,
      active: lookup.activeBySource.get(entry.sourceImageId) === entry.revisionId,
    };
  }

  compositeRevisionLookup(rootJobId) {
    const root = this.resolveRootJob(rootJobId);
    const sources = this.getPreflightManifest(root.payload.sourcePreflightId).images || [];
    const revisions = new Map(this.store.listTranslationPageRevisions(rootJobId)
      .map((entry) => [entry.revisionId, entry]));
    const active = new Map(this.store.listActiveTranslationPageRevisions(rootJobId)
      .map((entry) => [entry.sourceImageId, revisions.get(entry.revisionId)]));
    return new Map(sources.map((source) => [source.orderIndex, {
      source,
      revision: active.get(source.id),
    }]));
  }

  enrichCompositeImage(image, lookup) {
    const selected = lookup.get(image.index);
    if (!selected?.revision) return image;
    return {
      ...image,
      sourceImageId: selected.source.id,
      sourceOrderIndex: selected.source.orderIndex,
      revisionId: selected.revision.revisionId,
      revisionNumber: selected.revision.revisionNumber,
      active: true,
    };
  }

  isCurrentChapterArtifact(jobId, artifactId) {
    return this.store.getArtifacts(jobId).some(
      (entry) => entry.id === artifactId && entry.kind === "current_chapter_export",
    );
  }

  async enrichTranslatedImages(jobId, response) {
    const job = this.store.getJob(jobId);
    if (!job || job.type !== "translation" || job.status !== "succeeded")
      return response;
    const rootJobId = this.rootJobIdFor(job);
    await this.synchronizeRoot(rootJobId);
    if (this.isCurrentChapterArtifact(jobId, response.artifactId)) {
      const lookup = this.compositeRevisionLookup(rootJobId);
      return { ...response, rootJobId,
        images: response.images.map((image) => this.enrichCompositeImage(image, lookup)) };
    }
    const lookup = this.revisionLookup(rootJobId, jobId);
    return {
      ...response,
      rootJobId,
      images: response.images.map((image) => this.enrichImage(image, lookup)),
    };
  }
}

module.exports = {
  PageRevisionService,
  revisionId,
};
