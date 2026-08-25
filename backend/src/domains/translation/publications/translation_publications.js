const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("../../../infrastructure/filesystem/json_file");
const { resolveKnowledgeAssetPaths } = require("../../knowledge/registry/knowledge_paths");

const SCHEMA_VERSION = 2;
const REVISION_STATUSES = new Set(["active", "superseded"]);
const QUALITY_STATUSES = new Set(["passed", "not_applicable", "unverified"]);
const PUBLISHABLE_QUALITY_STATUSES = new Set(["passed", "not_applicable"]);
const KNOWLEDGE_STATUSES = new Set([
  "pending",
  "queued",
  "committed",
  "failed",
  "skipped_superseded",
  "not_applicable",
]);
const SEMANTIC_OUTCOMES = new Set(["clean", "warnings", "partial"]);

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
}

function validateRegistry(registry, { mangaId, translatorId }) {
  if (!registry || registry.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Translation publication registry requires schemaVersion ${SCHEMA_VERSION}.`);
  }
  if (registry.mangaId !== mangaId || registry.translatorId !== translatorId) {
    throw new Error("Translation publication registry identity does not match its storage scope.");
  }
  if (!registry.chapters || typeof registry.chapters !== "object" || Array.isArray(registry.chapters)) {
    throw new Error("Translation publication registry chapters must be an object.");
  }
  for (const [chapterId, chapter] of Object.entries(registry.chapters)) {
    if (!chapter || chapter.chapterId !== chapterId || !Array.isArray(chapter.revisions)) {
      throw new Error(`Translation publication chapter ${chapterId} has an invalid contract.`);
    }
    const revisionIds = new Set();
    let activeCount = 0;
    for (const revision of chapter.revisions) {
      requireString(revision?.revisionId, `Publication ${chapterId} revisionId`);
      requireString(revision?.jobId, `Publication ${chapterId} jobId`);
      requireString(revision?.finalTranslationSnapshotPath, `Publication ${chapterId} snapshot path`);
      requireString(revision?.finalTranslationSnapshotFingerprint, `Publication ${chapterId} snapshot fingerprint`);
      if (revision.chapterId !== chapterId) throw new Error(`Publication ${revision.revisionId} chapterId does not match ${chapterId}.`);
      if (revisionIds.has(revision.revisionId)) throw new Error(`Duplicate publication revision ${revision.revisionId}.`);
      revisionIds.add(revision.revisionId);
      if (!REVISION_STATUSES.has(revision.status)) throw new Error(`Publication ${revision.revisionId} has unknown status ${revision.status}.`);
      if (!QUALITY_STATUSES.has(revision.qualityStatus)) throw new Error(`Publication ${revision.revisionId} has unknown qualityStatus ${revision.qualityStatus}.`);
      if (!KNOWLEDGE_STATUSES.has(revision.knowledgeStatus)) throw new Error(`Publication ${revision.revisionId} has unknown knowledgeStatus ${revision.knowledgeStatus}.`);
      if (revision.qualityOutcome != null && !SEMANTIC_OUTCOMES.has(revision.qualityOutcome)) {
        throw new Error(`Publication ${revision.revisionId} has unknown qualityOutcome ${revision.qualityOutcome}.`);
      }
      if (revision.knowledgeOutcome != null && !SEMANTIC_OUTCOMES.has(revision.knowledgeOutcome)) {
        throw new Error(`Publication ${revision.revisionId} has unknown knowledgeOutcome ${revision.knowledgeOutcome}.`);
      }
      if (!Number.isInteger(revision.manualOverrideCount) || revision.manualOverrideCount < 0) {
        throw new Error(`Publication ${revision.revisionId} has invalid manualOverrideCount.`);
      }
      if (revision.status === "active") activeCount += 1;
    }
    if (chapter.revisions.length === 0 || activeCount !== 1 || !revisionIds.has(chapter.activeRevisionId)) {
      throw new Error(`Translation publication chapter ${chapterId} must have exactly one referenced active revision.`);
    }
    const active = chapter.revisions.find((revision) => revision.revisionId === chapter.activeRevisionId);
    if (active.status !== "active") throw new Error(`Translation publication chapter ${chapterId} activeRevisionId is not active.`);
  }
  return registry;
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
    return validateRegistry(JSON.parse(fs.readFileSync(registryPath, "utf8")), { mangaId, translatorId });
  }

  getChapter(mangaId, translatorId, chapterId) {
    return this.load(mangaId, translatorId).chapters[chapterId] || null;
  }

  deleteChapter(mangaId, translatorId, chapterId) {
    const registry = this.load(mangaId, translatorId);
    const chapter = registry.chapters[chapterId] || null;
    if (!chapter) return { deleted: false, chapterId, revisionCount: 0 };
    delete registry.chapters[chapterId];
    registry.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.getRegistryPath(mangaId, translatorId), registry);
    return {
      deleted: true,
      chapterId,
      revisionCount: chapter.revisions.length,
      revisionIds: chapter.revisions.map((entry) => entry.revisionId),
    };
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
    qualityOutcome = null,
    qualityReportPath = null,
    qualityObservationFingerprint = null,
    verifiedAt = null,
    manualOverrideCount = 0,
    completenessStatus = "complete",
    qualityWarningCount = 0,
    learningExcludedNodeIds = [],
  }) {
    if (!mangaId || !translatorId || !chapterId || !jobId) {
      return null;
    }
    if (!PUBLISHABLE_QUALITY_STATUSES.has(qualityStatus)) {
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
      knowledgeOutcome: null,
      knowledgeJobId: null,
      knowledgeUpdatedAt: null,
      qualityStatus,
      qualityOutcome,
      qualityReportPath,
      qualityObservationFingerprint,
      verifiedAt: verifiedAt || now,
      manualOverrideCount,
      completenessStatus,
      qualityWarningCount,
      learningExcludedNodeIds,
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

  updateKnowledgeStatus({ mangaId, translatorId, chapterId, revisionId, status, knowledgeJobId = null, outcome = undefined }) {
    if (!KNOWLEDGE_STATUSES.has(status)) throw new Error(`Unknown publication knowledge status ${status}.`);
    if (outcome !== undefined && outcome !== null && !SEMANTIC_OUTCOMES.has(outcome)) {
      throw new Error(`Unknown publication knowledge outcome ${outcome}.`);
    }
    const registry = this.load(mangaId, translatorId);
    const chapter = registry.chapters[chapterId];
    if (!chapter) throw new Error(`Translation publication chapter ${chapterId} does not exist.`);
    const index = (chapter.revisions || []).findIndex((entry) => entry.revisionId === revisionId);
    if (index < 0) throw new Error(`Translation publication revision ${revisionId} does not exist.`);
    const now = new Date().toISOString();
    chapter.revisions[index] = {
      ...chapter.revisions[index],
      knowledgeStatus: status,
      knowledgeJobId: knowledgeJobId || chapter.revisions[index].knowledgeJobId || null,
      knowledgeOutcome: outcome === undefined ? chapter.revisions[index].knowledgeOutcome || null : outcome,
      knowledgeUpdatedAt: now,
    };
    chapter.updatedAt = now;
    registry.updatedAt = now;
    writeJsonAtomic(this.getRegistryPath(mangaId, translatorId), registry);
    return chapter.revisions[index];
  }
}

module.exports = {
  SCHEMA_VERSION,
  QUALITY_STATUSES,
  PUBLISHABLE_QUALITY_STATUSES,
  TranslationPublicationService,
  validateRegistry,
  writeJsonAtomic,
};
