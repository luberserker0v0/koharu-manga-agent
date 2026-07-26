const fs = require("fs");
const os = require("os");
const path = require("path");

const { JobStore } = require("../../backend/src/storage/job_store");
const { WorkflowEngine } = require("../../backend/src/workflow_engine");
const { JobManager } = require("../../backend/src/job_manager");
const { createApiServer } = require("../../backend/src/http/api_server");
const { SourcePreflightModule } = require("../../backend/src/modules/source_preflight");
const { resolveTranslationModePolicy } = require("../../backend/src/modules/translation_modes");

const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0L0AAAAASUVORK5CYII=",
  "base64"
);

const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
  548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
  10080,
]);

function createTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-e2e-"));
  return path.join(dir, "jobs.sqlite");
}

function createTempSourceFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-e2e-source-"));
  fs.writeFileSync(path.join(dir, "001.png"), MINIMAL_PNG);
  return dir;
}

function createTempOutputDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "manga-e2e-output-"));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJob(baseUrl, jobId, timeoutMs = 3000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const res = await fetch(`${baseUrl}/jobs/${jobId}`);
    const job = await res.json();
    if (["succeeded", "failed", "canceled"].includes(job.status)) {
      return job;
    }
    await delay(20);
  }

  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function createBackend({ modules }) {
  const store = new JobStore(createTempDbPath());
  const sourcePreflightModule = new SourcePreflightModule({
    root: fs.mkdtempSync(path.join(os.tmpdir(), "manga-e2e-preflight-")),
  });
  const projectLifecycle = modules.projectLifecycle || {};
  if (!projectLifecycle.client) {
    projectLifecycle.client = {
      getScene: jest.fn().mockResolvedValue({
        scene: {
          pages: {
            page_1: {
              name: "001.png",
              nodes: {
                node_1: { kind: { text: { text: "source", translation: "translation" } } },
              },
            },
          },
        },
      }),
    };
  }
  const engine = new WorkflowEngine({
    sourcePreflightModule,
    ...modules,
    projectLifecycle,
    translationMemoryComposer: modules.translationMemoryComposer || ((payload) => ({
      schemaVersion: 1,
      translationMode: payload.translationMode,
      policy: resolveTranslationModePolicy(payload.translationMode, payload.qualityCheck === true),
      mangaId: payload.mangaId || null,
      translatorId: payload.translatorId || null,
      chapterId: payload.chapterId || null,
      chapterMapping: null,
      layers: { reference: null, local: null },
      effective: { glossary: [], sourceIdentity: [], story: null, style: null, localKnowledge: null },
      usage: { glossaryEntries: 0, sourceIdentityEntries: 0, storyCharacters: 0, storyTerms: 0, styleChapters: 0, characterSpeechEntries: 0, localPairs: 0 },
      readiness: { reference: true, local: true },
      warnings: [],
      revisions: [],
      fingerprint: `test-${payload.translationMode}`,
    })),
  });
  const jobManager = new JobManager({
    store,
    engine,
    runtimeConfig: { host: "127.0.0.1", port: 0 },
    resolvedConfig: {
      api: { baseUrl: "http://127.0.0.1:9999" },
      defaults: { targetLanguage: "zh-TW", exportFormat: "rendered" },
      workflow: {
        qualityCheck: { enabled: true },
        knowledgeBuilder: { enabled: false },
      },
    },
  });

  const api = createApiServer({
    jobManager,
    sourcePreflightModule,
    host: "127.0.0.1",
    port: 0,
  });

  let address;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await api.listen();
    address = api.server.address();
    if (!FETCH_FORBIDDEN_PORTS.has(address.port)) break;
    await api.close();
    address = null;
  }
  if (!address) throw new Error("Could not allocate a Fetch-safe test port.");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return { api, baseUrl };
}

async function createSourcePreflight(baseUrl) {
  const sourceFolder = createTempSourceFolder();
  const res = await fetch(`${baseUrl}/source-preflight`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceFolder }),
  });
  const manifest = await res.json();
  return {
    sourceFolder,
    preflightId: manifest.preflightId,
  };
}

