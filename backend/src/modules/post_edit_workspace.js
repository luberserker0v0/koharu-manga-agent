const fs = require("fs");
const path = require("path");

const { paths } = require("../config");

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

function normalizeTextNode(pageName, nodeId, node = {}) {
  const textKind = node?.kind?.text || {};
  const transform = node?.transform || {};
  const x = Number.isFinite(transform.x) ? transform.x : 0;
  const y = Number.isFinite(transform.y) ? transform.y : 0;
  const width = Number.isFinite(transform.width) ? transform.width : 0;
  const height = Number.isFinite(transform.height) ? transform.height : 0;

  return {
    nodeId,
    originalText: textKind.text || "",
    originalTranslation: textKind.translation || "",
    editedTranslation: textKind.translation || "",
    anchor: {
      pageName,
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
  const pageEntries = Object.entries(scene?.scene?.pages || {});
  const pageOrder = pageEntries.map(([pageId]) => pageId);
  const pages = {};
  let totalNodes = 0;

  for (const [pageId, page] of pageEntries) {
    const pageName = page?.name || pageId;
    const nodeEntries = Object.entries(page?.nodes || {}).filter(([, node]) => Boolean(node?.kind?.text));
    const nodeOrder = nodeEntries.map(([nodeId]) => nodeId);
    totalNodes += nodeOrder.length;
    const nodes = {};

    for (const [nodeId, node] of nodeEntries) {
      nodes[nodeId] = normalizeTextNode(pageName, nodeId, node);
    }

    pages[pageId] = {
      pageId,
      pageName,
      nodeOrder,
      nodes,
    };
  }

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

function validateAnchor(anchor, pageId, nodeId) {
  if (!anchor || typeof anchor !== "object") {
    throw new Error(`post edit node anchor must be an object for ${pageId}/${nodeId}.`);
  }
  if (typeof anchor.pageName !== "string" || !anchor.pageName.trim()) {
    throw new Error(`post edit node anchor.pageName is required for ${pageId}/${nodeId}.`);
  }
}

function validatePostEditDocument(jobId, payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("post edit document payload must be an object.");
  }
  if (payload.jobId !== jobId) {
    throw new Error("post edit document jobId does not match the requested job.");
  }
  if (payload.sourcePreflightId != null && typeof payload.sourcePreflightId !== "string") {
    throw new Error("post edit document sourcePreflightId must be a string or null.");
  }
  if (!Array.isArray(payload.pageOrder)) {
    throw new Error("post edit document pageOrder must be an array.");
  }
  if (!Array.isArray(payload.sourcePageOrder)) {
    throw new Error("post edit document sourcePageOrder must be an array.");
  }
  if (!payload.pages || typeof payload.pages !== "object") {
    throw new Error("post edit document pages must be an object.");
  }

  const pageIds = Object.keys(payload.pages);
  const sortedExpected = [...pageIds].sort();
  const sortedActual = [...payload.pageOrder].sort();
  const sortedSource = [...payload.sourcePageOrder].sort();
  if (sortedExpected.join("|") !== sortedActual.join("|")) {
    throw new Error("post edit document pageOrder must contain every page exactly once.");
  }
  if (sortedExpected.join("|") !== sortedSource.join("|")) {
    throw new Error("post edit document sourcePageOrder must contain every page exactly once.");
  }

  for (const pageId of payload.pageOrder) {
    const page = payload.pages[pageId];
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
      const node = page.nodes[nodeId];
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
  }
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
  getPostEditPaths,
  validatePostEditDocument,
};
