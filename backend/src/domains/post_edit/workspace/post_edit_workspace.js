const fs = require("fs");
const path = require("path");

const { paths } = require("../../../config");
const { collectSceneTextRegionPages } = require("../../../integrations/koharu/scene/scene_text_regions");

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function getPostEditPaths(jobId, root = paths.postEditDocuments) {
  const postEditRoot = path.join(root, jobId);
  return {
    postEditRoot,
    documentPath: path.join(postEditRoot, "post_edit_document.json"),
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
}

function buildPostEditNode(region) {
  const { x, y, width, height } = region.geometry;
  return {
    nodeId: region.internalNodeId,
    ...(region.regionId ? { regionId: region.regionId } : {}),
    originalText: region.sourceText,
    originalTranslation: region.translatedText,
    editedTranslation: region.translatedText,
    anchor: {
      pageName: region.pageName,
      x,
      y,
      width,
      height,
      centerX: x + width / 2,
      centerY: y + height / 2,
    },
  };
}

function buildPostEditDocumentFromScene({
  jobId,
  sourcePreflightId = null,
  mangaId = null,
  translatorId = null,
  chapterId = null,
  scene,
}) {
  return buildPostEditDocument({
    jobId, sourcePreflightId, mangaId, translatorId, chapterId,
    scenePages: collectSceneTextRegionPages(scene),
  });
}

function buildPostEditDocument({ jobId, sourcePreflightId, mangaId, translatorId, chapterId, scenePages }) {
  const { pageOrder, pages, totalNodes } = buildPostEditPages(scenePages);
  const now = new Date().toISOString();
  return {
    jobId,
    sourcePreflightId,
    mangaId,
    translatorId,
    chapterId,
    createdAt: now,
    updatedAt: now,
    sourcePageOrder: [...pageOrder],
    pageOrder,
    pages,
    stats: {
      pageCount: pageOrder.length,
      textNodeCount: totalNodes,
    },
  };
}

function snapshotScenePages(snapshot) {
  return (snapshot?.pages || []).map((page) => ({
    internalPageId: page.internalPageId,
    pageName: page.pageName,
    sourceImageId: page.sourceImageId,
    regionSetRevisionId: page.regionSetRevisionId,
    coordinateSpace: page.coordinateSpace,
    regions: (page.regions || []).map((region) => ({
      internalNodeId: region.internalNodeId,
      regionId: region.id,
      sourceText: region.sourceText,
      translatedText: region.translatedText,
      geometry: region.geometry,
      pageName: page.pageName,
    })),
  }));
}

function buildPostEditDocumentFromRegionSnapshot(input) {
  return buildPostEditDocument({
    jobId: input.jobId,
    sourcePreflightId: input.sourcePreflightId,
    mangaId: input.mangaId,
    translatorId: input.translatorId,
    chapterId: input.chapterId,
    scenePages: snapshotScenePages(input.snapshot),
  });
}

function buildPostEditPages(scenePages) {
  const pageOrder = scenePages.map((page) => page.internalPageId);
  const pages = {};
  let totalNodes = 0;
  for (const page of scenePages) {
    const built = buildPostEditPage(page);
    totalNodes += built.nodeOrder.length;
    pages[page.internalPageId] = built;
  }
  return { pageOrder, pages, totalNodes };
}

function buildPostEditPage(page) {
  const nodeOrder = page.regions.map((region) => region.internalNodeId);
  const nodes = {};
  for (const region of page.regions) {
    nodes[region.internalNodeId] = buildPostEditNode(region);
  }
  return {
    pageId: page.internalPageId,
    pageName: page.pageName,
    ...(page.sourceImageId ? { sourceImageId: page.sourceImageId } : {}),
    ...(page.regionSetRevisionId ? { regionSetRevisionId: page.regionSetRevisionId } : {}),
    ...(page.coordinateSpace ? { coordinateSpace: page.coordinateSpace } : {}),
    nodeOrder,
    nodes,
  };
}

function preserveNodeIdentity(currentNode, nextNode) {
  return currentNode?.regionId ? { ...nextNode, regionId: currentNode.regionId } : nextNode;
}

function preservePageIdentity(currentPage, nextPage) {
  if (!currentPage || !nextPage) return nextPage;
  const nodes = Object.fromEntries(Object.entries(nextPage.nodes || {}).map(([nodeId, node]) => [
    nodeId, preserveNodeIdentity(currentPage.nodes?.[nodeId], node),
  ]));
  return {
    ...nextPage,
    ...(currentPage.sourceImageId ? { sourceImageId: currentPage.sourceImageId } : {}),
    ...(currentPage.regionSetRevisionId ? { regionSetRevisionId: currentPage.regionSetRevisionId } : {}),
    ...(currentPage.coordinateSpace ? { coordinateSpace: currentPage.coordinateSpace } : {}),
    nodes,
  };
}

function preserveCorrectionIdentities(current, pages) {
  return Object.fromEntries(Object.entries(pages || {}).map(([pageId, page]) => [
    pageId, preservePageIdentity(current.pages?.[pageId], page),
  ]));
}

function validateAnchor(anchor, pageId, nodeId) {
  if (!anchor || typeof anchor !== "object") {
    throw new Error(`post edit node anchor must be an object for ${pageId}/${nodeId}.`);
  }
  if (typeof anchor.pageName !== "string" || !anchor.pageName.trim()) {
    throw new Error(`post edit node anchor.pageName is required for ${pageId}/${nodeId}.`);
  }
}

function validatePostEditDocument(jobId, payload) {
  if (!payload || typeof payload !== "object") { throw new Error("post edit document payload must be an object."); } if (payload.jobId !== jobId) { throw new Error("post edit document jobId does not match the requested job."); } if (payload.sourcePreflightId != null && typeof payload.sourcePreflightId !== "string") { throw new Error("post edit document sourcePreflightId must be a string or null."); } if (!Array.isArray(payload.pageOrder)) { throw new Error("post edit document pageOrder must be an array."); } if (!Array.isArray(payload.sourcePageOrder)) { throw new Error("post edit document sourcePageOrder must be an array."); } if (!payload.pages || typeof payload.pages !== "object") { throw new Error("post edit document pages must be an object."); } const pageIds = Object.keys(payload.pages); const sortedExpected = [...pageIds].sort(); const sortedActual = [...payload.pageOrder].sort(); const sortedSource = [...payload.sourcePageOrder].sort(); if (sortedExpected.join("|") !== sortedActual.join("|")) { throw new Error("post edit document pageOrder must contain every page exactly once."); } if (sortedExpected.join("|") !== sortedSource.join("|")) { throw new Error("post edit document sourcePageOrder must contain every page exactly once."); } for (const pageId of payload.pageOrder) { validatePostEditPage(pageId, payload.pages[pageId]); }
}

function validatePostEditPage(pageId, page) {
  if (!page || typeof page !== "object") {
    throw new Error(`post edit document page is missing: ${pageId}`);
  }
  if (typeof page.pageName !== "string" || !page.pageName.trim()) {
    throw new Error(`post edit document pageName is required for page ${pageId}.`);
  }
  if (!Array.isArray(page.nodeOrder)) {
    throw new Error(`post edit document nodeOrder must be an array for page ${pageId}.`);
  }
  if (!page.nodes || typeof page.nodes !== "object") {
    throw new Error(`post edit document nodes must be an object for page ${pageId}.`);
  }

  const nodeIds = Object.keys(page.nodes);
  const sortedNodeExpected = [...nodeIds].sort();
  const sortedNodeActual = [...page.nodeOrder].sort();
  if (sortedNodeExpected.join("|") !== sortedNodeActual.join("|")) {
    throw new Error(`post edit document nodeOrder must contain every node exactly once for page ${pageId}.`);
  }

  for (const nodeId of page.nodeOrder) {
    validatePostEditNode(pageId, nodeId, page.nodes[nodeId]);
  }
}

function validatePostEditNode(pageId, nodeId, node) {
  if (!node || typeof node !== "object") {
    throw new Error(`post edit document node is missing: ${pageId}/${nodeId}`);
  }
  if (typeof node.originalText !== "string") {
    throw new Error(`post edit node originalText must be a string for ${pageId}/${nodeId}.`);
  }
  if (typeof node.originalTranslation !== "string") {
    throw new Error(`post edit node originalTranslation must be a string for ${pageId}/${nodeId}.`);
  }
  if (typeof node.editedTranslation !== "string") {
    throw new Error(`post edit node editedTranslation must be a string for ${pageId}/${nodeId}.`);
  }
  validateAnchor(node.anchor, pageId, nodeId);
}

class PostEditWorkspaceModule {
  constructor({ root = paths.postEditDocuments } = {}) {
    this.root = root;
  }

  createDocumentFromScene({ jobId, sourcePreflightId = null, mangaId = null, translatorId = null, chapterId = null, scene }) {
    const document = buildPostEditDocumentFromScene({
      jobId,
      sourcePreflightId,
      mangaId,
      translatorId,
      chapterId,
      scene,
    });
    const target = getPostEditPaths(jobId, this.root).documentPath;
    writeJson(target, document);
    return target;
  }

  createDocumentFromRegionSnapshot(input) {
    const document = buildPostEditDocumentFromRegionSnapshot(input);
    const target = getPostEditPaths(input.jobId, this.root).documentPath;
    writeJson(target, document);
    return target;
  }

  exists(jobId) {
    return fs.existsSync(getPostEditPaths(jobId, this.root).documentPath);
  }

  load(jobId) {
    const resolved = getPostEditPaths(jobId, this.root);
    if (!fs.existsSync(resolved.documentPath)) {
      return null;
    }
    return readJson(resolved.documentPath);
  }

  save(jobId, payload) {
    const current = this.load(jobId);
    if (!current) {
      throw new Error(`Post-edit document not found for job ${jobId}.`);
    }

    const next = {
      ...current,
      ...payload,
      jobId,
      sourcePreflightId: current.sourcePreflightId,
      mangaId: current.mangaId,
      translatorId: current.translatorId,
      chapterId: current.chapterId,
      createdAt: current.createdAt,
      sourcePageOrder: current.sourcePageOrder,
      updatedAt: new Date().toISOString(),
      pages: preserveCorrectionIdentities(current, payload.pages),
      stats: {
        pageCount: Array.isArray(payload.pageOrder) ? payload.pageOrder.length : current.stats?.pageCount || 0,
        textNodeCount:
          Object.values(payload.pages || {}).reduce((count, page) => count + Object.keys(page?.nodes || {}).length, 0) ||
          current.stats?.textNodeCount ||
          0,
      },
    };
    validatePostEditDocument(jobId, next);
    writeJson(getPostEditPaths(jobId, this.root).documentPath, next);
    return next;
  }

  getPaths(jobId) {
    return getPostEditPaths(jobId, this.root);
  }

  deleteByJobId(jobId) {
    const resolved = getPostEditPaths(jobId, this.root);
    fs.rmSync(resolved.postEditRoot, { recursive: true, force: true });
    return resolved;
  }

  listDocuments() {
    if (!fs.existsSync(this.root)) {
      return [];
    }

    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const resolved = getPostEditPaths(entry.name, this.root);
        if (!fs.existsSync(resolved.documentPath)) {
          return null;
        }
        return {
          jobId: entry.name,
          paths: resolved,
          document: readJson(resolved.documentPath),
        };
      })
      .filter(Boolean);
  }

  deleteByBinding({ mangaId = null, translatorId = null, chapterId = null } = {}) {
    if (!mangaId && !translatorId && !chapterId) {
      return [];
    }

    const deleted = [];
    for (const entry of this.listDocuments()) {
      const document = entry.document || {};
      if (mangaId && document.mangaId !== mangaId) {
        continue;
      }
      if (translatorId && document.translatorId !== translatorId) {
        continue;
      }
      if (chapterId && document.chapterId !== chapterId) {
        continue;
      }
      this.deleteByJobId(entry.jobId);
      deleted.push({
        jobId: entry.jobId,
        documentPath: entry.paths.documentPath,
      });
    }

    return deleted;
  }
}

module.exports = {
  PostEditWorkspaceModule,
  buildPostEditDocumentFromScene,
  buildPostEditDocumentFromRegionSnapshot,
  getPostEditPaths,
  validatePostEditDocument,
};
