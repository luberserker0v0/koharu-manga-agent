const fs = require("fs");
const path = require("path");

const { paths } = require("../../backend/src/config");
const { createZipBuffer } = require("../../backend/src/integrations/ao/assets/ao_assets");
const { JobStore } = require("../../backend/src/domains/jobs/persistence/job_store");
const { TranslatedImageService } = require("../../backend/src/domains/translation/exports/translated_image_service");
const { PageRevisionService } = require("../../backend/src/domains/translation/revisions/page_revision_service");
const {
  TranslationRevisionPromotionService,
} = require("../../backend/src/domains/translation/revisions/translation_revision_promotion");
const {
  TranslationPublicationService,
} = require("../../backend/src/domains/translation/publications/translation_publications");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
  return filePath;
}

function finalSnapshot(jobId, translations) {
  return { schemaVersion: 2, jobId, mangaId: "manga", translatorId: "translator",
    chapterId: "chapter", translationMode: "quick", translations, fingerprint: `${jobId}-fingerprint` };
}

function regionSnapshot(jobId, pages) {
  return { schemaVersion: 1, jobId, rootJobId: "root-job", sourcePreflightId: "preflight", pages };
}

function regionPage(sourceImageId, order, pageName, text) {
  return { sourceImageId, sourceOrderIndex: order, sourceFileName: pageName,
    internalPageId: `${sourceImageId}-page`, pageName, regions: [{ internalNodeId: `${sourceImageId}-node`,
      sourceText: text, translatedText: `${text}-translated`, geometry: { x: 1, y: 2, width: 3, height: 4 } }] };
}

function postEditDocument(jobId, pages) {
  const records = pages.map((page) => [page.internalPageId, { pageId: page.internalPageId,
    pageName: page.pageName, sourceImageId: page.sourceImageId, nodeOrder: [], nodes: {} }]);
  const pageOrder = records.map(([pageId]) => pageId);
  return { jobId, sourcePreflightId: "preflight", mangaId: "manga", translatorId: "translator",
    chapterId: "chapter", sourcePageOrder: pageOrder, pageOrder, pages: Object.fromEntries(records) };
}

