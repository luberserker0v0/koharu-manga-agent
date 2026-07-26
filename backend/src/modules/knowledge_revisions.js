const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  resolveKnowledgeAssetPaths,
  resolveKnowledgePaths,
} = require("./knowledge_paths");

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2));
  fs.renameSync(temporaryPath, filePath);
  return filePath;
}

function revisionTargets({ mangaId, translatorId }) {
  const assets = resolveKnowledgeAssetPaths({ mangaId, translatorId });
  const report = resolveKnowledgePaths({ mangaId, translatorId });
  return {
    glossary: assets.glossaryPath,
    candidateTerms: assets.candidateTermsPath,
    storyContext: assets.storyContextPath,
    storyGraph: assets.storyGraphPath,
    socialGraph: assets.socialGraphPath,
    styleEvidence: assets.styleEvidencePath,
    styleProfile: assets.styleProfilePath,
    translationContext: assets.translationContextPath,
    bilingualEvidence: assets.bilingualEvidencePath,
    report: report.reportPath,
  };
}

function hasKnowledgeAssets(scope) {
  return Object.values(revisionTargets(scope)).some((targetPath) => fs.existsSync(targetPath));
}

function captureSnapshot({ mangaId, translatorId, revisionId, kind }) {
  const assets = resolveKnowledgeAssetPaths({ mangaId, translatorId });
  const snapshotRoot = path.join(assets.baseDir, "revisions", revisionId, kind);
  ensureDir(snapshotRoot);
  const entries = [];
  for (const [key, sourcePath] of Object.entries(revisionTargets({ mangaId, translatorId }))) {
    const snapshotPath = path.join(snapshotRoot, `${key}.json`);
    const exists = fs.existsSync(sourcePath);
    if (exists) {
      fs.copyFileSync(sourcePath, snapshotPath);
    }
    entries.push({ key, sourcePath, snapshotPath, exists });
  }
  return writeJsonAtomic(path.join(snapshotRoot, "manifest.json"), {
    schemaVersion: 1,
    mangaId,
    translatorId: translatorId || null,
    revisionId,
    kind,
    createdAt: new Date().toISOString(),
    entries,
  });
}

