const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { createZip } = require("../../../infrastructure/archive/zip_archive");
const { writeJsonAtomic } = require("../../../infrastructure/filesystem/json_file");

function promotionError(message, code) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}

function readJson(filePath, label) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw promotionError(`${label} is unavailable.`, "revision_source_artifact_unavailable");
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function regionFingerprint(snapshot) {
  return `region_snapshot_${sha256(snapshot).slice(0, 24)}`;
}

function orderedImages(manifest) {
  return [...(manifest.images || [])].sort((left, right) => left.orderIndex - right.orderIndex);
}

function activePublication(service, identity) {
  const chapter = service.getChapter(identity.mangaId, identity.translatorId, identity.chapterId);
  return chapter?.revisions?.find((entry) => entry.revisionId === chapter.activeRevisionId) || null;
}

function sourcePageName(source, regionPage) {
  return regionPage?.pageName || source.orderedName || source.fileName;
}

function selectPostEditPage(document, sourceImageId) {
  return Object.values(document.pages || {}).find((page) => page.sourceImageId === sourceImageId) || null;
}

function safeResetDirectory(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw promotionError("Revision staging path is invalid.", "revision_staging_path_invalid");
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
}

function buildFinalSnapshot(base, context, pages) {
  const snapshot = {
    ...base,
    jobId: context.job.id,
    generatedAt: new Date().toISOString(),
    translations: pages.flatMap((page) => page.translations),
    pageRevisions: pages.map((page) => page.provenance),
  };
  delete snapshot.fingerprint;
  return { ...snapshot, fingerprint: sha256(snapshot) };
}

function buildRegionSnapshot(context, pages) {
  const snapshot = {
    schemaVersion: 1,
    jobId: context.job.id,
    rootJobId: context.root.id,
    sourcePreflightId: context.root.payload.sourcePreflightId,
    createdAt: new Date().toISOString(),
    pages: pages.map((page) => page.regionPage),
  };
  return { ...snapshot, fingerprint: regionFingerprint(snapshot) };
}

function buildPostEditDocument(context, pages) {
  const pageOrder = pages.map((page) => page.postEditPage.pageId);
  const pageMap = Object.fromEntries(pages.map((page) => [page.postEditPage.pageId, page.postEditPage]));
  const now = new Date().toISOString();
  return {
    jobId: context.job.id,
    sourcePreflightId: context.root.payload.sourcePreflightId,
    mangaId: context.identity.mangaId,
    translatorId: context.identity.translatorId,
    chapterId: context.identity.chapterId,
    createdAt: now,
    updatedAt: now,
    sourcePageOrder: [...pageOrder],
    pageOrder,
    pages: pageMap,
    stats: { pageCount: pages.length, textNodeCount: countPostEditNodes(pages) },
  };
}

function countPostEditNodes(pages) {
  return pages.reduce((total, page) => total + (page.postEditPage.nodeOrder?.length || 0), 0);
}

function outputPaths(result) {
  const workspace = path.dirname(result.finalTranslationSnapshotPath);
  const outputDir = path.dirname(result.artifact.path);
  return {
    workspace,
    stagingDir: path.join(workspace, "current-chapter-images"),
    exportPath: path.join(outputDir, "current_chapter.zip"),
    finalSnapshotPath: result.finalTranslationSnapshotPath,
    regionSnapshotPath: result.regionSnapshotPath,
    postEditDocumentPath: result.postEditDocumentPath,
  };
}

function publicationQuality(result, previous) {
  const quality = result.quality || null;
  return {
    qualityStatus: quality?.status || previous?.qualityStatus || "not_applicable",
    qualityOutcome: quality?.semanticResult?.outcome || previous?.qualityOutcome || null,
    qualityReportPath: quality?.reportPath || null,
    qualityObservationFingerprint: quality?.qualityObservation?.fingerprint || null,
    completenessStatus: quality?.completenessStatus || "complete",
    qualityWarningCount: (quality?.warnings?.length || 0) + (quality?.semanticResult?.warnings?.length || 0),
    verifiedAt: quality?.finalVerification?.verifiedAt || new Date().toISOString(),
  };
}

class TranslationRevisionPromotionService {
  constructor(dependencies) {
    Object.assign(this, dependencies);
    this.createZip = dependencies.createZip || createZip;
  }

