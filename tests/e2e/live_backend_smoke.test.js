const fs = require("fs");
const os = require("os");
const path = require("path");

const { JobStore } = require("../../backend/src/domains/jobs/persistence/job_store");
const { createRuntime } = require("../../backend/src/runtime");
const { SourcePreflightModule } = require("../../backend/src/domains/translation/preflight/source_preflight");

function createTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-live-"));
  return path.join(dir, "jobs.sqlite");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTempSourceFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-live-source-"));
  const minimalPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==",
    "base64"
  );
  fs.writeFileSync(path.join(dir, "001.png"), minimalPng);
  return dir;
}

async function createSourcePreflight(baseUrl) {
  const sourceFolder = createTempSourceFolder();
  const created = await (await fetch(`${baseUrl}/api/v1/uploads`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "source" }),
  })).json();
  await fetch(`${baseUrl}/api/v1/uploads/${created.uploadId}/files/001.png`, {
    method: "PUT", body: fs.readFileSync(path.join(sourceFolder, "001.png")),
  });
  await fetch(`${baseUrl}/api/v1/uploads/${created.uploadId}/complete`, { method: "POST" });
  const res = await fetch(`${baseUrl}/source-preflight`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadId: created.uploadId }),
  });
  const manifest = await res.json();
  return manifest.preflightId;
}

async function waitForJob(baseUrl, jobId, timeoutMs = 600000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const res = await fetch(`${baseUrl}/jobs/${jobId}`);
    const job = await res.json();
    if (["succeeded", "failed", "canceled"].includes(job.status)) {
      return job;
    }
    await delay(1000);
  }

  throw new Error(`Timed out waiting for live job ${jobId}`);
}

describe("live backend smoke", () => {
  let runtime;
  let baseUrl;

  beforeAll(async () => {
    const available = await global.checkKoharu();
    if (!available) {
      console.warn("Koharu unavailable, skipping live backend smoke test.");
    }
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.api.close();
      runtime = null;
    }
  });

  test(
    "real backend can finish a translation job against Koharu",
    async () => {
    if (!global.KOHARU_AVAILABLE) return;
    runtime = createRuntime({
      store: new JobStore(createTempDbPath()),
      sourcePreflightModule: new SourcePreflightModule({
        root: fs.mkdtempSync(path.join(os.tmpdir(), "manga-live-preflight-")),
      }),
      host: "127.0.0.1",
      port: 0,
    });

    await runtime.api.listen();
    const address = runtime.api.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
    const preflightId = await createSourcePreflight(baseUrl);

    const createRes = await fetch(`${baseUrl}/jobs/translation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        translationMode: "quick",
        targetLanguage: "zh-TW",
        qualityCheck: false,
        exportFormat: "rendered",
        mangaId: "live_smoke_series",
        mangaLabel: "Live Smoke Series",
        translatorId: "live_smoke_output",
        chapterId: "ch_smoke_001",
        sourcePreflightId: preflightId,
      }),
    });

    expect(createRes.status).toBe(202);
    const created = await createRes.json();

    const job = await waitForJob(baseUrl, created.id);

    expect(job.status).toBe("succeeded");
    expect(job.result.projectName).toMatch(/^translate_/);
    expect(typeof job.result.operationId).toBe("string");
    expect(job.result.pipeline.summary.finalStatus).toMatch(/completed/);
    expect(job.result.quality).toBeNull();
    expect(job.result.knowledge).toBeNull();
    expect(job.result.closed).toBe(true);
    expect(job.artifacts.length).toBeGreaterThan(0);
    const exportArtifact = job.artifacts.find((artifact) => artifact.kind === "export");
    expect(exportArtifact).toEqual(expect.objectContaining({ contentUrl: expect.any(String) }));
    expect((await fetch(`${baseUrl}${exportArtifact.contentUrl}`)).status).toBe(200);
    },
    600000
  );
});
