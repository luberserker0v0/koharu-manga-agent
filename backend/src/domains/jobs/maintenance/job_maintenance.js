const { paths } = require("../../../config");
const { deleteJobDirectories, runCleanup } = require("../../maintenance/cleanup_service");

function cleanupExpiredTrash(manager) {
  const retentionDays = Number(manager.resolvedConfig.defaults?.trashRetentionDays ?? 30);
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return [];
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const purgedIds = manager.store.purgeDeletedBefore(cutoff);
  if (purgedIds.length === 0) return purgedIds;
  try {
    deleteJobDirectories({ jobIds: purgedIds, paths });
  } catch {
    // Filesystem cleanup is best-effort; DB purge already succeeded.
  }
  manager.publishSystem("job.trash_cleanup", { purgedIds, retentionDays });
  return purgedIds;
}

function buildCleanupOptions(manager, dryRun, overrides) {
  const defaults = manager.resolvedConfig.defaults || {};
  return {
    dryRun,
    logRetentionDays: overrides.logRetentionDays ?? defaults.logRetentionDays,
    logMaxFiles: overrides.logMaxFiles ?? defaults.logMaxFiles,
    translatedRetentionDays: overrides.translatedRetentionDays ?? defaults.translatedRetentionDays,
    workspaceRetentionDays: overrides.workspaceRetentionDays ?? defaults.workspaceRetentionDays,
    postEditRetentionDays: overrides.postEditRetentionDays ?? defaults.postEditRetentionDays,
    olderThanDays: overrides.olderThanDays,
  };
}

function runMaintenanceCleanup(manager, {
  targets = ["logs", "translated", "workspaces", "postedit"],
  dryRun = true,
  overrides = {},
} = {}) {
  const results = runCleanup({
    targets,
    options: buildCleanupOptions(manager, dryRun, overrides),
    context: { paths, config: manager.resolvedConfig, store: manager.store },
  });
  if (!dryRun) manager.publishSystem("maintenance.cleanup_completed", { targets, results });
  return results;
}

module.exports = { cleanupExpiredTrash, runMaintenanceCleanup };
