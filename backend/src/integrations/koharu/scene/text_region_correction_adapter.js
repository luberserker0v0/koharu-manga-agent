const crypto = require("crypto");

function patchError(message, code = "text_region_mapping_failed") {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}

function snapshotPageLookup(snapshot) {
  return new Map(snapshot.pages.map((page) => [page.sourceImageId, page]));
}

function rawScenePages(scene) {
  return Object.entries(scene?.scene?.pages || {}).map(([id, page]) => ({ id, page }));
}

function rebuiltPageLookup(snapshot, corrections, scene) {
  const pagesByName = new Map();
  for (const entry of rawScenePages(scene)) {
    if (pagesByName.has(entry.page?.name)) {
      throw patchError(`Rebuilt scene page name is duplicated: ${entry.page?.name}.`);
    }
    pagesByName.set(entry.page?.name, entry);
  }
  const sourcePages = snapshotPageLookup(snapshot);
  return new Map(corrections.pages.map((correction) => {
    const source = sourcePages.get(correction.sourceImageId);
    const rebuilt = source && pagesByName.get(source.pageName);
    if (!rebuilt) throw patchError(`Correction page could not be mapped after OCR: ${correction.sourceImageId}.`);
    return [correction.sourceImageId, rebuilt];
  }));
}

function previousNode(nodeId, node) {
  return { id: nodeId, visible: node.visible !== false, transform: node.transform, kind: node.kind };
}

function rebuiltTextEntries(rebuilt) {
  return Object.entries(rebuilt.page?.nodes || {}).flatMap(([nodeId, node], index) =>
    node?.kind?.text ? [{ nodeId, node, index }] : [],
  );
}

function removeRebuiltTextOps(rebuiltPages) {
  return [...rebuiltPages.values()].flatMap((rebuilt) =>
    rebuiltTextEntries(rebuilt)
      .sort((left, right) => right.index - left.index)
      .map((entry) => ({ removeNode: {
        page: rebuilt.id,
        id: entry.nodeId,
        prev_node: previousNode(entry.nodeId, entry.node),
        prev_index: entry.index,
      } })),
  );
}

function operationLookup(pageCorrection) {
  return new Map(pageCorrection.operations
    .filter((operation) => operation.type !== "create")
    .map((operation) => [operation.regionId, operation]));
}

function finalExistingRegions(sourcePage, pageCorrection) {
  const operations = operationLookup(pageCorrection);
  return sourcePage.regions.flatMap((region) => {
    const operation = operations.get(region.id);
    if (operation?.type === "delete") return [];
    return [{
      sourceImageId: sourcePage.sourceImageId,
      regionId: region.id,
      sourceText: operation?.sourceText ?? region.sourceText,
      geometry: operation?.geometry ? { ...operation.geometry } : { ...region.geometry },
      sourceDirection: region.sourceDirection || null,
    }];
  });
}

function finalCreatedRegions(pageCorrection) {
  return pageCorrection.operations
    .filter((operation) => operation.type === "create")
    .map((operation) => ({
      sourceImageId: pageCorrection.sourceImageId,
      clientOperationId: operation.clientOperationId,
      sourceText: operation.sourceText,
      geometry: { ...operation.geometry },
      sourceDirection: null,
    }));
}

function textNode(nodeId, region) {
  const { x, y, width, height, rotation = 0 } = region.geometry;
  return {
    id: nodeId,
    visible: true,
    transform: { x, y, width, height, rotationDeg: rotation },
    kind: { text: {
      text: region.sourceText,
      ...(region.sourceDirection ? { sourceDirection: region.sourceDirection } : {}),
    } },
  };
}

function addReconciledTextEntries(snapshot, corrections, rebuiltPages, createNodeId) {
  const sourcePages = snapshotPageLookup(snapshot);
  return corrections.pages.flatMap((pageCorrection) => {
    const sourcePage = sourcePages.get(pageCorrection.sourceImageId);
    const rebuilt = rebuiltPages.get(pageCorrection.sourceImageId);
    if (!sourcePage || !rebuilt) {
      throw patchError(`Correction source page is unavailable: ${pageCorrection.sourceImageId}.`);
    }
    const nonTextCount = Object.values(rebuilt.page?.nodes || {})
      .filter((node) => !node?.kind?.text).length;
    const regions = [
      ...finalExistingRegions(sourcePage, pageCorrection),
      ...finalCreatedRegions(pageCorrection),
    ];
    return regions.map((region, index) => ({
      ...region,
      pageId: rebuilt.id,
      nodeId: createNodeId(),
      at: nonTextCount + index,
    }));
  });
}

function addReconciledTextOps(entries) {
  return entries.map((entry) => ({ addNode: {
    page: entry.pageId,
    at: entry.at,
    node: textNode(entry.nodeId, entry),
  } }));
}

function operationOutcome(corrections, reconciled) {
  const summary = { created: [], updated: [], deleted: [] };
  for (const page of corrections.pages) {
    for (const operation of page.operations) {
      if (operation.type === "create") continue;
      summary[operation.type === "delete" ? "deleted" : "updated"].push({
        sourceImageId: page.sourceImageId,
        regionId: operation.regionId,
      });
    }
  }
  summary.created = reconciled.filter((entry) => entry.clientOperationId).map((entry) => ({
    sourceImageId: entry.sourceImageId,
    clientOperationId: entry.clientOperationId,
    internalNodeId: entry.nodeId,
  }));
  return summary;
}

function buildTextRegionCorrectionOps(snapshot, corrections, rebuiltScene, options = {}) {
  const createNodeId = options.createNodeId || crypto.randomUUID;
  const rebuiltPages = rebuiltPageLookup(snapshot, corrections, rebuiltScene);
  const reconciled = addReconciledTextEntries(snapshot, corrections, rebuiltPages, createNodeId);
  return {
    // OCR is rerun to establish a project and page mapping, but its fresh text
    // regions are not authoritative. Rebuild each corrected page from the
    // immutable source snapshot plus the user's operations so unedited boxes
    // cannot drift and newly detected false positives cannot reappear.
    ops: [...removeRebuiltTextOps(rebuiltPages), ...addReconciledTextOps(reconciled)],
    outcome: operationOutcome(corrections, reconciled),
  };
}

function createdRegion(entry, snapshot) {
  const page = snapshot.pages.find((candidate) => candidate.sourceImageId === entry.sourceImageId);
  const region = page?.regions.find((candidate) => candidate.internalNodeId === entry.internalNodeId);
  if (!region) throw patchError(`Created text region is missing after rendering: ${entry.clientOperationId}.`,
    "created_text_region_unavailable");
  return { sourceImageId: entry.sourceImageId, clientOperationId: entry.clientOperationId, regionId: region.id };
}

function finalizeTextRegionOperationOutcome(outcome, snapshot) {
  if (!outcome) return null;
  return {
    created: outcome.created.map((entry) => createdRegion(entry, snapshot)),
    updated: outcome.updated,
    deleted: outcome.deleted,
  };
}

module.exports = {
  buildTextRegionCorrectionOps,
  finalizeTextRegionOperationOutcome,
};
