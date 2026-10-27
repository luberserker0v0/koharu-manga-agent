function finiteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function textValue(value) {
  return typeof value === "string" ? value : "";
}

function normalizeGeometry(transform = {}) {
  return {
    x: finiteNumber(transform.x),
    y: finiteNumber(transform.y),
    width: finiteNumber(transform.width),
    height: finiteNumber(transform.height),
    rotation: finiteNumber(transform.rotationDeg, finiteNumber(transform.rotation)),
  };
}

function normalizeTextRegion(page, nodeId, node, readingOrder) {
  const text = node?.kind?.text;
  if (!text) return null;
  return {
    internalNodeId: String(nodeId),
    readingOrder,
    sourceText: textValue(text.text),
    translatedText: textValue(text.translation),
    geometry: normalizeGeometry(node?.transform),
    ocrConfidence: optionalNumber(text.confidence),
    sourceDirection: text.sourceDirection || null,
    textRole: text.textRole || node?.textRole || null,
    styleChannel: text.styleChannel || node?.styleChannel || null,
    speakerRef: text.speakerRef || node?.speakerRef || null,
    pageName: String(page?.name || ""),
  };
}

function normalizeScenePage(pageId, page, pageOrder) {
  const regions = Object.entries(page?.nodes || {}).flatMap(([nodeId, node], index) => {
    const region = normalizeTextRegion(page, nodeId, node, index);
    return region ? [region] : [];
  });
  return {
    internalPageId: String(pageId),
    pageName: String(page?.name || pageId),
    pageOrder,
    width: optionalNumber(page?.width),
    height: optionalNumber(page?.height),
    regions,
  };
}

function collectSceneTextRegionPages(scene) {
  return Object.entries(scene?.scene?.pages || {}).map(([pageId, page], index) =>
    normalizeScenePage(pageId, page, index),
  );
}

module.exports = {
  collectSceneTextRegionPages,
  normalizeGeometry,
  normalizeScenePage,
  normalizeTextRegion,
};
