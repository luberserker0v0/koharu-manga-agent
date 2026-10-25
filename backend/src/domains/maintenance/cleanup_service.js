const fs = require("fs");
const path = require("path");

const ACTIVE_JOB_STATUSES = new Set([
  "queued",
  "waiting_dependency",
  "waiting_prerequisite",
  "running",
  "cancel_requested",
  "blocked",
]);

function isInsideRoot(candidate, root) {
  try {
    const resolvedRoot = fs.realpathSync(root);
    const resolvedCandidate = path.resolve(candidate);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  } catch {
    const normalizedRoot = path.resolve(root);
    const normalizedCandidate = path.resolve(candidate);
    const relative = path.relative(normalizedRoot, normalizedCandidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }
}

function statSafe(targetPath) {
  try {
    return fs.statSync(targetPath);
  } catch {
    return null;
  }
}

function collectFilesRecursive(rootDir, maxDepth = 3) {
  const files = [];
  const stack = [{ dir: rootDir, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) stack.push({ dir: fullPath, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = statSafe(fullPath);
      if (!stat) continue;
      files.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function collectChildDirs(rootDir) {
  try {
    return fs
      .readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(rootDir, entry.name));
  } catch {
    return [];
  }
}

function dirMtimeMs(dirPath) {
  const state = { newest: 0, seenFile: false };
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readDirEntries(current);
    for (const entry of entries) {
      updateMtimeState(entry, current, stack, state);
    }
  }
  if (!state.seenFile) {
    const stat = statSafe(dirPath);
    return stat ? stat.mtimeMs : 0;
  }
  return state.newest;
}

function readDirEntries(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function updateMtimeState(entry, current, stack, state) {
  const fullPath = path.join(current, entry.name);
  if (entry.isDirectory()) {
    stack.push(fullPath);
    return;
  }
  const fileStat = statSafe(fullPath);
  if (!fileStat) return;
  state.seenFile = true;
  if (fileStat.mtimeMs > state.newest) state.newest = fileStat.mtimeMs;
}

function dirSizeBytes(dirPath) {
  let total = 0;
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      const stat = statSafe(fullPath);
      if (stat) total += stat.size;
    }
  }
  return total;
}

function removeSafe(targetPath, rootDir) {
  if (!isInsideRoot(targetPath, rootDir)) {
    return { removed: false, reason: "outside_root" };
  }
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return { removed: true };
  } catch (error) {
    return { removed: false, reason: error.message };
  }
}

function getActiveJobIds(store) {
  if (!store || typeof store.listJobs !== "function") return new Set();
  try {
    const jobs = store.listJobs({ includeDeleted: true }) || [];
    return new Set(jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)).map((job) => job.id));
  } catch {
    return new Set();
  }
}

function getKnownJobIds(store) {
  if (!store || typeof store.listJobs !== "function") return null;
  try {
    const jobs = store.listJobs({ includeDeleted: true }) || [];
    return new Set(jobs.map((job) => job.id));
  } catch {
    return null;
  }
}

function cleanupLogs({ logsDir, olderThanDays = null, maxFiles = null, dryRun = true } = {}) {
  if (!logsDir || !fs.existsSync(logsDir)) {
    return {
      target: "logs",
      deleted: 0,
      remaining: 0,
      freedBytes: 0,
      dryRun,
      files: [],
    };
  }
  const files = collectFilesRecursive(logsDir, 3);
  const cutoff = computeCleanupCutoff(olderThanDays);
  const matched = collectMatchedLogPaths(files, cutoff, maxFiles);
  const candidates = files.filter((file) => matched.has(file.path));
  return deleteMatchedLogs(candidates, logsDir, dryRun, files.length);
}

function computeCleanupCutoff(days) {
  if (days == null || !Number.isFinite(Number(days)) || Number(days) <= 0) return null;
  return Date.now() - Number(days) * 24 * 60 * 60 * 1000;
}

function collectMatchedLogPaths(files, cutoff, maxFiles) {
  const matched = new Set();
  if (cutoff != null) {
    for (const file of files) {
      if (file.mtimeMs < cutoff) matched.add(file.path);
    }
  }
  if (maxFiles != null && Number.isFinite(Number(maxFiles)) && Number(maxFiles) >= 0) {
    for (const file of files.slice(Number(maxFiles))) matched.add(file.path);
  }
  return matched;
}

function deleteMatchedLogs(candidates, logsDir, dryRun, totalFiles) {
  let freedBytes = 0;
  const deletedFiles = [];
  for (const file of candidates) {
    if (!dryRun) {
      const result = removeSafe(file.path, logsDir);
      if (!result.removed) continue;
    }
    freedBytes += file.size;
    deletedFiles.push(file.path);
  }
  return {
    target: "logs",
    deleted: deletedFiles.length,
    remaining: Math.max(totalFiles - deletedFiles.length, 0),
    freedBytes,
    dryRun,
    files: deletedFiles,
  };
}

