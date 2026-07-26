const fs = require("fs");
const path = require("path");
const { resolveKnowledgeAssetPaths } = require("./knowledge_paths");

const SCHEMA_VERSION = 2;

function normalizeRevision(entry) {
  return {
    ...entry,
    qualityStatus: entry.qualityStatus || "pending_revalidation",
    qualityReportPath: entry.qualityReportPath || null,
    qualityObservationFingerprint: entry.qualityObservationFingerprint || null,
    verifiedAt: entry.verifiedAt || null,
    manualOverrideCount: Number.isInteger(entry.manualOverrideCount) ? entry.manualOverrideCount : 0,
  };
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporaryPath, filePath);
}

class TranslationPublicationService {
  constructor({ resolveBaseDir = null } = {}) {
    this.resolveBaseDir = resolveBaseDir || ((mangaId, translatorId) =>
      resolveKnowledgeAssetPaths({ mangaId, translatorId }).baseDir
    );
  }

  getRegistryPath(mangaId, translatorId) {
    return path.join(this.resolveBaseDir(mangaId, translatorId), "translation_publications.json");
  }

  load(mangaId, translatorId) {
    const registryPath = this.getRegistryPath(mangaId, translatorId);
    if (!fs.existsSync(registryPath)) {
      return {
        schemaVersion: SCHEMA_VERSION,
        mangaId,
        translatorId,
        updatedAt: null,
        chapters: {},
      };
    }
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    const registry = {
      schemaVersion: SCHEMA_VERSION,
      mangaId,
      translatorId,
      updatedAt: parsed.updatedAt || null,
      chapters: Object.fromEntries(Object.entries(
        parsed.chapters && typeof parsed.chapters === "object" ? parsed.chapters : {}
      ).map(([chapterId, chapter]) => [chapterId, {
        ...chapter,
        revisions: (chapter.revisions || []).map(normalizeRevision),
      }])),
    };
    const requiresMigration = parsed.schemaVersion !== SCHEMA_VERSION || Object.values(parsed.chapters || {}).some((chapter) =>
      (chapter.revisions || []).some((entry) => !entry.qualityStatus)
    );
    if (requiresMigration) writeJsonAtomic(registryPath, registry);
    return registry;
  }

  getChapter(mangaId, translatorId, chapterId) {
    return this.load(mangaId, translatorId).chapters[chapterId] || null;
  }

  publish({
    mangaId,
    translatorId,
    chapterId,
    chapterTitle = null,
    jobId,
    finalTranslationSnapshotPath,
    finalTranslationSnapshotFingerprint,
    translationMemoryFingerprint = null,
    learningEvidenceSnapshotPath = null,
    postEditDocumentPath = null,
    exportArtifact = null,
    qualityStatus,
    qualityReportPath = null,
    qualityObservationFingerprint = null,
    verifiedAt = null,
    manualOverrideCount = 0,
  }) {
    if (!mangaId || !translatorId || !chapterId || !jobId) {
      return null;
    }
    if (!["passed", "not_applicable"].includes(qualityStatus)) {
      throw new Error("Translation publication requires passed final Quality verification or an explicitly non-Quality mode.");
    }
    const registry = this.load(mangaId, translatorId);
    const current = registry.chapters[chapterId] || { activeRevisionId: null, revisions: [] };
    const existing = (current.revisions || []).find((entry) => entry.jobId === jobId);
    if (existing) {
      return { ...existing, registryPath: this.getRegistryPath(mangaId, translatorId) };
    }

    const now = new Date().toISOString();
    const revisionId = `translation_revision_${jobId}`;
    const revisions = (current.revisions || []).map((entry) =>
      entry.revisionId === current.activeRevisionId
        ? { ...entry, status: "superseded", supersededAt: now, supersededByRevisionId: revisionId }
        : entry
    );
    const revision = {
      revisionId,
      jobId,
      status: "active",
      chapterId,
      chapterTitle,
      publishedAt: now,
      supersededAt: null,
      supersededByRevisionId: null,
      finalTranslationSnapshotPath,
      finalTranslationSnapshotFingerprint,
      translationMemoryFingerprint,
      learningEvidenceSnapshotPath,
      postEditDocumentPath,
      exportArtifact,
      knowledgeStatus: learningEvidenceSnapshotPath ? "pending" : "not_applicable",
      knowledgeJobId: null,
      knowledgeUpdatedAt: null,
      qualityStatus,
      qualityReportPath,
      qualityObservationFingerprint,
      verifiedAt: verifiedAt || now,
      manualOverrideCount,
    };
    revisions.push(revision);
    registry.updatedAt = now;
    registry.chapters[chapterId] = {
      chapterId,
      chapterTitle,
      activeRevisionId: revisionId,
      updatedAt: now,
      revisions,
    };
    const registryPath = this.getRegistryPath(mangaId, translatorId);
    writeJsonAtomic(registryPath, registry);
    return {
      ...revision,
      previousActiveRevisionId: current.activeRevisionId || null,
      previousActiveJobId:
        (current.revisions || []).find((entry) => entry.revisionId === current.activeRevisionId)?.jobId || null,
      registryPath,
    };
  }

  isActive({ mangaId, translatorId, chapterId, revisionId }) {
    if (!mangaId || !translatorId || !chapterId || !revisionId) return false;
    return this.getChapter(mangaId, translatorId, chapterId)?.activeRevisionId === revisionId;
  }

  updateKnowledgeStatus({ mangaId, translatorId, chapterId, revisionId, status, knowledgeJobId = null }) {
    const registry = this.load(mangaId, translatorId);
    const chapter = registry.chapters[chapterId];
    if (!chapter) return null;
    const index = (chapter.revisions || []).findIndex((entry) => entry.revisionId === revisionId);
    if (index < 0) return null;
    const now = new Date().toISOString();
    chapter.revisions[index] = {
      ...chapter.revisions[index],
      knowledgeStatus: status,
      knowledgeJobId: knowledgeJobId || chapter.revisions[index].knowledgeJobId || null,
      knowledgeUpdatedAt: now,
    };
    chapter.updatedAt = now;
    registry.updatedAt = now;
    writeJsonAtomic(this.getRegistryPath(mangaId, translatorId), registry);
    return chapter.revisions[index];
  }
}

module.exports = {
  TranslationPublicationService,
  writeJsonAtomic,
};
