const fs = require("fs");
const path = require("path");
const { paths } = require("../../backend/src/config");
const { TranslatedImageService } = require("../../backend/src/domains/translation/exports/translated_image_service");
const { createApiServer } = require("../../backend/src/http/server/api_server");

describe("translated images API", () => {
  let root;
  let imagePath;
  let api;
  let baseUrl;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(paths.workspaceRoot, "translated-images-api-"));
    imagePath = path.join(root, "translated.png");
    fs.writeFileSync(imagePath, Buffer.from("translated-image"));
    const artifacts = [{ id: 21, kind: "export", path: imagePath, metadata: {}, createdAt: new Date().toISOString() }];
    api = createApiServer({
      jobManager: {
        getJobArtifacts: (jobId) => jobId === "job-images" ? artifacts : null,
      },
      translatedImageService: new TranslatedImageService({ root: path.join(root, "cache") }),
      host: "127.0.0.1",
      port: 0,
    });
    await api.listen();
    baseUrl = `http://127.0.0.1:${api.server.address().port}/api/v1`;
  });

  afterEach(async () => {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("lists, base64-encodes, and streams a translated image", async () => {
    const listResponse = await fetch(`${baseUrl}/jobs/job-images/translated-images`);
    expect(listResponse.status).toBe(200);
    const listed = await listResponse.json();
    expect(listed).toEqual(expect.objectContaining({ sourceFormat: "image", count: 1 }));
    const image = listed.images[0];

    const encodedResponse = await fetch(`http://127.0.0.1:${api.server.address().port}${image.encodedUrl}`);
    expect(encodedResponse.status).toBe(200);
    const encoded = await encodedResponse.json();
    expect(Buffer.from(encoded.data, "base64").toString("utf8")).toBe("translated-image");

    const contentResponse = await fetch(`http://127.0.0.1:${api.server.address().port}${image.contentUrl}`);
    expect(contentResponse.status).toBe(200);
    expect(contentResponse.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await contentResponse.arrayBuffer()).toString("utf8")).toBe("translated-image");
  });

  test("returns 404 for an unknown Job", async () => {
    expect((await fetch(`${baseUrl}/jobs/missing/translated-images`)).status).toBe(404);
  });
});
