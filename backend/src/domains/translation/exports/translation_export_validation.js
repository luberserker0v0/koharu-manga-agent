const path = require("path");
const { imageMediaType, readZipEntries } = require("./translated_image_service");

function translatedImageCount(artifactPath) {
  if (imageMediaType(artifactPath)) return 1;
  if (path.extname(artifactPath).toLowerCase() !== ".zip") {
    throw new Error("Translation export is not a supported image or ZIP file.");
  }
  return readZipEntries(artifactPath).entries.filter(
    (entry) => !entry.isDirectory && imageMediaType(entry.name),
  ).length;
}

function assertTranslationExportComplete(artifact, expectedCount) {
  if (!Number.isInteger(expectedCount) || expectedCount < 1) return;
  const actualCount = translatedImageCount(artifact?.path || "");
  if (actualCount === expectedCount) return;
  const error = new Error(`Translated output count ${actualCount} does not match selected source count ${expectedCount}.`);
  error.code = "translated_image_mapping_mismatch";
  throw error;
}

module.exports = { assertTranslationExportComplete, translatedImageCount };
