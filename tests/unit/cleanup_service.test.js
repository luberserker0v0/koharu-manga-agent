const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  cleanupLogs,
  cleanupTranslated,
  cleanupWorkspaces,
  cleanupPostEdit,
  startCleanupScheduler,
  deleteJobDirectories,
  isInsideRoot,
  runCleanup,
} = require("../../backend/src/domains/maintenance/cleanup_service");

function touch(filePath, mtimeMs, size = 8) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "x".repeat(size));
  const date = new Date(mtimeMs);
  fs.utimesSync(filePath, date, date);
}

function touchDir(dirPath, mtimeMs) {
  fs.mkdirSync(dirPath, { recursive: true });
  const date = new Date(mtimeMs);
  fs.utimesSync(dirPath, date, date);
}

describe("cleanup_service", () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-cleanup-"));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("cleanupLogs respects age and maxFiles with dryRun safety", () => {
    const logsDir = path.join(root, "logs");
    const now = Date.now();
    touch(path.join(logsDir, "new.json"), now, 10);
    touch(path.join(logsDir, "old.json"), now - 20 * 86400000, 10);
    touch(path.join(logsDir, "pipeline-runner", "old2.json"), now - 20 * 86400000, 5);

    const preview = cleanupLogs({ logsDir, olderThanDays: 14, dryRun: true });
    expect(preview.deleted).toBe(2);
    expect(fs.existsSync(path.join(logsDir, "old.json"))).toBe(true);

    const executed = cleanupLogs({ logsDir, olderThanDays: 14, dryRun: false });
    expect(executed.deleted).toBe(2);
    expect(fs.existsSync(path.join(logsDir, "old.json"))).toBe(false);
    expect(fs.existsSync(path.join(logsDir, "new.json"))).toBe(true);

    touch(path.join(logsDir, "a.json"), now, 2);
    touch(path.join(logsDir, "b.json"), now, 2);
    touch(path.join(logsDir, "c.json"), now, 2);
    const capped = cleanupLogs({ logsDir, maxFiles: 2, dryRun: false });
    expect(capped.deleted).toBeGreaterThanOrEqual(1);
    expect(capped.remaining).toBe(2);
  });

  test("cleanupTranslated skips active jobs and removes expired leaves", () => {
    const translatedRoot = path.join(root, "outputs", "translated");
    const now = Date.now();
    const oldLeaf = path.join(translatedRoot, "manga", "tr", "ch", "translation-job-old");
    const activeLeaf = path.join(translatedRoot, "manga", "tr", "ch", "translation-job-active");
    touch(path.join(oldLeaf, "export_1.zip"), now - 40 * 86400000, 20);
    touch(path.join(activeLeaf, "export_1.zip"), now - 40 * 86400000, 20);
    touchDir(oldLeaf, now - 40 * 86400000);
    touchDir(activeLeaf, now - 40 * 86400000);

    const store = {
      listJobs: () => [
        { id: "job-old", status: "succeeded" },
        { id: "job-active", status: "running" },
      ],
    };
    const result = cleanupTranslated({ translatedRoot, olderThanDays: 30, dryRun: false, store });
    expect(result.dirs.some((dir) => dir.includes("job-old"))).toBe(true);
    expect(result.dirs.some((dir) => dir.includes("job-active"))).toBe(false);
    expect(fs.existsSync(oldLeaf)).toBe(false);
    expect(fs.existsSync(activeLeaf)).toBe(true);
  });

  test("cleanupWorkspaces removes expired job dirs but keeps active ones", () => {
    const workspaceRoot = path.join(root, "workspaces", "jobs");
    const now = Date.now();
    const oldDir = path.join(workspaceRoot, "job-old", "translation");
    const activeDir = path.join(workspaceRoot, "job-active", "translation");
    touch(path.join(oldDir, "snapshot.json"), now - 40 * 86400000, 10);
    touch(path.join(activeDir, "snapshot.json"), now - 40 * 86400000, 10);
    touchDir(path.join(workspaceRoot, "job-old"), now - 40 * 86400000);
    touchDir(path.join(workspaceRoot, "job-active"), now - 40 * 86400000);

    const store = {
      listJobs: () => [
        { id: "job-old", status: "succeeded" },
        { id: "job-active", status: "running" },
      ],
    };
    const result = cleanupWorkspaces({ workspaceRoot, olderThanDays: 30, dryRun: false, store });
    expect(result.dirs).toEqual([path.join(workspaceRoot, "job-old")]);
    expect(fs.existsSync(path.join(workspaceRoot, "job-old"))).toBe(false);
    expect(fs.existsSync(path.join(workspaceRoot, "job-active"))).toBe(true);
  });

  test("deleteJobDirectories never escapes DATA_ROOT", () => {
    const workspaceRoot = path.join(root, "workspaces", "jobs");
    const target = path.join(workspaceRoot, "job-1");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "a.json"), "{}");

    expect(isInsideRoot(path.join(root, "other", "x"), workspaceRoot)).toBe(false);
    const removed = deleteJobDirectories({
      jobIds: ["job-1"],
      paths: { workspaceRoot, translated: path.join(root, "outputs", "translated") },
    });
    expect(removed).toEqual([target]);
    expect(fs.existsSync(target)).toBe(false);
  });

  test("runCleanup orchestrates all three targets in dryRun", () => {    const logsDir = path.join(root, "logs");
    const translatedRoot = path.join(root, "outputs", "translated");
    const workspaceRoot = path.join(root, "workspaces", "jobs");
    const now = Date.now();
    touch(path.join(logsDir, "old.json"), now - 20 * 86400000, 4);
    const leaf = path.join(translatedRoot, "m", "t", "c", "translation-j1");
    touch(path.join(leaf, "export.zip"), now - 40 * 86400000, 4);
    const ws = path.join(workspaceRoot, "j1");
    touch(path.join(ws, "x.json"), now - 40 * 86400000, 4);

    const results = runCleanup({
      targets: ["logs", "translated", "workspaces"],
      options: { dryRun: true },
      context: {
        paths: { logs: logsDir, translated: translatedRoot, workspaceRoot },
        config: { defaults: { logRetentionDays: 14, logMaxFiles: 200, translatedRetentionDays: 30, workspaceRetentionDays: 30 } },
        store: { listJobs: () => [] },
      },
    });
    expect(results.logs.deleted).toBe(1);
    expect(results.translated.deleted).toBe(1);
    expect(results.workspaces.deleted).toBe(1);
    expect(fs.existsSync(path.join(logsDir, "old.json"))).toBe(true);
  });

  test("cleanupPostEdit removes expired job dirs but keeps active ones", () => {
    const postEditRoot = path.join(root, "domains", "post-edit");
    const now = Date.now();
    touch(path.join(postEditRoot, "job-old", "post_edit_document.json"), now - 40 * 86400000, 10);
    touch(path.join(postEditRoot, "job-active", "post_edit_document.json"), now - 40 * 86400000, 10);

    const store = {
      listJobs: () => [
        { id: "job-old", status: "succeeded" },
        { id: "job-active", status: "running" },
      ],
    };
    const result = cleanupPostEdit({ postEditRoot, olderThanDays: 30, dryRun: false, store });
    expect(result.dirs).toEqual([path.join(postEditRoot, "job-old")]);
    expect(fs.existsSync(path.join(postEditRoot, "job-old"))).toBe(false);
    expect(fs.existsSync(path.join(postEditRoot, "job-active"))).toBe(true);
  });

  test("runCleanup all expands to four targets including postedit", () => {
    const logsDir = path.join(root, "logs2");
    const postEditRoot = path.join(root, "post-edit2");
    const now = Date.now();
    touch(path.join(logsDir, "old.json"), now - 20 * 86400000, 4);
    touch(path.join(postEditRoot, "j1", "post_edit_document.json"), now - 40 * 86400000, 4);

    const results = runCleanup({
      targets: ["all"],
      options: { dryRun: true },
      context: {
        paths: { logs: logsDir, postEditDocuments: postEditRoot },
        config: { defaults: { logRetentionDays: 14, logMaxFiles: 200, postEditRetentionDays: 30 } },
        store: { listJobs: () => [] },
      },
    });
    expect(results.logs.deleted).toBe(1);
    expect(results.postedit.deleted).toBe(1);
  });

  test("startCleanupScheduler respects enabled flag and interval floor", () => {
    jest.useFakeTimers();
    try {
      expect(startCleanupScheduler({ jobManager: {}, getConfig: { cleanup: { enabled: false } } })).toBeNull();
      expect(startCleanupScheduler({ jobManager: {}, getConfig: { cleanup: { enabled: true, intervalMs: 1000 } } })).toBeNull();
      const jobManager = { runMaintenanceCleanup: jest.fn() };
      const timer = startCleanupScheduler({
        jobManager,
        getConfig: () => ({ cleanup: { enabled: true, intervalMs: 3600000 } }),
      });
      expect(timer).not.toBeNull();
      jest.advanceTimersByTime(3600000);
      expect(jobManager.runMaintenanceCleanup).toHaveBeenCalledWith({ targets: ["all"], dryRun: false });
      clearInterval(timer);
    } finally {
      jest.useRealTimers();
    }
  });
});
