const fs = require("fs");
const path = require("path");

function publicDiscoveredFile(file) {
  return {
    fileName: file.fileName,
    accepted: file.accepted,
    converted: file.converted,
    reason: file.reason,
  };
}

function publicRejectedFile(file) {
  return { fileName: file.fileName, reason: file.reason };
}

function publicPreflightImage(preflightId, image) {
  return {
    id: image.id,
    fileName: image.fileName,
    orderedName: image.orderedName,
    actualFormat: image.actualFormat,
    converted: image.converted,
    convertedFrom: image.convertedFrom,
    orderIndex: image.orderIndex,
    contentUrl: `/api/v1/source-preflight/${encodeURIComponent(preflightId)}/images/${encodeURIComponent(image.id)}/content`,
  };
}

function publicSourcePreflight(manifest) {
  return {
    preflightId: manifest.preflightId,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    ready: manifest.ready,
    orderChanged: manifest.orderChanged,
    originalFingerprint: manifest.originalFingerprint,
    currentFingerprint: manifest.currentFingerprint,
    summary: manifest.summary || { discoveredCount: 0, acceptedCount: 0, convertedCount: 0, rejectedCount: 0 },
    discoveredFiles: (manifest.discoveredFiles || []).map(publicDiscoveredFile),
    rejectedFiles: (manifest.rejectedFiles || []).map(publicRejectedFile),
    images: (manifest.images || []).map((image) => publicPreflightImage(manifest.preflightId, image)),
  };
}

function imageContentType(filePath) {
  const types = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
  return types[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function streamPreflightImage(res, image) {
  const stat = fs.statSync(image.path);
  res.writeHead(200, {
    "Content-Type": imageContentType(image.path),
    "Content-Length": stat.size,
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(image.fileName)}`,
    "Cache-Control": "private, max-age=31536000, immutable",
  });
  fs.createReadStream(image.path).pipe(res);
}

module.exports = { publicSourcePreflight, streamPreflightImage };
