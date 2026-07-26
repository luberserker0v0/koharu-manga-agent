const fs = require("fs");
const os = require("os");
const path = require("path");

const { JobStore } = require("../../backend/src/storage/job_store");
const { createRuntime } = require("../../backend/src/runtime");
const { SourcePreflightModule } = require("../../backend/src/modules/source_preflight");

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

function createTempOutputDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "manga-live-output-"));
}

async function createSourcePreflight(baseUrl) {
  const sourceFolder = createTempSourceFolder();
  const res = await fetch(`${baseUrl}/source-preflight`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceFolder }),
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
    const outputDir = createTempOutputDir();

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
        outputDir,
        mangaId: "live_smoke_series",
        mangaLabel: "Live Smoke Series",
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
    expect(fs.existsSync(job.artifacts[0].path)).toBe(true);

    const translatedAfter = new Set(
      fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : []
    );
    expect(translatedAfter.size).toBeGreaterThan(0);
    },
    600000
  );
});