  createContext(jobId, result) {
    const job = this.store.getJob(jobId);
    if (!job?.payload?.revision?.rootJobId) return null;
    const root = this.pageRevisionService.resolveRootJob(job.payload.revision.rootJobId);
    const identity = {
      mangaId: job.payload.mangaId,
      translatorId: job.payload.translatorId,
      chapterId: job.payload.chapterId,
    };
    return { job, root, result, identity };
  }

  buildSelectionPlan(context) {
    const rootJobId = context.root.id;
    const revisions = this.store.listTranslationPageRevisions(rootJobId);
    const revisionsById = new Map(revisions.map((entry) => [entry.revisionId, entry]));
    const selected = new Map(this.store.listActiveTranslationPageRevisions(rootJobId)
      .map((entry) => [entry.sourceImageId, revisionsById.get(entry.revisionId)]));
    const candidates = revisions.filter((entry) => entry.jobId === context.job.id);
    for (const revision of candidates) selected.set(revision.sourceImageId, revision);
    const manifest = this.sourcePreflightModule.get(context.root.payload.sourcePreflightId);
    const sources = orderedImages(manifest);
    const ordered = sources.map((source) => ({ source, revision: selected.get(source.id) }));
    if (candidates.length === 0 || ordered.some((entry) => !entry.revision)) {
      throw promotionError("Revision cannot produce a complete chapter selection.", "revision_selection_incomplete");
    }
    return { candidates, ordered };
  }

  producerResult(context, jobId) {
    if (jobId === context.job.id) return context.result;
    const producer = this.store.getJob(jobId);
    if (!producer?.result) {
      throw promotionError(`Revision producer ${jobId} is unavailable.`, "revision_producer_unavailable");
    }
    return producer.result;
  }

  loadProducer(context, revision, cache) {
    if (cache.has(revision.jobId)) return cache.get(revision.jobId);
    const result = this.producerResult(context, revision.jobId);
    const loaded = {
      final: readJson(result.finalTranslationSnapshotPath, "Final translation snapshot"),
      region: readJson(result.regionSnapshotPath, "Text-region snapshot"),
      postEdit: readJson(result.postEditDocumentPath, "Post-edit document"),
    };
    cache.set(revision.jobId, loaded);
    return loaded;
  }

  async buildPage(context, selection, cache) {
    const { source, revision } = selection;
    const producer = this.loadProducer(context, revision, cache);
    const regionPage = producer.region.pages?.find((page) => page.sourceImageId === source.id);
    const postEditPage = selectPostEditPage(producer.postEdit, source.id);
    if (!regionPage || !postEditPage) {
      throw promotionError(`Revision page data is incomplete for ${source.id}.`, "revision_page_data_incomplete");
    }
    const pageName = sourcePageName(source, regionPage);
    const translations = (producer.final.translations || []).filter((entry) => entry.pageName === pageName);
    const image = await this.resolveRevisionImage(revision);
    return { source, revision, regionPage, postEditPage, translations, image,
      provenance: { sourceImageId: source.id, revisionId: revision.revisionId, jobId: revision.jobId } };
  }

  async resolveRevisionImage(revision) {
    const artifacts = this.store.getArtifacts(revision.jobId);
    const found = await this.translatedImageService.find({
      jobId: revision.jobId,
      artifacts,
      imageId: revision.jobImageId,
    });
    return found.image;
  }

  async buildPages(context, plan) {
    const cache = new Map();
    const pages = [];
    for (const selection of plan.ordered) {
      pages.push(await this.buildPage(context, selection, cache));
    }
    return pages;
  }

  stageImages(paths, pages) {
    safeResetDirectory(paths.workspace, paths.stagingDir);
    pages.forEach((page, index) => {
      const extension = path.extname(page.image.path).toLowerCase() || ".png";
      const fileName = `page-${String(index + 1).padStart(4, "0")}${extension}`;
      fs.copyFileSync(page.image.path, path.join(paths.stagingDir, fileName));
    });
    this.createZip(paths.stagingDir, paths.exportPath);
    const stat = fs.statSync(paths.exportPath);
    return { path: paths.exportPath, size: stat.size, format: "zip", pageCount: pages.length };
  }

