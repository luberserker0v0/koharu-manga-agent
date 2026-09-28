const crypto = require("crypto");
const path = require("path");
const { paths } = require("../../../config");

function safePathSegment(value, fallback) {
  const input = String(value || "").trim();
  if (!input) return fallback;
  const slug = input
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^\.+$/, "_")
    .slice(0, 80) || fallback;
  if (slug === input) return slug;
  const suffix = crypto.createHash("sha256").update(input).digest("hex").slice(0, 8);
  return `${slug}-${suffix}`;
}

function resolveExportOutputDir({
  outputDir = null,
  mangaId = null,
  translatorId = null,
  chapterId = null,
  jobId = null,
  variant = "translation",
} = {}) {
  if (typeof outputDir === "string" && outputDir.trim()) {
    return outputDir.trim();
  }
  if (!jobId || !String(jobId).trim()) {
    throw new Error("Backend-generated export output requires jobId.");
  }
  return path.join(
    paths.translated,
    safePathSegment(mangaId, "unbound-manga"),
    safePathSegment(translatorId, "unbound-translator"),
    safePathSegment(chapterId, "unbound-chapter"),
    `${safePathSegment(variant, "translation")}-${safePathSegment(jobId, "job")}`
  );
}

module.exports = { resolveExportOutputDir, safePathSegment };
