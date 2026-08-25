const crypto = require("crypto");

function translationSceneFingerprint(translations) {
  return crypto.createHash("sha256").update(JSON.stringify((translations || []).map((entry) => [
    entry.id || entry.nodeId,
    entry.pageId || null,
    entry.original || "",
    entry.translation || "",
  ]))).digest("hex");
}

function buildPipelinePlan(engines = {}) {
  return ["detect", "fontDetect", "segment", "bubbleSegment", "ocr", "translate", "clean", "render"]
    .filter((key) => Boolean(engines[key]));
}

function resolveReferenceUsage(payload = {}) {
  const useForTerminology = payload.useForTerminology !== false;
  return {
    useForTerminology,
    useForStyle: payload.useForStyle !== false,
    glossaryMode: useForTerminology ? payload.glossaryMode || "canonical" : "disabled",
  };
}

module.exports = { buildPipelinePlan, resolveReferenceUsage, translationSceneFingerprint };