function restoreSnapshot(manifestPath) {
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    throw new Error(`Knowledge revision snapshot not found: ${manifestPath || "not configured"}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const entry of manifest.entries || []) {
    if (!entry?.sourcePath) continue;
    if (!entry.exists) {
      fs.rmSync(entry.sourcePath, { force: true });
      continue;
    }
    if (!entry.snapshotPath || !fs.existsSync(entry.snapshotPath)) {
      throw new Error(`Knowledge revision snapshot file is missing: ${entry.snapshotPath}`);
    }
    ensureDir(path.dirname(entry.sourcePath));
    const temporaryPath = `${entry.sourcePath}.${process.pid}.restore.tmp`;
    fs.copyFileSync(entry.snapshotPath, temporaryPath);
    fs.renameSync(temporaryPath, entry.sourcePath);
  }
  return manifest;
}

function prepareKnowledgeRevision({ store, payload, planPath }) {
  const revisionId = crypto.randomUUID();
  const sequenceNumber = Number.isFinite(payload.chapterSortOrder)
    ? payload.chapterSortOrder
    : null;
  const allRevisions = store
    .listKnowledgeRevisions({
      mangaId: payload.mangaId,
      translatorId: payload.translatorId || null,
      includeStale: true,
    })
    .filter((revision) => revision.referenceKind === payload.referenceKind);
  const active = allRevisions.filter((revision) => revision.status === "active");
  const newlyStaleRevisions = sequenceNumber == null
    ? []
    : active.filter((revision) =>
        revision.sequenceNumber != null && revision.sequenceNumber >= sequenceNumber
      );
  const carriedStaleRevisions = sequenceNumber == null
    ? []
    : allRevisions.filter((revision) =>
        revision.status === "stale" &&
        revision.sequenceNumber != null &&
        revision.sequenceNumber >= sequenceNumber
      );
  const staleRevisions = [...new Map(
    [...carriedStaleRevisions, ...newlyStaleRevisions].map((revision) => [revision.id, revision])
  ).values()];
  let restoredFromRevisionId = null;
  let restoredSnapshotPath = null;
  let restoreSkippedReason = null;
  if (newlyStaleRevisions.length > 0) {
    const previous = active
      .filter((revision) =>
        revision.sequenceNumber != null && revision.sequenceNumber < sequenceNumber
      )
      .sort((left, right) => right.sequenceNumber - left.sequenceNumber)[0];
    const earliestStale = newlyStaleRevisions
      .slice()
      .sort((left, right) => left.sequenceNumber - right.sequenceNumber)[0];
    restoredFromRevisionId = previous?.id || null;
    restoredSnapshotPath = previous?.afterSnapshotPath || earliestStale.beforeSnapshotPath;
    if (restoredSnapshotPath && fs.existsSync(restoredSnapshotPath)) {
      restoreSnapshot(restoredSnapshotPath);
    } else if (!hasKnowledgeAssets({
      mangaId: payload.mangaId,
      translatorId: payload.translatorId || null,
    })) {
      // The user cleared ingestion files before revision metadata cleanup existed.
      // With no live assets there is nothing to roll back, so a new empty baseline is safe.
      restoredFromRevisionId = null;
      restoredSnapshotPath = null;
      restoreSkippedReason = "missing_snapshot_and_no_live_knowledge_assets";
    } else {
      restoreSnapshot(restoredSnapshotPath);
    }
    store.markKnowledgeRevisionsStale(newlyStaleRevisions.map((revision) => revision.id));
  }
  const beforeSnapshotPath = captureSnapshot({
    mangaId: payload.mangaId,
    translatorId: payload.translatorId || null,
    revisionId,
    kind: "before",
  });
  const superseded = active
    .filter((revision) => revision.chapterId === payload.chapterId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const plan = {
    schemaVersion: 1,
    revisionId,
    mangaId: payload.mangaId,
    translatorId: payload.translatorId || null,
    chapterId: payload.chapterId,
    sequenceNumber,
    workflowId: payload.workflowId,
    referenceSetId: payload.referenceSetId,
    referenceKind: payload.referenceKind,
    beforeSnapshotPath,
    restoredFromRevisionId,
    restoredSnapshotPath,
    restoreSkippedReason,
    supersedesRevisionId: superseded?.id || null,
    staleRevisions,
    payload,
    preparedAt: new Date().toISOString(),
  };
  writeJsonAtomic(planPath, plan);
  return plan;
}

function rollbackKnowledgeRevision(planPath) {
  if (!planPath || !fs.existsSync(planPath)) {
    return null;
  }
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  return restoreSnapshot(plan.beforeSnapshotPath);
}

function finalizeKnowledgeRevision({ store, planPath, analysisArtifactPath }) {
  if (!planPath || !fs.existsSync(planPath)) {
    throw new Error(`Knowledge revision plan not found: ${planPath || "not configured"}`);
  }
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  try {
    const afterSnapshotPath = captureSnapshot({
      mangaId: plan.mangaId,
      translatorId: plan.translatorId,
      revisionId: plan.revisionId,
      kind: "after",
    });
    const revision = store.createKnowledgeRevision({
      id: plan.revisionId,
      mangaId: plan.mangaId,
      translatorId: plan.translatorId,
      chapterId: plan.chapterId,
      sequenceNumber: plan.sequenceNumber,
      workflowId: plan.workflowId,
      referenceSetId: plan.referenceSetId,
      referenceKind: plan.referenceKind,
      status: "active",
      beforeSnapshotPath: plan.beforeSnapshotPath,
      afterSnapshotPath,
      analysisArtifactPath,
      payload: plan.payload,
      supersedesRevisionId: plan.supersedesRevisionId,
    });
    return {
      revision,
      staleRevisions: plan.staleRevisions || [],
      restoredFromRevisionId: plan.restoredFromRevisionId || null,
      planPath,
    };
  } catch (error) {
    restoreSnapshot(plan.beforeSnapshotPath);
    throw error;
  }
}

module.exports = {
  captureSnapshot,
  finalizeKnowledgeRevision,
  prepareKnowledgeRevision,
  rollbackKnowledgeRevision,
  restoreSnapshot,
  revisionTargets,
};
