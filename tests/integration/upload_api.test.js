const fs = require("fs");
const os = require("os");
const path = require("path");
const { paths } = require("../../backend/src/config");
const { UploadService } = require("../../backend/src/domains/uploads/upload_service");
const { createApiServer } = require("../../backend/src/http/server/api_server");

describe("browser upload and artifact APIs", () => {
  let directory;
  let artifactDirectory;
  let artifactPath;
  let api;
  let baseUrl;
  let sourcePreflightModule;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "manga-upload-api-"));
    fs.mkdirSync(paths.workspaceRoot, { recursive: true });
    artifactDirectory = fs.mkdtempSync(path.join(paths.workspaceRoot, "artifact-api-"));
    artifactPath = path.join(artifactDirectory, "result.json");
    fs.writeFileSync(artifactPath, JSON.stringify({ ok: true }), "utf8");
    sourcePreflightModule = { preflight: jest.fn(({ sourceFolder }) => ({ sourceFolder, ready: true })) };
    api = createApiServer({
      jobManager: {
        getConfig: () => ({}),
        getJobArtifacts: (jobId) => jobId === "job-1"
          ? [{ id: 7, kind: "result", path: artifactPath }]
          : null,
      },
      sourcePreflightModule,
      uploadService: new UploadService({ root: directory, maxFileBytes: 16, maxFiles: 2 }),
      host: "127.0.0.1",
      port: 0,
    });
    await api.listen();
    baseUrl = `http://127.0.0.1:${api.server.address().port}`;
  });

  afterEach(async () => {
    await api.close();
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(artifactDirectory, { recursive: true, force: true });
  });

  test("uploads image files and resolves a ready source upload for preflight", async () => {
    const created = await (await fetch(`${baseUrl}/api/v1/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "source" }),
    })).json();

    const uploads = await Promise.all(["001.png", "002.png"].map((fileName) =>
      fetch(`${baseUrl}/api/v1/uploads/${created.uploadId}/files/${fileName}`, {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body: Buffer.from(`png-${fileName}`),
      })
    ));
    expect(uploads.map((response) => response.status)).toEqual([201, 201]);
    const completed = await fetch(`${baseUrl}/api/v1/uploads/${created.uploadId}/complete`, { method: "POST" });
    expect(completed.status).toBe(200);
    expect((await completed.json()).files).toHaveLength(2);

    const preflight = await fetch(`${baseUrl}/api/v1/source-preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId: created.uploadId }),
    });
    expect(preflight.status).toBe(200);
    expect(sourcePreflightModule.preflight).toHaveBeenCalledWith({
      sourceFolder: path.join(directory, created.uploadId, "files"),
    });
  });

  test("rejects traversal filenames and oversized image bodies", async () => {
    const created = await (await fetch(`${baseUrl}/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "source" }),
    })).json();
    expect((await fetch(`${baseUrl}/uploads/${created.uploadId}/files/..%2Fevil.png`, {
      method: "PUT",
      body: Buffer.from("x"),
    })).status).toBe(400);
    expect((await fetch(`${baseUrl}/uploads/${created.uploadId}/files/large.png`, {
      method: "PUT",
      body: Buffer.alloc(17),
    })).status).toBe(413);
  });

  test("streams an artifact file without exposing arbitrary paths", async () => {
    const response = await fetch(`${baseUrl}/api/v1/jobs/job-1/artifacts/7/content`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ ok: true });
    expect((await fetch(`${baseUrl}/jobs/job-1/artifacts/8/content`)).status).toBe(404);
  });
});
