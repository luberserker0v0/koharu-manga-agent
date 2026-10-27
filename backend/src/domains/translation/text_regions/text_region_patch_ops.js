const { matchPostEditDocumentToScene } = require("../../post_edit/export/post_edit_export");

function patchError(message, code = "text_region_mapping_failed") {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}

function matchingNode(page, region) {
  const { x, y, width, height } = region.geometry;
  return {
    originalText: region.sourceText,
    anchor: { pageName: page.pageName, x, y, width, height,
      centerX: x + width / 2, centerY: y + height / 2 },
  };
}

function matchingPage(page, correctedIds) {
  const regions = page.regions.filter((region) => correctedIds.has(region.id));
  return {
    pageName: page.pageName,
    nodeOrder: regions.map((region) => region.internalNodeId),
    nodes: Object.fromEntries(regions.map((region) => [region.internalNodeId, matchingNode(page, region)])),
  };
}

function matchingDocument(snapshot, corrections) {
  const correctedByPage = new Map(corrections.pages.map((page) => [
    page.sourceImageId, new Set(page.regions.map((region) => region.regionId)),
  ]));
  const pages = snapshot.pages.filter((page) => correctedByPage.has(page.sourceImageId));
  return {
    pageOrder: pages.map((page) => page.internalPageId),
    pages: Object.fromEntries(pages.map((page) => [
      page.internalPageId, matchingPage(page, correctedByPage.get(page.sourceImageId)),
    ])),
  };
}

function matchLookup(snapshot, corrections, scene) {
  const document = matchingDocument(snapshot, corrections);
  const result = matchPostEditDocumentToScene(document, scene);
  if (result.unresolved.length) {
    throw patchError(`Corrected text regions could not be matched after OCR: ${result.unresolved
      .map((entry) => `${entry.pageName}/${entry.nodeId}`).join(", ")}.`);
  }
  return new Map(result.matches.map((match) => [match.documentNodeId, match]));
}

function correctionPatch(correction) {
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(correction, "sourceText")) {
    patch.data = { text: { text: correction.sourceText } };
  }
  if (correction.geometry) {
    const { x, y, width, height, rotation } = correction.geometry;
    patch.transform = { x, y, width, height, rotationDeg: rotation };
  }
  return patch;
}

function correctionOps(snapshot, corrections, matches) {
  const pages = new Map(snapshot.pages.map((page) => [page.sourceImageId, page]));
  return corrections.pages.flatMap((pageCorrection) => {
    const page = pages.get(pageCorrection.sourceImageId);
    if (!page) throw patchError(`Correction source page is unavailable: ${pageCorrection.sourceImageId}.`);
    const regions = new Map(page.regions.map((region) => [region.id, region]));
    return pageCorrection.regions.map((correction) => {
      const region = regions.get(correction.regionId);
      if (!region) throw patchError(`Correction source region is unavailable: ${correction.regionId}.`);
      const match = matches.get(region.internalNodeId);
      if (!match) throw patchError(`Corrected text region is not matched: ${correction.regionId}.`);
      return { updateNode: { page: match.rebuiltPageId, id: match.rebuiltNodeId,
        patch: correctionPatch(correction) } };
    });
  });
}

function buildTextRegionCorrectionOps(snapshot, corrections, rebuiltScene) {
  return correctionOps(snapshot, corrections, matchLookup(snapshot, corrections, rebuiltScene));
}

module.exports = { buildTextRegionCorrectionOps };
