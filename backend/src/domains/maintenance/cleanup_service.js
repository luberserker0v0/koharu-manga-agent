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
    return fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(rootDir, entry.name));
  } catch {
    return [];
  }
}

function dirMtimeMs(dirPath) {
  let newest = 0;
  let seenFile = false;
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
      const fileStat = statSafe(fullPath);
      if (fileStat) {
        seenFile = true;
        if (fileStat.mtimeMs > newest) newest = fileStat.mtimeMs;
      }
    }
  }
  if (!seenFile) {
    const stat = statSafe(dirPath);
    return stat ? stat.mtimeMs : 0;
  }
  return newest;
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
    return new Set(
      jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)).map((job) => job.id)
    );
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
    return { target: "logs", deleted: 0, remaining: 0, freedBytes: 0, dryRun, files: [] };
  }
  const files = collectFilesRecursive(logsDir, 3);
  const cutoff = olderThanDays != null && Number.isFinite(Number(olderThanDays)) && Number(olderThanDays) > 0
    ? Date.now() - Number(olderThanDays) * 24 * 60 * 60 * 1000
    : null;

  const matched = new Set();
  if (cutoff != null) {
    for (const file of files) {
      if (file.mtimeMs < cutoff) matched.add(file.path);
    }
  }
  if (maxFiles != null && Number.isFinite(Number(maxFiles)) && Number(maxFiles) >= 0) {
    for (const file of files.slice(Number(maxFiles))) matched.add(file.path);
  }
  const candidates = files.filter((file) => matched.has(file.path));

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
    remaining: Math.max(files.length - deletedFiles.length, 0),
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
  const deleted = [];
  let freedBytes = 0;

  const cutoff = olderThanDays != null && Number.isFinite(Number(olderThanDays)) && Number(olderThanDays) > 0
    ? Date.now() - Number(olderThanDays) * 24 * 60 * 60 * 1000
    : null;

  const activeIds = getActiveJobIds(store);
  const knownIds = getKnownJobIds(store);

  const considerDir = (dirPath, rootDir) => {
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
    freedBytes += size;
    deleted.push(dirPath);
  };

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

  return { target: "translated", deleted: deleted.length, freedBytes, dryRun, dirs: deleted };
}

function cleanupWorkspaces({ workspaceRoot, olderThanDays = 30, dryRun = true, store = null } = {}) {
  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
    return { target: "workspaces", deleted: 0, freedBytes: 0, dryRun, dirs: [] };
  }
  const cutoff = olderThanDays != null && Number.isFinite(Number(olderThanDays)) && Number(olderThanDays) > 0
    ? Date.now() - Number(olderThanDays) * 24 * 60 * 60 * 1000
    : null;
  const activeIds = getActiveJobIds(store);
  const deleted = [];
  let freedBytes = 0;

  for (const child of collectChildDirs(workspaceRoot)) {
    const base = path.basename(child);
    if (activeIds.has(base)) continue;
    if (!isInsideRoot(child, workspaceRoot)) continue;
    const newest = dirMtimeMs(child);
    if (cutoff != null && newest >= cutoff) continue;
    const size = dirSizeBytes(child);
    if (!dryRun) {
      const result = removeSafe(child, workspaceRoot);
      if (!result.removed) continue;
    }
    freedBytes += size;
    deleted.push(child);
  }
  return { target: "workspaces", deleted: deleted.length, freedBytes, dryRun, dirs: deleted };
}

function cleanupPostEdit({ postEditRoot, olderThanDays = 30, dryRun = true, store = null } = {}) {
  if (!postEditRoot || !fs.existsSync(postEditRoot)) {
    return { target: "postedit", deleted: 0, freedBytes: 0, dryRun, dirs: [] };
  }
  const cutoff = olderThanDays != null && Number.isFinite(Number(olderThanDays)) && Number(olderThanDays) > 0
    ? Date.now() - Number(olderThanDays) * 24 * 60 * 60 * 1000
    : null;
  const activeIds = getActiveJobIds(store);
  const deleted = [];
  let freedBytes = 0;

  for (const child of collectChildDirs(postEditRoot)) {
    const base = path.basename(child);
    if (activeIds.has(base)) continue;
    if (!isInsideRoot(child, postEditRoot)) continue;
    const newest = dirMtimeMs(child);
    if (cutoff != null && newest >= cutoff) continue;
    const size = dirSizeBytes(child);
    if (!dryRun) {
      const result = removeSafe(child, postEditRoot);
      if (!result.removed) continue;
    }
    freedBytes += size;
    deleted.push(child);
  }
  return { target: "postedit", deleted: deleted.length, freedBytes, dryRun, dirs: deleted };
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
  if (wanted.has("logs")) {
    results.logs = cleanupLogs({
      logsDir: context.paths?.logs,
      olderThanDays: options.logRetentionDays ?? options.olderThanDays ?? context.config?.defaults?.logRetentionDays ?? 14,
      maxFiles: options.logMaxFiles ?? context.config?.defaults?.logMaxFiles ?? 200,
      dryRun: options.dryRun ?? true,
    });
  }
  if (wanted.has("translated")) {
    results.translated = cleanupTranslated({
      translatedRoot: context.paths?.translated,
      translatedImagesRoot: context.paths?.translatedImages,
      olderThanDays: options.translatedRetentionDays ?? options.olderThanDays ?? context.config?.defaults?.translatedRetentionDays ?? 30,
      dryRun: options.dryRun ?? true,
      store: context.store || null,
    });
  }
  if (wanted.has("workspaces")) {
    results.workspaces = cleanupWorkspaces({
      workspaceRoot: context.paths?.workspaceRoot,
      olderThanDays: options.workspaceRetentionDays ?? options.olderThanDays ?? context.config?.defaults?.workspaceRetentionDays ?? 30,
      dryRun: options.dryRun ?? true,
      store: context.store || null,
    });
  }
  if (wanted.has("postedit")) {
    results.postedit = cleanupPostEdit({
      postEditRoot: context.paths?.postEditDocuments,
      olderThanDays: options.postEditRetentionDays ?? options.olderThanDays ?? context.config?.defaults?.postEditRetentionDays ?? 30,
      dryRun: options.dryRun ?? true,
      store: context.store || null,
    });
  }
  return results;
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
