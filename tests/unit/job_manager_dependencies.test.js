const fs = require("fs");
const os = require("os");
const path = require("path");

jest.mock("../../backend/src/modules/reference_extraction_review", () => ({
  ensureLegacyReviewMetadata: () => ({ status: "reviewed", currentFingerprint: "test-fingerprint" }),
}));

const { JobManager } = require("../../backend/src/job_manager");
const { JobStore } = require("../../backend/src/storage/job_store");

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForStatus(manager, jobId, statuses) {
  const accepted = new Set(Array.isArray(statuses) ? statuses : [statuses]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = manager.getJob(jobId);
    if (accepted.has(job?.status)) return job;
    await nextTurn();
  }
  throw new Error(`Job ${jobId} did not reach ${[...accepted].join("/")}.`);
}

function createManager(engine) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "job-deps-"));
  const store = new JobStore(path.join(root, "jobs.sqlite"));
  const manager = new JobManager({
    store,
    engine,
    runtimeConfig: {},
    resolvedConfig: { defaults: {} },
  });
  return { manager, store };
}

describe("JobManager dependencies", () => {
  test("runs bilingual evidence windows atomically and resumes from checkpoints", async () => {
    let failSecondWindow = true;
    let completedWindowIds = [];
    const calls = [];
    const windows = ["term_001", "term_002", "style_001"].map((windowId, index) => ({
      windowId,
      purpose: windowId.startsWith("term") ? "terminology" : "style",
      chapterId: `chapter_${index + 1}`,
      chapterTitle: String(index + 1),
    }));
    const referenceBilingualEnrichmentModule = {
      prepareRun: jest.fn(() => ({
        plan: {
          planHash: "plan-hash",
          sourceFingerprint: "source-fingerprint",
          targetFingerprint: "target-fingerprint",
          windows,
        },
        paths: { planPath: "plan.json" },
        completedWindowIds,
      })),
      markRunFailed: jest.fn(),
      markRunStopped: jest.fn(),
    };
    const engine = {
      referenceBilingualEnrichmentModule,
      runReferenceBilingualEvidenceWindowJob: jest.fn(async (payload) => {
        calls.push(payload.windowId);
        if (payload.windowId === "term_002" && failSecondWindow) {
          throw new Error("HTTP 503 after retry");
        }
        return { windowId: payload.windowId, attemptCount: 1, checkpointPath: `${payload.windowId}.json` };
      }),
      runReferenceBilingualCommitJob: jest.fn(async () => ({ status: "complete" })),
    };
    const { manager, store } = createManager(engine);
    const failed = manager.createReferenceBilingualEnrichmentJob({
      mangaId: "series",
      translatorId: "translator_a",
    });

    await waitForStatus(manager, failed.id, "failed");
    expect(calls).toEqual(["term_001", "term_002"]);
    expect(store.listChildJobs(failed.id).map((job) => [job.type, job.status])).toEqual([
      ["reference_bilingual_evidence_window", "succeeded"],
      ["reference_bilingual_evidence_window", "failed"],
      ["reference_bilingual_evidence_window", "blocked"],
      ["reference_bilingual_commit", "blocked"],
    ]);

    failSecondWindow = false;
    completedWindowIds = ["term_001"];
    const resumed = manager.retryJob(failed.id);
    await waitForStatus(manager, resumed.id, "succeeded");

    expect(store.listChildJobs(resumed.id).map((job) => job.payload.windowId || job.type)).toEqual([
      "term_002",
      "style_001",
      "reference_bilingual_commit",
    ]);
    expect(calls).toEqual(["term_001", "term_002", "term_002", "style_001"]);
    expect(engine.runReferenceBilingualCommitJob).toHaveBeenCalledTimes(1);
  });

  test("does not start a later source analysis after the previous workflow fails", async () => {
    const engine = {
      runReferenceIngestionAnalysisJob: jest.fn(async (payload) => {
        if (payload.chapterId === "chapter_1") throw new Error("invalid TextRole output");
        return { phase: "analysis" };
      }),
      runReferenceIngestionPrepareJob: jest.fn(async () => ({ phase: "prepare" })),
      runReferenceIngestionStoryJob: jest.fn(async () => ({ phase: "story" })),
      runReferenceIngestionCommitJob: jest.fn(async () => ({ phase: "commit" })),
    };
    const { manager, store } = createManager(engine);
    const workflows = manager.createReferenceIngestionJobs([
      {
        referenceSetId: "missing-source-1",
        referenceKind: "source",
        mangaId: "series",
        translatorId: "source",
        chapterId: "chapter_1",
      },
      {
        referenceSetId: "missing-source-2",
        referenceKind: "source",
        mangaId: "series",
        translatorId: "source",
        chapterId: "chapter_2",
      },
    ]);

    await waitForStatus(manager, workflows[0].id, "failed");
    await waitForStatus(manager, workflows[1].id, "failed");
    const secondAnalysis = store
      .listChildJobs(workflows[1].id)
      .find((job) => job.type === "reference_observation");
    expect(secondAnalysis.status).toBe("blocked");
    expect(engine.runReferenceIngestionAnalysisJob).toHaveBeenCalledTimes(1);
  });

  test("does not start later translator analyses after the previous workflow fails", async () => {
    const engine = {
      runReferenceIngestionAnalysisJob: jest.fn(async (payload) => {
        if (payload.chapterId === "chapter_1") throw new Error("translator analysis failed");
        return { phase: "analysis" };
      }),
      runReferenceIngestionPrepareJob: jest.fn(async () => ({ phase: "prepare" })),
      runReferenceIngestionStoryJob: jest.fn(),
      runReferenceIngestionCommitJob: jest.fn(async () => ({ phase: "commit" })),
    };
    const { manager, store } = createManager(engine);
    const workflows = manager.createReferenceIngestionJobs([
      {
        referenceSetId: "translator-reference-1",
        referenceKind: "translator",
        mangaId: "series",
        translatorId: "translator_a",
        chapterId: "chapter_1",
        chapterSortOrder: 0,
      },
      {
        referenceSetId: "translator-reference-2",
        referenceKind: "translator",
        mangaId: "series",
        translatorId: "translator_a",
        chapterId: "chapter_2",
        chapterSortOrder: 1,
      },
      {
        referenceSetId: "translator-reference-3",
        referenceKind: "translator",
        mangaId: "series",
        translatorId: "translator_a",
        chapterId: "chapter_3",
        chapterSortOrder: 2,
      },
    ]);

    await waitForStatus(manager, workflows[0].id, "failed");
    await waitForStatus(manager, workflows[1].id, "failed");
    await waitForStatus(manager, workflows[2].id, "failed");
    const laterAnalyses = workflows.slice(1).map((workflow) =>
      store.listChildJobs(workflow.id)
        .find((job) => job.type === "reference_observation")
    );
    expect(laterAnalyses.map((job) => job.status)).toEqual(["blocked", "blocked"]);
    expect(engine.runReferenceIngestionAnalysisJob).toHaveBeenCalledTimes(1);
    expect(engine.runReferenceIngestionStoryJob).not.toHaveBeenCalled();
  });

  test("splits source ingestion into observation, story, and knowledge commit jobs", async () => {
    const calls = [];
    const engine = {
      runReferenceIngestionAnalysisJob: jest.fn(async () => {
        calls.push("analysis");
        return { phase: "analysis" };
      }),
      runReferenceIngestionStoryJob: jest.fn(async () => {
        calls.push("story");
        return { phase: "story" };
      }),
      runReferenceKnowledgeCommitJob: jest.fn(async () => {
        calls.push("commit");
        return { phase: "commit" };
      }),
    };
    const { manager, store } = createManager(engine);
    const workflow = manager.createReferenceIngestionJob({
      referenceSetId: "missing-test-reference",
      referenceKind: "source",
      mangaId: "series",
      translatorId: "source",
      chapterId: "chapter-1",
    });

    await waitForStatus(manager, workflow.id, "succeeded");
    expect(calls).toEqual(["analysis", "story", "commit"]);
    expect(store.listChildJobs(workflow.id).map((job) => job.type)).toEqual([
      "reference_observation",
      "reference_story_update",
      "reference_knowledge_commit",
    ]);
  });

  test("translator ingestion skips the story child job", async () => {
    const engine = {
      runReferenceIngestionAnalysisJob: jest.fn(async () => ({ phase: "analysis" })),
      runReferenceIngestionStoryJob: jest.fn(),
      runReferenceKnowledgeCommitJob: jest.fn(async () => ({ phase: "commit" })),
    };
    const { manager, store } = createManager(engine);
    const workflow = manager.createReferenceIngestionJob({
      referenceSetId: "missing-test-reference",
      referenceKind: "translator",
      mangaId: "series",
      translatorId: "translator_a",
      chapterId: "chapter-1",
    });

    await waitForStatus(manager, workflow.id, "succeeded");
    expect(engine.runReferenceIngestionStoryJob).not.toHaveBeenCalled();
    expect(store.listChildJobs(workflow.id).map((job) => job.type)).toEqual([
      "reference_observation",
      "reference_style_commit",
    ]);
  });

  test("projects structured ingestion progress from a child onto its workflow", async () => {
    const engine = {
      runReferenceIngestionAnalysisJob: jest.fn(async (_payload, hooks) => {
        hooks.emit("reference_ingestion.progress", {
          stage: "reference_ingestion.text_role",
          percent: 35,
          batch: 2,
          batches: 4,
          processedNodes: 60,
          totalNodes: 180,
        });
        return { phase: "analysis" };
      }),
      runReferenceKnowledgeCommitJob: jest.fn(async () => ({ phase: "commit" })),
    };
    const { manager, store } = createManager(engine);
    const workflow = manager.createReferenceIngestionJob({
      referenceSetId: "translator-progress",
      referenceKind: "translator",
      mangaId: "series",
      translatorId: "translator_a",
      chapterId: "chapter-1",
    });

    await waitForStatus(manager, workflow.id, "succeeded");
    const projected = store.getEvents(workflow.id)
      .find((event) => event.type === "reference_ingestion.progress");
    expect(projected.payload).toEqual(expect.objectContaining({
      stage: "reference_ingestion.text_role",
      percent: 35,
      batch: 2,
      batches: 4,
      processedNodes: 60,
      totalNodes: 180,
      childJobType: "reference_observation",
    }));
  });

  test("workflow retry reuses a successful analysis artifact", async () => {
    let commitAttempts = 0;
    const engine = {
      runReferenceIngestionAnalysisJob: jest.fn(async (payload) => {
        fs.mkdirSync(path.dirname(payload.analysisArtifactPath), { recursive: true });
        fs.writeFileSync(payload.analysisArtifactPath, JSON.stringify({ phase: "analysis" }));
        return { phase: "analysis", analysisArtifactPath: payload.analysisArtifactPath };
      }),
      runReferenceIngestionStoryJob: jest.fn(async () => ({ phase: "story" })),
      runReferenceKnowledgeCommitJob: jest.fn(async () => {
        commitAttempts += 1;
        if (commitAttempts === 1) throw new Error("missing old snapshot");
        return { phase: "commit" };
      }),
    };
    const { manager, store } = createManager(engine);
    const failed = manager.createReferenceIngestionJob({
      referenceSetId: "reference-1",
      referenceKind: "source",
      mangaId: "series",
      translatorId: "source",
      chapterId: "chapter-1",
    });
    await waitForStatus(manager, failed.id, "failed");

    const retried = manager.retryJob(failed.id);
    await waitForStatus(manager, retried.id, "succeeded");

    expect(engine.runReferenceIngestionAnalysisJob).toHaveBeenCalledTimes(1);
    const retriedChildren = store.listChildJobs(retried.id);
    expect(retriedChildren.map((job) => job.type)).toEqual([
      "reference_observation",
      "reference_story_update",
      "reference_knowledge_commit",
    ]);
    expect(retriedChildren[0]).toEqual(expect.objectContaining({
      status: "succeeded",
      stage: "reused",
    }));
    expect(retriedChildren[0].result).toEqual(expect.objectContaining({
      reused: true,
      reusedFromJobId: expect.any(String),
    }));
    expect(retried.payload.reuseAnalysisArtifactPath).toBeTruthy();
  });

  test("retrying a later source chapter rebuilds the failed prerequisite chain", async () => {
    let failFirstRun = true;
    const calls = [];
    const engine = {
      runReferenceIngestionAnalysisJob: jest.fn(async (payload) => {
        calls.push(`analysis:${payload.chapterId}`);
        if (payload.chapterId === "chapter-1" && failFirstRun) {
          failFirstRun = false;
          throw new Error("first chapter failed");
        }
        return { phase: "analysis" };
      }),
      runReferenceIngestionPrepareJob: jest.fn(async () => ({ phase: "prepare" })),
      runReferenceIngestionStoryJob: jest.fn(async () => ({ phase: "story" })),
      runReferenceIngestionCommitJob: jest.fn(async () => ({ phase: "commit" })),
    };
    const { manager, store } = createManager(engine);
    const workflows = manager.createReferenceIngestionJobs([
      {
        referenceSetId: "reference-1",
        referenceKind: "source",
        mangaId: "series",
        translatorId: "source",
        chapterId: "chapter-1",
        chapterSortOrder: 0,
      },
      {
        referenceSetId: "reference-2",
        referenceKind: "source",
        mangaId: "series",
        translatorId: "source",
        chapterId: "chapter-2",
        chapterSortOrder: 1,
      },
    ]);
    await waitForStatus(manager, workflows[0].id, "failed");
    await waitForStatus(manager, workflows[1].id, "failed");

    const retriedSecond = manager.retryJob(workflows[1].id);
    await waitForStatus(manager, retriedSecond.id, "succeeded");

    const retriedParents = store.listJobs()
      .filter((job) => job.executionKind === "workflow" && job.payload?.retryOf)
      .sort((left, right) => left.sequenceNumber - right.sequenceNumber);
    expect(retriedParents).toHaveLength(2);
    expect(retriedParents.map((job) => job.payload.chapterId)).toEqual([
      "chapter-1",
      "chapter-2",
    ]);
    expect(calls).toEqual([
      "analysis:chapter-1",
      "analysis:chapter-1",
      "analysis:chapter-2",
    ]);
  });

  test("retrying a later chapter does not rerun a prerequisite whose latest workflow succeeded", async () => {
    let failChapterOne = true;
    const engine = {
      runReferenceIngestionAnalysisJob: jest.fn(async (payload) => {
        if (payload.chapterId === "chapter-1" && failChapterOne) {
          throw new Error("first attempt failed");
        }
        if (payload.chapterId === "chapter-2") {
          throw new Error("second chapter failed");
        }
        return { phase: "analysis" };
      }),
      runReferenceIngestionPrepareJob: jest.fn(async () => ({ phase: "prepare" })),
      runReferenceIngestionStoryJob: jest.fn(async () => ({ phase: "story" })),
      runReferenceIngestionCommitJob: jest.fn(async () => ({ phase: "commit" })),
    };
    const { manager, store } = createManager(engine);
    const workflows = manager.createReferenceIngestionJobs([
      {
        referenceSetId: "reference-1",
        referenceKind: "source",
        mangaId: "series",
        translatorId: "source",
        chapterId: "chapter-1",
        chapterSortOrder: 0,
      },
      {
        referenceSetId: "reference-2",
        referenceKind: "source",
        mangaId: "series",
        translatorId: "source",
        chapterId: "chapter-2",
        chapterSortOrder: 1,
      },
    ]);
    await waitForStatus(manager, workflows[0].id, "failed");
    await waitForStatus(manager, workflows[1].id, "failed");

    failChapterOne = false;
    const recoveredFirst = manager.retryJob(workflows[0].id);
    await waitForStatus(manager, recoveredFirst.id, "succeeded");
    const workflowsBeforeRetry = store.listJobs()
      .filter((job) => job.executionKind === "workflow").length;

    manager.retryJob(workflows[1].id);
    await nextTurn();

    const newWorkflows = store.listJobs()
      .filter((job) => job.executionKind === "workflow")
      .slice(0, store.listJobs().filter((job) => job.executionKind === "workflow").length - workflowsBeforeRetry);
    expect(newWorkflows).toHaveLength(1);
    expect(newWorkflows[0].payload.chapterId).toBe("chapter-2");
  });

  test("does not schedule a stale replay when that chapter already has an active workflow", async () => {
    const engine = {
      runReferenceIngestionAnalysisJob: jest.fn(async () => ({ phase: "analysis" })),
      runReferenceIngestionPrepareJob: jest.fn(async () => ({ phase: "prepare" })),
      runReferenceIngestionStoryJob: jest.fn(async () => ({ phase: "story" })),
      runReferenceIngestionCommitJob: jest.fn(async (payload) => ({
        phase: "commit",
        staleKnowledgeRevisions: payload.chapterId === "chapter-1"
          ? [{
              id: "stale-chapter-2",
              chapterId: "chapter-2",
              sequenceNumber: 1,
              createdAt: new Date().toISOString(),
              analysisArtifactPath: null,
              payload: {
                referenceSetId: "reference-2",
                referenceKind: "source",
                mangaId: "series",
                translatorId: "source",
                chapterId: "chapter-2",
                chapterSortOrder: 1,
              },
            }]
          : [],
      })),
    };
    const { manager, store } = createManager(engine);
    const workflows = manager.createReferenceIngestionJobs([
      {
        referenceSetId: "reference-1",
        referenceKind: "source",
        mangaId: "series",
        translatorId: "source",
        chapterId: "chapter-1",
        chapterSortOrder: 0,
      },
      {
        referenceSetId: "reference-2",
        referenceKind: "source",
        mangaId: "series",
        translatorId: "source",
        chapterId: "chapter-2",
        chapterSortOrder: 1,
      },
    ]);

    await waitForStatus(manager, workflows[1].id, "succeeded");
    await nextTurn();
    const replayWorkflows = store.listJobs().filter((job) =>
      job.executionKind === "workflow" && job.payload?.isReplay === true
    );
    expect(replayWorkflows).toHaveLength(0);
  });

  test("does not run a dependent job before its prerequisite succeeds", async () => {
    const calls = [];
    const engine = {
      runReferenceIngestionJob: jest.fn(async (payload) => {
        calls.push(payload.chapterId);
        return { chapterId: payload.chapterId };
      }),
    };
    const { manager } = createManager(engine);
    const first = manager.createJob("reference_ingestion", { chapterId: "chapter-1" });
    const second = manager.createJob(
      "reference_ingestion",
      { chapterId: "chapter-2" },
      { dependencyIds: [first.id] }
    );

    await waitForStatus(manager, second.id, "succeeded");
    expect(calls).toEqual(["chapter-1", "chapter-2"]);
  });

  test("blocks a dependent job when its prerequisite fails", async () => {
    const engine = {
      runReferenceIngestionJob: jest.fn(async (payload) => {
        if (payload.chapterId === "chapter-1") throw new Error("bad chapter");
        return { chapterId: payload.chapterId };
      }),
    };
    const { manager } = createManager(engine);
    const first = manager.createJob("reference_ingestion", { chapterId: "chapter-1" });
    const second = manager.createJob(
      "reference_ingestion",
      { chapterId: "chapter-2" },
      { dependencyIds: [first.id] }
    );

    await waitForStatus(manager, first.id, "failed");
    const blocked = await waitForStatus(manager, second.id, "blocked");
    expect(blocked.blockedReason).toContain(first.id);
    expect(engine.runReferenceIngestionJob).toHaveBeenCalledTimes(1);
  });

  test("rolls child outcomes up to the workflow parent", async () => {
    const engine = {
      runReferenceIngestionJob: jest.fn(async (payload) => ({ phase: payload.phase })),
    };
    const { manager, store } = createManager(engine);
    const workflow = manager.createWorkflow("reference_ingestion", { chapterId: "chapter-1" }, [
      { key: "analysis", type: "reference_ingestion", payload: { phase: "analysis" } },
      {
        key: "commit",
        type: "reference_ingestion",
        payload: { phase: "commit" },
        dependsOn: ["analysis"],
      },
    ]);

    const completed = await waitForStatus(manager, workflow.id, "succeeded");
    expect(store.listChildJobs(workflow.id).map((job) => job.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(completed.result).toEqual({ phase: "commit" });
  });

  test("trash, restore, and purge cascade through children of a regular translation job", async () => {
    const engine = {
      runTranslationJob: jest.fn(async () => ({ projectName: "translation-parent" })),
      runTranslationKnowledgeCommitJob: jest.fn(async () => ({ updated: true })),
    };
    const { manager, store } = createManager(engine);
    const parent = manager.createJob("translation", { translationMode: "quick" });
    await waitForStatus(manager, parent.id, "succeeded");
    const child = manager.createJob(
      "translation_knowledge_commit",
      { sourceTranslationJobId: parent.id },
      { parentJobId: parent.id }
    );
    await waitForStatus(manager, child.id, "succeeded");

    manager.deleteJob(parent.id);
    expect(store.getJob(parent.id).deletedAt).toBeTruthy();
    expect(store.getJob(child.id).deletedAt).toBeTruthy();

    manager.restoreJob(parent.id);
    expect(store.getJob(parent.id).deletedAt).toBeNull();
    expect(store.getJob(child.id).deletedAt).toBeNull();

    manager.deleteJob(parent.id);
    manager.purgeJob(parent.id);
    expect(store.getJob(parent.id)).toBeNull();
    expect(store.getJob(child.id)).toBeNull();
  });

  test("reuses compatible Quality checkpoints when revalidation is started again", async () => {
    const engine = { runTranslationJob: jest.fn(async () => ({ repaired: true })) };
    const { manager, store } = createManager(engine);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-resume-"));
    const memoryPath = path.join(root, "translation_memory.json");
    const qualityCheckpointPath = path.join(root, "quality.json");
    const observationCheckpointPath = path.join(root, "observation.json");
    fs.writeFileSync(memoryPath, "{}", "utf8");
    fs.writeFileSync(qualityCheckpointPath, "{}", "utf8");
    fs.writeFileSync(observationCheckpointPath, "{}", "utf8");
    store.createJob({
      id: "source-translation",
      type: "translation",
      status: "succeeded",
      stage: "succeeded",
      payload: { translationMode: "learning_style" },
    });
    store.updateJob({
      id: "source-translation",
      result: { projectName: "koharu-project", translationMemorySnapshotPath: memoryPath },
    });
    store.createJob({
      id: "failed-repair",
      type: "translation_quality_repair",
      status: "failed",
      stage: "failed",
      payload: {},
      parentJobId: "source-translation",
    });
    store.addEvent("failed-repair", "quality.window.completed", { checkpointPath: qualityCheckpointPath });
    store.addEvent("failed-repair", "quality_observation.window_completed", { checkpointPath: observationCheckpointPath });

    const retry = manager.createTranslationQualityRepairJob("source-translation");
    await waitForStatus(manager, retry.id, "succeeded");

    expect(engine.runTranslationJob).toHaveBeenCalledWith(expect.objectContaining({
      resumeFromTranslation: expect.objectContaining({
        qualityCheckpointPaths: [qualityCheckpointPath],
        qualityObservationCheckpointPaths: [observationCheckpointPath],
      }),
    }), expect.any(Object));
  });
});