describe("backend job flow e2e", () => {
  let api;
  let baseUrl;

  afterEach(async () => {
    if (api) {
      await api.close();
      api = null;
    }
  });

  test("successful job runs quality and skips knowledge by default", async () => {
    const qualityModule = {
      run: jest.fn().mockResolvedValue({
        overall: "pass",
        score: 1,
        totalTranslations: 1,
        issues: [],
        warnings: [],
        passedChecks: ["translations_present"],
        failedChecks: [],
      }),
    };
    const knowledgeModule = { run: jest.fn().mockResolvedValue({ translationPairs: 10 }) };
    const projectLifecycle = { closeCurrentProject: jest.fn().mockResolvedValue({ success: true }) };

    ({ api, baseUrl } = await createBackend({
      modules: {
        projectSetup: {
          run: jest.fn().mockResolvedValue({
            projectName: "translate_success",
            operationId: "op-success",
            engines: { translate: "llm" },
            steps: ["detect", "ocr", "translate", "render"],
          }),
        },
        pipelineMonitor: {
          run: jest.fn().mockResolvedValue({
            summary: { finalStatus: "completed", totalPages: 2, steps: {} },
            recovered: false,
          }),
        },
        qualityModule,
        knowledgeModule,
        exportModule: {
          run: jest.fn().mockResolvedValue({
            path: "C:\\translated\\success.zip",
            size: 123,
            format: "rendered",
          }),
        },
        projectLifecycle,
      },
    }));

    const { preflightId } = await createSourcePreflight(baseUrl);
    const outputDir = createTempOutputDir();
    const createRes = await fetch(`${baseUrl}/jobs/translation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ translationMode: "reference_style", referenceTranslatorId: "translator_reference", qualityCheck: true, targetLanguage: "zh-TW", sourcePreflightId: preflightId, outputDir }),
    });
    const created = await createRes.json();
    const job = await waitForJob(baseUrl, created.id);

    expect(job.status).toBe("succeeded");
    expect(job.result.projectName).toBe("translate_success");
    expect(job.result.quality).toBeTruthy();
    expect(job.result.knowledge).toBeNull();
    expect(job.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "source_preflight_manifest" }),
        expect.objectContaining({ kind: "export", path: expect.stringContaining("success.zip") }),
      ])
    );
    expect(qualityModule.run).toHaveBeenCalledTimes(1);
    expect(knowledgeModule.run).not.toHaveBeenCalled();
    expect(projectLifecycle.closeCurrentProject).toHaveBeenCalledTimes(1);
  });

  test("job can skip quality and run knowledge when requested", async () => {
    const qualityModule = {
      run: jest.fn().mockResolvedValue({
        overall: "pass",
        score: 1,
        totalTranslations: 1,
        issues: [],
        warnings: [],
        passedChecks: ["translations_present"],
        failedChecks: [],
      }),
    };
    const knowledgeModule = { run: jest.fn().mockResolvedValue({ translationPairs: 21, terminology: 3 }) };

    ({ api, baseUrl } = await createBackend({
      modules: {
        projectSetup: {
          run: jest.fn().mockResolvedValue({
            projectName: "translate_knowledge",
            operationId: "op-knowledge",
            engines: {},
            steps: [],
          }),
        },
        pipelineMonitor: {
          run: jest.fn().mockResolvedValue({
            summary: { finalStatus: "completed", totalPages: 1, steps: {} },
            recovered: false,
          }),
        },
        qualityModule,
        knowledgeModule,
        exportModule: {
          run: jest.fn().mockResolvedValue({
            path: "C:\\translated\\knowledge.zip",
            size: 321,
            format: "rendered",
          }),
        },
        projectLifecycle: {
          closeCurrentProject: jest.fn().mockResolvedValue({ success: true }),
        },
      },
    }));

    const { preflightId } = await createSourcePreflight(baseUrl);
    const outputDir = createTempOutputDir();
    const createRes = await fetch(`${baseUrl}/jobs/translation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        translationMode: "local_style",
        targetLanguage: "zh-TW",
        qualityCheck: false,
        mangaId: "phantom_fantasy",
        mangaLabel: "Phantom Fantasy",
        chapterId: "ch_001",
        sourcePreflightId: preflightId,
        outputDir,
      }),
    });
    const created = await createRes.json();
    const job = await waitForJob(baseUrl, created.id);

    expect(job.status).toBe("succeeded");
    expect(job.result.quality).toBeNull();
    expect(job.result.knowledge).toBeNull();
    expect(job.children).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "translation_knowledge_commit" }),
    ]));
    const knowledgeJob = await waitForJob(baseUrl, job.children[0].id);
    expect(knowledgeJob.status).toBe("succeeded");
    expect(qualityModule.run).not.toHaveBeenCalled();
    expect(knowledgeModule.run).toHaveBeenCalledTimes(1);
    expect(knowledgeModule.run).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: null,
      mangaId: "phantom_fantasy",
      mangaLabel: "Phantom Fantasy",
      translatorId: null,
      translatorLabel: null,
      chapterId: "ch_001",
      chapterTitle: null,
      learningEvidenceSnapshotPath: expect.stringContaining("learning_evidence_snapshot.json"),
    }));
  });

  test("translation job builds a system prompt from manga assets before setup", async () => {
    const projectSetup = {
      run: jest.fn().mockResolvedValue({
        projectName: "translate_with_context",
        operationId: "op-context",
        engines: {},
        steps: [],
      }),
    };

    ({ api, baseUrl } = await createBackend({
      modules: {
        projectSetup,
        pipelineMonitor: {
          run: jest.fn().mockResolvedValue({
            summary: { finalStatus: "completed", totalPages: 1, steps: {} },
            recovered: false,
          }),
        },
        translationMemoryComposer: (payload) => ({
          schemaVersion: 1,
          translationMode: payload.translationMode,
          policy: resolveTranslationModePolicy(payload.translationMode, true),
          mangaId: payload.mangaId,
          translatorId: "translator_test",
          chapterId: payload.chapterId,
          chapterMapping: null,
          layers: { reference: {}, local: null },
          effective: {
            glossary: [{ source_term: "Alice", canonical_translation: "alice" }],
            sourceIdentity: [],
            story: null,
            style: null,
            localKnowledge: null,
          },
          usage: { glossaryEntries: 1 },
          readiness: { reference: true, local: true },
          warnings: [],
          revisions: [],
          fingerprint: "test-reference-memory",
        }),
        qualityModule: {
          run: jest.fn().mockResolvedValue({
            overall: "pass",
            score: 1,
            totalTranslations: 1,
            issues: [],
            warnings: [],
            passedChecks: ["translations_present"],
            failedChecks: [],
          }),
        },
        knowledgeModule: { run: jest.fn().mockResolvedValue({ translationPairs: 0 }) },
        exportModule: {
          run: jest.fn().mockResolvedValue({
            path: "C:\\translated\\context.zip",
            size: 55,
            format: "rendered",
          }),
        },
        projectLifecycle: { closeCurrentProject: jest.fn().mockResolvedValue({ success: true }) },
      },
    }));

    const { preflightId } = await createSourcePreflight(baseUrl);
    const outputDir = createTempOutputDir();
    const createRes = await fetch(`${baseUrl}/jobs/translation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        translationMode: "reference_style",
        referenceTranslatorId: "translator_reference",
        qualityCheck: true,
        targetLanguage: "zh-TW",
        mangaId: "phantom_fantasy",
        chapterId: "ch_001",
        sourcePreflightId: preflightId,
        outputDir,
      }),
    });
    const created = await createRes.json();
    const job = await waitForJob(baseUrl, created.id);

    expect(job.status).toBe("succeeded");
    const projectSetupArgs = projectSetup.run.mock.calls[0][0];
    expect(projectSetupArgs.targetLanguage).toBe("zh-TW");
    expect(projectSetupArgs.baseUrl).toBe("http://127.0.0.1:4000");
    expect(projectSetupArgs.sourceImagePaths).toEqual(
      expect.arrayContaining([expect.stringContaining(`${path.sep}ordered${path.sep}001.png`)])
    );
    expect(projectSetupArgs.systemPrompt).toEqual(expect.stringContaining("alice"));
  });

  test("knowledge child failure does not roll back the exported translation", async () => {
    const exportModule = {
      run: jest.fn().mockResolvedValue({
        path: "C:\\translated\\knowledge-child-failure.zip",
        size: 77,
        format: "rendered",
      }),
    };
    ({ api, baseUrl } = await createBackend({
      modules: {
        projectSetup: {
          run: jest.fn().mockResolvedValue({
            projectName: "translate_knowledge_failure",
            operationId: "op-knowledge-failure",
            engines: {},
            steps: [],
          }),
        },
        pipelineMonitor: {
          run: jest.fn().mockResolvedValue({
            summary: { finalStatus: "completed", totalPages: 1, steps: {} },
            recovered: false,
          }),
        },
        qualityModule: { run: jest.fn() },
        knowledgeModule: { run: jest.fn().mockRejectedValue(new Error("AO quota exhausted")) },
        exportModule,
        projectLifecycle: { closeCurrentProject: jest.fn().mockResolvedValue({ success: true }) },
      },
    }));

    const { preflightId } = await createSourcePreflight(baseUrl);
    const createRes = await fetch(`${baseUrl}/jobs/translation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        translationMode: "local_style",
        qualityCheck: false,
        targetLanguage: "zh-TW",
        mangaId: "phantom_fantasy",
        chapterId: "ch_001",
        sourcePreflightId: preflightId,
        outputDir: createTempOutputDir(),
      }),
    });
    const created = await createRes.json();
    const parent = await waitForJob(baseUrl, created.id);
    const child = await waitForJob(baseUrl, parent.children[0].id);

    expect(parent.status).toBe("succeeded");
    expect(parent.result.finalTranslationSnapshotPath).toContain("final_translation_snapshot.json");
    expect(parent.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "export" }),
      expect.objectContaining({ kind: "final_translation_snapshot" }),
    ]));
    expect(child.status).toBe("failed");
    expect(child.error).toContain("AO quota exhausted");
    expect(exportModule.run).toHaveBeenCalledTimes(1);

    const retryResponse = await fetch(`${baseUrl}/jobs/${child.id}/retry`, { method: "POST" });
    expect(retryResponse.status).toBe(202);
    const retried = await retryResponse.json();
    expect(retried.parentJobId).toBe(parent.id);
    const retriedTerminal = await waitForJob(baseUrl, retried.id);
    expect(retriedTerminal.status).toBe("failed");
    expect(exportModule.run).toHaveBeenCalledTimes(1);
  });

  test("export failure marks job failed and does not close project", async () => {
    const projectLifecycle = { closeCurrentProject: jest.fn().mockResolvedValue({ success: true }) };

    ({ api, baseUrl } = await createBackend({
      modules: {
        projectSetup: {
          run: jest.fn().mockResolvedValue({
            projectName: "translate_export_fail",
            operationId: "op-export-fail",
            engines: {},
            steps: [],
          }),
        },
        pipelineMonitor: {
          run: jest.fn().mockResolvedValue({
            summary: { finalStatus: "completed", totalPages: 1, steps: {} },
            recovered: false,
          }),
        },
        qualityModule: {
          run: jest.fn().mockResolvedValue({
            overall: "pass",
            score: 1,
            totalTranslations: 1,
            issues: [],
            warnings: [],
            passedChecks: ["translations_present"],
            failedChecks: [],
          }),
        },
        knowledgeModule: { run: jest.fn().mockResolvedValue({ translationPairs: 0 }) },
        exportModule: {
          run: jest.fn().mockRejectedValue(new Error("Export failed (500): mocked export error")),
        },
        projectLifecycle,
      },
    }));

    const { preflightId } = await createSourcePreflight(baseUrl);
    const outputDir = createTempOutputDir();
    const createRes = await fetch(`${baseUrl}/jobs/translation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ translationMode: "quick", targetLanguage: "zh-TW", sourcePreflightId: preflightId, outputDir }),
    });
    const created = await createRes.json();
    const job = await waitForJob(baseUrl, created.id);

    expect(job.status).toBe("failed");
    expect(job.error).toContain("mocked export error");
    expect(job.artifacts).toEqual([]);
    expect(projectLifecycle.closeCurrentProject).not.toHaveBeenCalled();
  });

  test("quality failure stops export and does not close project", async () => {
    const exportModule = {
      run: jest.fn().mockResolvedValue({
        path: "C:\\translated\\should-not-export.zip",
        size: 1,
        format: "rendered",
      }),
    };
    const projectLifecycle = { closeCurrentProject: jest.fn().mockResolvedValue({ success: true }) };

    ({ api, baseUrl } = await createBackend({
      modules: {
        projectSetup: {
          run: jest.fn().mockResolvedValue({
            projectName: "translate_quality_fail",
            operationId: "op-quality-fail",
            engines: {},
            steps: [],
          }),
        },
        pipelineMonitor: {
          run: jest.fn().mockResolvedValue({
            summary: { finalStatus: "completed", totalPages: 1, steps: {} },
            recovered: false,
          }),
        },
        qualityModule: {
          run: jest.fn().mockRejectedValue(new Error("Quality review failed: mocked validation failure")),
        },
        knowledgeModule: { run: jest.fn().mockResolvedValue({ translationPairs: 0 }) },
        exportModule,
        projectLifecycle,
      },
    }));

    const { preflightId } = await createSourcePreflight(baseUrl);
    const outputDir = createTempOutputDir();
    const createRes = await fetch(`${baseUrl}/jobs/translation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ translationMode: "reference_style", referenceTranslatorId: "translator_reference", qualityCheck: true, targetLanguage: "zh-TW", sourcePreflightId: preflightId, outputDir }),
    });
    const created = await createRes.json();
    const job = await waitForJob(baseUrl, created.id);

    expect(job.status).toBe("failed");
    expect(job.error).toContain("mocked validation failure");
    expect(exportModule.run).not.toHaveBeenCalled();
    expect(projectLifecycle.closeCurrentProject).not.toHaveBeenCalled();
  });

  test("unresolved translation completeness blocks export", async () => {
    const exportModule = { run: jest.fn() };
    const projectLifecycle = { closeCurrentProject: jest.fn() };
    ({ api, baseUrl } = await createBackend({
      modules: {
        projectSetup: { run: jest.fn().mockResolvedValue({
          projectName: "translate_incomplete",
          operationId: "op-incomplete",
          engines: {},
          steps: [],
        }) },
        pipelineMonitor: { run: jest.fn().mockResolvedValue({
          summary: { finalStatus: "completed", totalPages: 1, steps: {} },
          recovered: false,
        }) },
        qualityModule: { run: jest.fn().mockResolvedValue({
          overall: "fail",
          score: 0,
          totalTranslations: 1,
          issues: [],
          warnings: [],
          passedChecks: ["translations_present"],
          failedChecks: ["translation_completeness"],
          completeness: { unresolvedCount: 1 },
        }) },
        knowledgeModule: { run: jest.fn() },
        exportModule,
        projectLifecycle,
      },
    }));

    const { preflightId } = await createSourcePreflight(baseUrl);
    const createRes = await fetch(`${baseUrl}/jobs/translation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        translationMode: "reference_style",
        referenceTranslatorId: "translator_reference",
        qualityCheck: true,
        targetLanguage: "zh-TW",
        sourcePreflightId: preflightId,
        outputDir: createTempOutputDir(),
      }),
    });
    const created = await createRes.json();
    const job = await waitForJob(baseUrl, created.id);

    expect(job.status).toBe("failed");
    expect(job.error).toContain("Quality blocked export");
    expect(exportModule.run).not.toHaveBeenCalled();
    expect(projectLifecycle.closeCurrentProject).not.toHaveBeenCalled();
  });

  test("cancel request turns a running job into canceled", async () => {
    ({ api, baseUrl } = await createBackend({
      modules: {
        projectSetup: {
          run: jest.fn().mockResolvedValue({
            projectName: "translate_cancel",
            operationId: "op-cancel",
            engines: {},
            steps: [],
          }),
        },
        pipelineMonitor: {
          run: jest.fn().mockImplementation(async ({ isCanceled }) => {
            while (!isCanceled()) {
              await delay(10);
            }
            throw new Error("Job canceled");
          }),
        },
        qualityModule: { run: jest.fn() },
        knowledgeModule: { run: jest.fn() },
        exportModule: { run: jest.fn() },
        projectLifecycle: { closeCurrentProject: jest.fn() },
      },
    }));

    const { preflightId } = await createSourcePreflight(baseUrl);
    const outputDir = createTempOutputDir();
    const createRes = await fetch(`${baseUrl}/jobs/translation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ translationMode: "quick", targetLanguage: "zh-TW", sourcePreflightId: preflightId, outputDir }),
    });
    const created = await createRes.json();

    await delay(30);
    const cancelRes = await fetch(`${baseUrl}/jobs/${created.id}/cancel`, {
      method: "POST",
    });
    expect(cancelRes.status).toBe(202);

    const job = await waitForJob(baseUrl, created.id);
    expect(job.status).toBe("canceled");
    expect(job.error).toBeNull();
  });

  test("job stream exposes ordered backend events", async () => {
    ({ api, baseUrl } = await createBackend({
      modules: {
        projectSetup: {
          run: jest.fn().mockResolvedValue({
            projectName: "translate_stream",
            operationId: "op-stream",
            engines: {},
            steps: [],
          }),
        },
        pipelineMonitor: {
          run: jest.fn().mockImplementation(async ({ onProgress }) => {
            onProgress({ operationId: "op-stream", status: "running", progress: 0.5 });
            return {
              summary: { finalStatus: "completed", totalPages: 1, steps: {} },
              recovered: false,
            };
          }),
        },
        qualityModule: {
          run: jest.fn().mockResolvedValue({
            overall: "pass",
            score: 1,
            totalTranslations: 1,
            issues: [],
            warnings: [],
            passedChecks: ["translations_present"],
            failedChecks: [],
          }),
        },
        knowledgeModule: { run: jest.fn().mockResolvedValue({ translationPairs: 0 }) },
        exportModule: {
          run: jest.fn().mockResolvedValue({
            path: "C:\\translated\\stream.zip",
            size: 55,
            format: "rendered",
          }),
        },
        projectLifecycle: { closeCurrentProject: jest.fn().mockResolvedValue({ success: true }) },
      },
    }));

    const { preflightId } = await createSourcePreflight(baseUrl);
    const outputDir = createTempOutputDir();
    const createRes = await fetch(`${baseUrl}/jobs/translation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ translationMode: "quick", targetLanguage: "zh-TW", sourcePreflightId: preflightId, outputDir }),
    });
    const created = await createRes.json();

    const controller = new AbortController();
    const streamRes = await fetch(`${baseUrl}/jobs/${created.id}/stream`, {
      signal: controller.signal,
    });

    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();
    let text = "";

    while (!text.includes("event: job.completed")) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
    }

    controller.abort();

    expect(text).toContain("event: job.created");
    expect(text).toContain('"type":"job.created"');
    expect(text).toContain('"createdAt":"');
    expect(text).toContain("event: source_preflight.resolved");
    expect(text).toContain("event: job.stage");
    expect(text).toContain("event: pipeline.progress");
    expect(text).toContain("event: export.completed");
    expect(text).toContain("event: job.completed");
  });

  test("jobs stream emits snapshot envelope and heartbeat", async () => {
    ({ api, baseUrl } = await createBackend({
      modules: {
        projectSetup: {
          run: jest.fn().mockResolvedValue({
            projectName: "translate_jobs_stream",
            operationId: "op-jobs-stream",
            engines: {},
            steps: [],
          }),
        },
        pipelineMonitor: {
          run: jest.fn().mockResolvedValue({
            summary: { finalStatus: "completed", totalPages: 1, steps: {} },
            recovered: false,
          }),
        },
        qualityModule: {
          run: jest.fn().mockResolvedValue({
            overall: "pass",
            score: 1,
            totalTranslations: 1,
            issues: [],
            warnings: [],
            passedChecks: ["translations_present"],
            failedChecks: [],
          }),
        },
        knowledgeModule: { run: jest.fn().mockResolvedValue({ translationPairs: 0 }) },
        exportModule: {
          run: jest.fn().mockResolvedValue({
            path: "C:\\translated\\jobs-stream.zip",
            size: 55,
            format: "rendered",
          }),
        },
        projectLifecycle: { closeCurrentProject: jest.fn().mockResolvedValue({ success: true }) },
      },
    }));

    const controller = new AbortController();
    const streamRes = await fetch(`${baseUrl}/jobs/stream`, {
      signal: controller.signal,
    });

    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const startedAt = Date.now();

    while (
      (!text.includes('event: jobs.snapshot') ||
        !text.includes('"type":"jobs.snapshot"') ||
        !text.includes(": heartbeat")) &&
      Date.now() - startedAt < 5000
    ) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
    }

    controller.abort();

    expect(text).toContain("event: jobs.snapshot");
    expect(text).toContain('"type":"jobs.snapshot"');
    expect(text).toContain('"createdAt":"');
    expect(text).toContain(": heartbeat");

    const envelopeController = new AbortController();
    const envelopeRes = await fetch(`${baseUrl}/jobs/stream?eventMode=message`, {
      signal: envelopeController.signal,
    });
    const envelopeReader = envelopeRes.body.getReader();
    const envelopeDecoder = new TextDecoder();
    let envelopeText = "";
    while (!envelopeText.includes('"type":"jobs.snapshot"')) {
      const { value, done } = await envelopeReader.read();
      if (done) break;
      envelopeText += envelopeDecoder.decode(value, { stream: true });
    }
    envelopeController.abort();

    expect(envelopeText).toContain("event: message");
    expect(envelopeText).toContain('"type":"jobs.snapshot"');
  });
});