describe("TranslationRevisionPromotionService", () => {
  let root;
  let store;
  let pageRevisionService;
  let promotionService;
  let publicationService;
  let sourceImages;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(paths.workspaceRoot, "revision-promotion-"));
    store = new JobStore(path.join(root, "jobs.sqlite"));
    sourceImages = [1, 2].map((number, orderIndex) => ({ id: `source-${number}`, orderIndex,
      fileName: `${number}.png`, orderedName: `${number}.png` }));
    const translatedImageService = new TranslatedImageService({ root: path.join(root, "cache") });
    const sourcePreflightModule = { get: jest.fn().mockReturnValue({ images: sourceImages }) };
    pageRevisionService = new PageRevisionService({ store, translatedImageService, sourcePreflightModule });
    publicationService = new TranslationPublicationService({ resolveBaseDir: () => path.join(root, "publication") });
    promotionService = new TranslationRevisionPromotionService({ store, pageRevisionService,
      translatedImageService, sourcePreflightModule, translationPublicationService: publicationService,
      createZip: createTestZip });
  });

  afterEach(() => {
    store.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function createTestZip(sourcePath, destinationPath) {
    const entries = fs.readdirSync(sourcePath).sort().map((name) => ({
      name,
      content: fs.readFileSync(path.join(sourcePath, name)),
    }));
    fs.writeFileSync(destinationPath, createZipBuffer(entries));
  }

  function createJobFiles(jobId, pages, imageNames) {
    const workspace = path.join(root, jobId);
    const finalPath = writeJson(path.join(workspace, "final.json"), finalSnapshot(jobId,
      pages.flatMap((page) => page.regions.map((region) => ({ pageName: page.pageName,
        original: region.sourceText, translation: region.translatedText })))));
    const regionPath = writeJson(path.join(workspace, "region.json"), regionSnapshot(jobId, pages));
    const postEditPath = writeJson(path.join(workspace, "post.json"), postEditDocument(jobId, pages));
    const exportPath = path.join(workspace, imageNames.length === 1 ? "export.png" : "export.zip");
    if (imageNames.length === 1) fs.writeFileSync(exportPath, Buffer.from(imageNames[0]));
    else fs.writeFileSync(exportPath, createZipBuffer(imageNames.map((name) => ({ name, content: Buffer.from(name) }))));
    return { finalTranslationSnapshotPath: finalPath, regionSnapshotPath: regionPath,
      postEditDocumentPath: postEditPath, artifact: { path: exportPath }, translationMemoryFingerprint: "memory" };
  }

  function createStoredJob(id, status, payload, result) {
    store.createJob({ id, type: "translation", status, stage: status, payload });
    store.updateJob({ id, status, stage: status, result });
    store.addArtifact(id, "export", result.artifact.path, result.artifact);
  }

  async function prepareJobs() {
    const rootPages = [regionPage("source-1", 0, "1.png", "old-1"), regionPage("source-2", 1, "2.png", "old-2")];
    const revisedPages = [regionPage("source-2", 1, "2.png", "new-2")];
    const rootResult = createJobFiles("root-job", rootPages, ["1.png", "2.png"]);
    const revisionResult = createJobFiles("revision-job", revisedPages, ["2-new.png"]);
    const identity = { sourcePreflightId: "preflight", mangaId: "manga", translatorId: "translator",
      chapterId: "chapter", translationMode: "quick" };
    createStoredJob("root-job", "succeeded", identity, rootResult);
    const publication = publicationService.publish({ ...identity, jobId: "root-job",
      finalTranslationSnapshotPath: rootResult.finalTranslationSnapshotPath,
      finalTranslationSnapshotFingerprint: "root-fingerprint", exportArtifact: rootResult.artifact,
      postEditDocumentPath: rootResult.postEditDocumentPath, qualityStatus: "not_applicable" });
    store.updateJob({ id: "root-job", result: { ...rootResult, publication } });
    createStoredJob("revision-job", "running", { ...identity, sourceImageIds: ["source-2"],
      revision: { rootJobId: "root-job", parentJobId: "root-job",
        reason: "text_region_correction", sourceImageIds: ["source-2"] } }, revisionResult);
    await pageRevisionService.synchronizeJob("root-job");
    await pageRevisionService.synchronizeJob("revision-job", { allowRunning: true });
    return revisionResult;
  }

  test("promotes a corrected page into a complete current chapter", async () => {
    const revisionResult = await prepareJobs();
    const promoted = await promotionService.promote("revision-job", revisionResult);
    const final = JSON.parse(fs.readFileSync(promoted.finalTranslationSnapshotPath, "utf8"));
    const region = JSON.parse(fs.readFileSync(promoted.regionSnapshotPath, "utf8"));
    const active = store.listActiveTranslationPageRevisions("root-job");

    expect(final.translations.map((entry) => entry.original)).toEqual(["old-1", "new-2"]);
    expect(region.pages.map((page) => page.regions[0].sourceText)).toEqual(["old-1", "new-2"]);
    expect(promoted.currentChapter).toEqual(expect.objectContaining({ rootJobId: "root-job", pageCount: 2 }));
    expect(promoted.artifact.path).toBe(promoted.currentChapter.exportArtifact.path);
    expect(promoted.pageRevisionArtifact.path).toContain("export.png");
    expect(fs.existsSync(promoted.currentChapter.exportArtifact.path)).toBe(true);
    expect(active.find((entry) => entry.sourceImageId === "source-2").revisionId)
      .toBe(store.listTranslationPageRevisions("root-job").find((entry) => entry.jobId === "revision-job").revisionId);
    expect(publicationService.getChapter("manga", "translator", "chapter").activeRevisionId)
      .toBe("translation_revision_revision-job");
    expect(store.getJob("root-job").result.publication.status).toBe("superseded");
    store.updateJob({ id: "revision-job", status: "succeeded", stage: "succeeded", result: promoted });
    store.addArtifact("revision-job", "current_chapter_export",
      promoted.currentChapter.exportArtifact.path, promoted.currentChapter.exportArtifact);
    const images = await promotionService.translatedImageService.list({
      jobId: "revision-job", artifacts: store.getArtifacts("revision-job"),
    });
    const enriched = await pageRevisionService.enrichTranslatedImages("revision-job", images);
    expect(enriched.images.map((image) => image.sourceImageId)).toEqual(["source-1", "source-2"]);
    expect(enriched.images.every((image) => image.active)).toBe(true);
  });

  test("restores the previous active page when publication fails", async () => {
    const revisionResult = await prepareJobs();
    const before = store.listActiveTranslationPageRevisions("root-job");
    promotionService.translationPublicationService = {
      getChapter: (...args) => publicationService.getChapter(...args),
      publish: jest.fn(() => { throw new Error("publication failed"); }),
    };

    await expect(promotionService.promote("revision-job", revisionResult)).rejects.toThrow("publication failed");

    const selection = (entries) => entries.map(({ sourceImageId, revisionId }) => ({ sourceImageId, revisionId }));
    expect(selection(store.listActiveTranslationPageRevisions("root-job"))).toEqual(selection(before));
    expect(publicationService.getChapter("manga", "translator", "chapter").activeRevisionId)
      .toBe("translation_revision_root-job");
  });
});