function iterTranslatedLeafDirs(translatedRoot) {
  const leaves = [];
  const visit = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs = entries.filter((entry) => entry.isDirectory());
    const hasFiles = entries.some((entry) => entry.isFile());
    if (hasFiles || subdirs.length === 0 || depth >= 4) {
      leaves.push(dir);
      return;
    }
    for (const sub of subdirs) visit(path.join(dir, sub.name), depth + 1);
  };
  for (const child of collectChildDirs(translatedRoot)) visit(child, 1);
  return leaves;
}

function cleanupTranslated({
  translatedRoot,
  translatedImagesRoot = null,
  olderThanDays = 30,
  dryRun = true,
  store = null,
} = {}) {
  const state = { deleted: [], freedBytes: 0 };
  const cutoff =
    olderThanDays != null && Number.isFinite(Number(olderThanDays)) && Number(olderThanDays) > 0
      ? Date.now() - Number(olderThanDays) * 24 * 60 * 60 * 1000
      : null;
  const activeIds = getActiveJobIds(store);
  const knownIds = getKnownJobIds(store);
  const context = { cutoff, activeIds, knownIds, dryRun, state };

  processTranslatedRoots(translatedRoot, translatedImagesRoot, (dirPath, rootDir) => {
    considerTranslatedDir(dirPath, rootDir, context);
  });

  return {
    target: "translated",
    deleted: state.deleted.length,
    freedBytes: state.freedBytes,
    dryRun,
    dirs: state.deleted,
  };
}

function considerTranslatedDir(dirPath, rootDir, context) {
  const { cutoff, activeIds, knownIds, dryRun, state } = context;
  if (!isInsideRoot(dirPath, rootDir)) return;
  const newest = dirMtimeMs(dirPath);
  if (cutoff != null && newest >= cutoff) return;
  const base = path.basename(dirPath);
  for (const activeId of activeIds) {
    if (base.endsWith(`-${activeId}`) || base === activeId) return;
  }
  if (knownIds && cutoff == null) {
    const referenced = [...knownIds].some((id) => base.endsWith(`-${id}`) || base === id);
    if (referenced) return;
  }
  const size = dirSizeBytes(dirPath);
  if (!dryRun) {
    const result = removeSafe(dirPath, rootDir);
    if (!result.removed) return;
  }
  state.freedBytes += size;
  state.deleted.push(dirPath);
}

function processTranslatedRoots(translatedRoot, translatedImagesRoot, considerDir) {
  if (translatedRoot && fs.existsSync(translatedRoot)) {
    for (const leaf of iterTranslatedLeafDirs(translatedRoot)) {
      considerDir(leaf, translatedRoot);
    }
  }
  if (translatedImagesRoot && fs.existsSync(translatedImagesRoot)) {
    for (const child of collectChildDirs(translatedImagesRoot)) {
      considerDir(child, translatedImagesRoot);
    }
  }
}

function retentionCutoff(olderThanDays) {
  const days = Number(olderThanDays);
  return olderThanDays != null && Number.isFinite(days) && days > 0
    ? Date.now() - days * 24 * 60 * 60 * 1000
    : null;
}

function cleanupJobOwnedDirs(target, rootDir, olderThanDays, dryRun, store) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return { target, deleted: 0, freedBytes: 0, dryRun, dirs: [] };
  }
  const cutoff = retentionCutoff(olderThanDays);
  const activeIds = getActiveJobIds(store);
  const state = { freedBytes: 0, deleted: [] };
  for (const child of collectChildDirs(rootDir)) {
    if (activeIds.has(path.basename(child)) || !isInsideRoot(child, rootDir)) continue;
    if (cutoff != null && dirMtimeMs(child) >= cutoff) continue;
    const size = dirSizeBytes(child);
    if (!dryRun && !removeSafe(child, rootDir).removed) continue;
    state.freedBytes += size;
    state.deleted.push(child);
  }
  return { target, deleted: state.deleted.length, freedBytes: state.freedBytes, dryRun, dirs: state.deleted };
}

function cleanupWorkspaces({ workspaceRoot, olderThanDays = 30, dryRun = true, store = null } = {}) {
  return cleanupJobOwnedDirs("workspaces", workspaceRoot, olderThanDays, dryRun, store);
}

