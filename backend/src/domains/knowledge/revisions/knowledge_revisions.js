const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("../../../infrastructure/filesystem/json_file");

const { resolveKnowledgeAssetPaths, resolveKnowledgePaths } = require("../registry/knowledge_paths");

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
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

function loadRevisions(store, payload) {
  const allRevisions = store
    .listKnowledgeRevisions({
      mangaId: payload.mangaId,
      translatorId: payload.translatorId || null,
      includeStale: true,
    })
    .filter((revision) => revision.referenceKind === payload.referenceKind);
  const active = allRevisions.filter((revision) => revision.status === "active");
  return { allRevisions, active };
}

function computeStaleRevisionSets(allRevisions, active, sequenceNumber) {
  const newlyStaleRevisions =
    sequenceNumber == null
      ? []
      : active.filter((revision) => revision.sequenceNumber != null && revision.sequenceNumber >= sequenceNumber);
  const carriedStaleRevisions =
    sequenceNumber == null
      ? []
      : allRevisions.filter(
          (revision) =>
            revision.status === "stale" && revision.sequenceNumber != null && revision.sequenceNumber >= sequenceNumber,
        );
  const staleRevisions = [
    ...new Map([...carriedStaleRevisions, ...newlyStaleRevisions].map((revision) => [revision.id, revision])).values(),
  ];
  return { newlyStaleRevisions, staleRevisions };
}

function staleBaseline(newlyStaleRevisions, active, sequenceNumber) {
  const previous = active
    .filter((revision) => revision.sequenceNumber != null && revision.sequenceNumber < sequenceNumber)
    .sort((left, right) => right.sequenceNumber - left.sequenceNumber)[0];
  const earliestStale = newlyStaleRevisions
    .slice()
    .sort((left, right) => left.sequenceNumber - right.sequenceNumber)[0];
  return {
    restoredFromRevisionId: previous?.id || null,
    restoredSnapshotPath: previous?.afterSnapshotPath || earliestStale.beforeSnapshotPath,
  };
}

function restoreStaleBaseline(store, payload, newlyStaleRevisions, active, sequenceNumber) {
  let restoredFromRevisionId = null;
  let restoredSnapshotPath = null;
  let restoreSkippedReason = null;
  if (newlyStaleRevisions.length > 0) {
    ({ restoredFromRevisionId, restoredSnapshotPath } = staleBaseline(newlyStaleRevisions, active, sequenceNumber));
    if (restoredSnapshotPath && fs.existsSync(restoredSnapshotPath)) {
      restoreSnapshot(restoredSnapshotPath);
    } else if (
      !hasKnowledgeAssets({
        mangaId: payload.mangaId,
        translatorId: payload.translatorId || null,
      })
    ) {
      restoredFromRevisionId = null;
      restoredSnapshotPath = null;
      restoreSkippedReason = "missing_snapshot_and_no_live_knowledge_assets";
    } else {
      restoreSnapshot(restoredSnapshotPath);
    }
    store.markKnowledgeRevisionsStale(newlyStaleRevisions.map((revision) => revision.id));
  }
  return { restoredFromRevisionId, restoredSnapshotPath, restoreSkippedReason };
}

function revisionPreparationState(store, payload, revisionId) {
  const sequenceNumber = Number.isFinite(payload.chapterSortOrder) ? payload.chapterSortOrder : null;
  const { allRevisions, active } = loadRevisions(store, payload);
  const stale = computeStaleRevisionSets(allRevisions, active, sequenceNumber);
  const restored = restoreStaleBaseline(store, payload, stale.newlyStaleRevisions, active, sequenceNumber);
  const beforeSnapshotPath = captureSnapshot({
    mangaId: payload.mangaId, translatorId: payload.translatorId || null, revisionId, kind: "before",
  });
  const superseded = active
    .filter((revision) => revision.chapterId === payload.chapterId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  return { sequenceNumber, active, ...stale, ...restored, beforeSnapshotPath,
    supersedesRevisionId: superseded?.id || null };
}

function buildRevisionPlan(params) {
  return {
    schemaVersion: 1,
    revisionId: params.revisionId,
    mangaId: params.mangaId,
    translatorId: params.translatorId,
    chapterId: params.chapterId,
    sequenceNumber: params.sequenceNumber,
    workflowId: params.workflowId,
    referenceSetId: params.referenceSetId,
    referenceKind: params.referenceKind,
    beforeSnapshotPath: params.beforeSnapshotPath,
    restoredFromRevisionId: params.restoredFromRevisionId,
    restoredSnapshotPath: params.restoredSnapshotPath,
    restoreSkippedReason: params.restoreSkippedReason,
    supersedesRevisionId: params.supersedesRevisionId,
    staleRevisions: params.staleRevisions,
    payload: params.payload,
    preparedAt: new Date().toISOString(),
  };
}

function prepareKnowledgeRevision({ store, payload, planPath }) {
  const revisionId = crypto.randomUUID();
  const state = revisionPreparationState(store, payload, revisionId);
  const plan = buildRevisionPlan({
    revisionId,
    mangaId: payload.mangaId,
    translatorId: payload.translatorId || null,
    chapterId: payload.chapterId,
    sequenceNumber: state.sequenceNumber,
    workflowId: payload.workflowId,
    referenceSetId: payload.referenceSetId,
    referenceKind: payload.referenceKind,
    beforeSnapshotPath: state.beforeSnapshotPath,
    restoredFromRevisionId: state.restoredFromRevisionId,
    restoredSnapshotPath: state.restoredSnapshotPath,
    restoreSkippedReason: state.restoreSkippedReason,
    supersedesRevisionId: state.supersedesRevisionId,
    staleRevisions: state.staleRevisions,
    payload,
  });
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

function createRevisionFromPlan(store, plan, afterSnapshotPath, analysisArtifactPath) {
  return store.createKnowledgeRevision({
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
    const revision = createRevisionFromPlan(store, plan, afterSnapshotPath, analysisArtifactPath);
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
