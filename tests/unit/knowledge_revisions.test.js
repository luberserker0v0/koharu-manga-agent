const fs = require("fs");
const os = require("os");
const path = require("path");

describe("knowledge revisions", () => {
  test("restores the prior baseline and marks later revisions stale", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-revisions-"));
    const knowledgeRoot = path.join(tempRoot, "knowledge_base");
    jest.resetModules();
    jest.doMock("../../backend/src/config", () => ({
      PROJECT_ROOT: tempRoot,
      paths: {
        knowledgeBase: path.join(knowledgeRoot, "self", "my-manga.json"),
        reports: path.join(knowledgeRoot, "reports", "extract_report.json"),
      },
    }));

    const { JobStore } = require("../../backend/src/storage/job_store");
    const {
      finalizeKnowledgeRevision,
      prepareKnowledgeRevision,
      revisionTargets,
    } = require("../../backend/src/modules/knowledge_revisions");
    const store = new JobStore(path.join(tempRoot, "jobs.sqlite"));
    const scope = { mangaId: "series", translatorId: "source" };
    const storyPath = revisionTargets(scope).storyContext;
    fs.mkdirSync(path.dirname(storyPath), { recursive: true });
    fs.writeFileSync(storyPath, JSON.stringify({ chapters: {} }));

    const commitRevision = (chapterId, chapterSortOrder, workflowId, chapters) => {
      const planPath = path.join(tempRoot, "plans", `${workflowId}.json`);
      const payload = {
        ...scope,
        chapterId,
        chapterSortOrder,
        workflowId,
        referenceSetId: `ref_${chapterId}`,
        referenceKind: "source",
      };
      const plan = prepareKnowledgeRevision({ store, payload, planPath });
      fs.writeFileSync(storyPath, JSON.stringify({ chapters }));
      return finalizeKnowledgeRevision({ store, planPath, analysisArtifactPath: null }).revision;
    };

    const first = commitRevision("chapter_1", 0, "workflow_1", { chapter_1: { summary: "one" } });
    const second = commitRevision("chapter_2", 1, "workflow_2", {
      chapter_1: { summary: "one" },
      chapter_2: { summary: "two" },
    });

    const rerunPlanPath = path.join(tempRoot, "plans", "workflow_1_rerun.json");
    const rerunPlan = prepareKnowledgeRevision({
      store,
      planPath: rerunPlanPath,
      payload: {
        ...scope,
        chapterId: "chapter_1",
        chapterSortOrder: 0,
        workflowId: "workflow_1_rerun",
        referenceSetId: "ref_chapter_1",
        referenceKind: "source",
      },
    });

    expect(JSON.parse(fs.readFileSync(storyPath, "utf8"))).toEqual({ chapters: {} });
    expect(rerunPlan.staleRevisions.map((revision) => revision.id)).toEqual([first.id, second.id]);
    expect(store.getKnowledgeRevision(first.id).status).toBe("stale");
    expect(store.getKnowledgeRevision(second.id).status).toBe("stale");

    const retryPlan = prepareKnowledgeRevision({
      store,
      planPath: path.join(tempRoot, "plans", "workflow_1_retry.json"),
      payload: {
        ...rerunPlan.payload,
        workflowId: "workflow_1_retry",
      },
    });
    expect(retryPlan.staleRevisions.map((revision) => revision.id)).toEqual([first.id, second.id]);

    jest.dontMock("../../backend/src/config");
  });

  test("starts a new baseline when cleared ingestion left orphan revision metadata", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-orphan-revisions-"));
    const knowledgeRoot = path.join(tempRoot, "knowledge_base");
    jest.resetModules();
    jest.doMock("../../backend/src/config", () => ({
      PROJECT_ROOT: tempRoot,
      paths: {
        knowledgeBase: path.join(knowledgeRoot, "self", "my-manga.json"),
        reports: path.join(knowledgeRoot, "reports", "extract_report.json"),
      },
    }));

    const { JobStore } = require("../../backend/src/storage/job_store");
    const { prepareKnowledgeRevision } = require("../../backend/src/modules/knowledge_revisions");
    const store = new JobStore(path.join(tempRoot, "jobs.sqlite"));
    store.createKnowledgeRevision({
      id: "orphan_revision",
      mangaId: "series",
      translatorId: "source",
      chapterId: "chapter_1",
      sequenceNumber: 0,
      workflowId: "old_workflow",
      referenceSetId: "old_reference",
      referenceKind: "source",
      status: "active",
      beforeSnapshotPath: path.join(tempRoot, "missing", "before", "manifest.json"),
      afterSnapshotPath: path.join(tempRoot, "missing", "after", "manifest.json"),
      payload: {},
    });

    const plan = prepareKnowledgeRevision({
      store,
      planPath: path.join(tempRoot, "plans", "new.json"),
      payload: {
        mangaId: "series",
        translatorId: "source",
        chapterId: "chapter_1",
        chapterSortOrder: 0,
        workflowId: "new_workflow",
        referenceSetId: "new_reference",
        referenceKind: "source",
      },
    });

    expect(plan.restoreSkippedReason).toBe("missing_snapshot_and_no_live_knowledge_assets");
    expect(plan.restoredSnapshotPath).toBeNull();
    expect(fs.existsSync(plan.beforeSnapshotPath)).toBe(true);
    expect(store.getKnowledgeRevision("orphan_revision").status).toBe("stale");
    jest.dontMock("../../backend/src/config");
    jest.resetModules();
  });
});