function cleanupPostEdit({ postEditRoot, olderThanDays = 30, dryRun = true, store = null } = {}) {
  return cleanupJobOwnedDirs("postedit", postEditRoot, olderThanDays, dryRun, store);
}

function deleteJobDirectories({ jobIds = [], paths = {} } = {}) {
  const removed = [];
  for (const jobId of jobIds) {
    if (typeof jobId !== "string" || !jobId) continue;
    if (paths.workspaceRoot && fs.existsSync(path.join(paths.workspaceRoot, jobId))) {
      const target = path.join(paths.workspaceRoot, jobId);
      const result = removeSafe(target, paths.workspaceRoot);
      if (result.removed) removed.push(target);
    }
    if (paths.postEditDocuments && fs.existsSync(path.join(paths.postEditDocuments, jobId))) {
      const target = path.join(paths.postEditDocuments, jobId);
      const result = removeSafe(target, paths.postEditDocuments);
      if (result.removed) removed.push(target);
    }
    if (paths.translated && fs.existsSync(paths.translated)) {
      for (const leaf of iterTranslatedLeafDirs(paths.translated)) {
        if (path.basename(leaf).endsWith(`-${jobId}`)) {
          const result = removeSafe(leaf, paths.translated);
          if (result.removed) removed.push(leaf);
        }
      }
    }
  }
  return removed;
}

const CLEANUP_TARGETS = ["logs", "translated", "workspaces", "postedit"];

function runCleanup({ targets = ["logs", "translated", "workspaces", "postedit"], options = {}, context = {} } = {}) {
  const wanted = new Set(Array.isArray(targets) ? targets : [targets]);
  if (wanted.has("all")) {
    for (const target of CLEANUP_TARGETS) wanted.add(target);
  }
  const results = {};
  if (wanted.has("logs")) results.logs = runLogsCleanup(options, context);
  if (wanted.has("translated")) results.translated = runTranslatedCleanup(options, context);
  if (wanted.has("workspaces")) results.workspaces = runWorkspaceCleanup(options, context);
  if (wanted.has("postedit")) results.postedit = runPostEditCleanup(options, context);
  return results;
}

function runLogsCleanup(options, context) {
  return cleanupLogs({
    logsDir: context.paths?.logs,
    olderThanDays:
      options.logRetentionDays ?? options.olderThanDays ?? context.config?.defaults?.logRetentionDays ?? 14,
    maxFiles: options.logMaxFiles ?? context.config?.defaults?.logMaxFiles ?? 200,
    dryRun: options.dryRun ?? true,
  });
}

function runTranslatedCleanup(options, context) {
  return cleanupTranslated({
    translatedRoot: context.paths?.translated,
    translatedImagesRoot: context.paths?.translatedImages,
    olderThanDays:
      options.translatedRetentionDays ??
      options.olderThanDays ??
      context.config?.defaults?.translatedRetentionDays ??
      30,
    dryRun: options.dryRun ?? true,
    store: context.store || null,
  });
}

function runWorkspaceCleanup(options, context) {
  return cleanupWorkspaces({
    workspaceRoot: context.paths?.workspaceRoot,
    olderThanDays:
      options.workspaceRetentionDays ?? options.olderThanDays ?? context.config?.defaults?.workspaceRetentionDays ?? 30,
    dryRun: options.dryRun ?? true,
    store: context.store || null,
  });
}

function runPostEditCleanup(options, context) {
  return cleanupPostEdit({
    postEditRoot: context.paths?.postEditDocuments,
    olderThanDays:
      options.postEditRetentionDays ?? options.olderThanDays ?? context.config?.defaults?.postEditRetentionDays ?? 30,
    dryRun: options.dryRun ?? true,
    store: context.store || null,
  });
}

function startCleanupScheduler({ jobManager, getConfig, onError = null } = {}) {
  const config = typeof getConfig === "function" ? getConfig() : getConfig;
  if (!config?.cleanup?.enabled) return null;
  const intervalMs = Number(config.cleanup.intervalMs);
  if (!Number.isFinite(intervalMs) || intervalMs < 60000) return null;
  const timer = setInterval(() => {
    try {
      const current = typeof getConfig === "function" ? getConfig() : getConfig;
      if (current?.cleanup?.enabled === false) return;
      jobManager?.runMaintenanceCleanup?.({ targets: ["all"], dryRun: false });
    } catch (error) {
      if (typeof onError === "function") onError(error);
    }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

module.exports = {
  ACTIVE_JOB_STATUSES,
  CLEANUP_TARGETS,
  isInsideRoot,
  cleanupLogs,
  cleanupTranslated,
  cleanupWorkspaces,
  cleanupPostEdit,
  deleteJobDirectories,
  runCleanup,
  startCleanupScheduler,
};