  writeCompositeFiles(context, pages) {
    const paths = outputPaths(context.result);
    const final = buildFinalSnapshot(this.loadBaseFinal(context, pages), context, pages);
    const region = buildRegionSnapshot(context, pages);
    const postEdit = buildPostEditDocument(context, pages);
    const exportArtifact = this.stageImages(paths, pages);
    writeJsonAtomic(paths.finalSnapshotPath, final);
    writeJsonAtomic(paths.regionSnapshotPath, region);
    writeJsonAtomic(paths.postEditDocumentPath, postEdit);
    return { paths, final, region, postEdit, exportArtifact };
  }

  loadBaseFinal(context, pages) {
    const preferred = pages.find((page) => page.revision.jobId === context.job.id) || pages[0];
    const result = this.producerResult(context, preferred.revision.jobId);
    return readJson(result.finalTranslationSnapshotPath, "Final translation snapshot");
  }

  publicationInput(context, composite, previous) {
    const payload = context.job.payload;
    return {
      ...context.identity,
      chapterTitle: payload.chapterTitle || payload.chapterLabel || null,
      jobId: context.job.id,
      finalTranslationSnapshotPath: composite.paths.finalSnapshotPath,
      finalTranslationSnapshotFingerprint: composite.final.fingerprint,
      translationMemoryFingerprint: context.result.translationMemoryFingerprint || null,
      postEditDocumentPath: composite.paths.postEditDocumentPath,
      exportArtifact: composite.exportArtifact,
      manualOverrideCount: (previous?.manualOverrideCount || 0) + 1,
      ...publicationQuality(context.result, previous),
    };
  }

  commit(context, plan, composite) {
    const previousSelections = this.store.listActiveTranslationPageRevisions(context.root.id);
    const selections = plan.candidates.map((entry) => ({
      sourceImageId: entry.sourceImageId,
      revisionId: entry.revisionId,
    }));
    const previous = activePublication(this.translationPublicationService, context.identity);
    this.store.activateTranslationPageRevisions(context.root.id, selections);
    try {
      return this.translationPublicationService.publish(this.publicationInput(context, composite, previous));
    } catch (error) {
      this.restoreSelections(context.root.id, selections, previousSelections);
      throw error;
    }
  }

  restoreSelections(rootJobId, changed, previous) {
    const priorBySource = new Map(previous.map((entry) => [entry.sourceImageId, entry.revisionId]));
    const restore = changed.map((entry) => ({
      sourceImageId: entry.sourceImageId,
      revisionId: priorBySource.get(entry.sourceImageId),
    })).filter((entry) => entry.revisionId);
    if (restore.length > 0) this.store.activateTranslationPageRevisions(rootJobId, restore);
  }

  markPreviousJobSuperseded(publication) {
    const previousJob = publication?.previousActiveJobId && this.store.getJob(publication.previousActiveJobId);
    if (!previousJob?.result?.publication) return;
    this.store.updateJob({ id: previousJob.id, result: {
      ...previousJob.result,
      publication: {
        ...previousJob.result.publication,
        status: "superseded",
        supersededByRevisionId: publication.revisionId,
      },
    } });
  }

  async promote(jobId, result) {
    const context = this.createContext(jobId, result);
    if (!context) return result;
    const plan = this.buildSelectionPlan(context);
    const pages = await this.buildPages(context, plan);
    const composite = this.writeCompositeFiles(context, pages);
    const publication = this.commit(context, plan, composite);
    this.markPreviousJobSuperseded(publication);
    return this.buildPromotedResult(context, composite, publication, pages);
  }

  buildPromotedResult(context, composite, publication, pages) {
    return {
      ...context.result,
      artifact: composite.exportArtifact,
      pageRevisionArtifact: context.result.artifact,
      finalTranslationSnapshotPath: composite.paths.finalSnapshotPath,
      regionSnapshotPath: composite.paths.regionSnapshotPath,
      regionSnapshotFingerprint: composite.region.fingerprint,
      postEditDocumentPath: composite.paths.postEditDocumentPath,
      publication,
      currentChapter: {
        rootJobId: context.root.id,
        pageCount: pages.length,
        exportArtifact: composite.exportArtifact,
        finalTranslationSnapshotFingerprint: composite.final.fingerprint,
        promotedSourceImageIds: context.job.payload.revision.sourceImageIds || [],
      },
    };
  }
}

module.exports = {
  TranslationRevisionPromotionService,
  buildFinalSnapshot,
  buildPostEditDocument,
  buildRegionSnapshot,
};
