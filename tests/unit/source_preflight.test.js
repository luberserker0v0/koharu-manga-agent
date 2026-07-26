const fs = require("fs");
const os = require("os");
const path = require("path");

const { SourcePreflightModule } = require("../../backend/src/modules/source_preflight");

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XnYQAAAAASUVORK5CYII=";

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writePng(targetPath) {
  fs.writeFileSync(targetPath, Buffer.from(PNG_1X1_BASE64, "base64"));
}

describe("source preflight module", () => {
  test("preflight accepts images, rejects non-images, and writes ordered staged images", () => {
    const sourceDir = createTempDir("manga-preflight-source-");
    const preflightRoot = createTempDir("manga-preflight-cache-");

    writePng(path.join(sourceDir, "002.png"));
    writePng(path.join(sourceDir, "001.png"));
    fs.writeFileSync(path.join(sourceDir, "notes.txt"), "not-an-image");

    const module = new SourcePreflightModule({ root: preflightRoot });
    const result = module.preflight({ sourceFolder: sourceDir });

    expect(result.ready).toBe(true);
    expect(result.summary.acceptedCount).toBe(2);
    expect(result.summary.rejectedCount).toBe(1);
    expect(result.rejectedFiles[0].fileName).toBe("notes.txt");
    expect(fs.existsSync(result.images[0].orderedPath)).toBe(true);
    expect(path.basename(result.images[0].orderedPath)).toMatch(/^001\./);
    expect(path.basename(result.images[1].orderedPath)).toMatch(/^002\./);
  });

  test("reorder rewrites ordered staged images only when image order changes", () => {
    const sourceDir = createTempDir("manga-preflight-source-");
    const preflightRoot = createTempDir("manga-preflight-cache-");

    writePng(path.join(sourceDir, "001.png"));
    writePng(path.join(sourceDir, "002.png"));

    const module = new SourcePreflightModule({ root: preflightRoot });
    const created = module.preflight({ sourceFolder: sourceDir });
    const reversedIds = created.images.map((image) => image.id).reverse();

    const reordered = module.reorder({
      preflightId: created.preflightId,
      orderedImageIds: reversedIds,
    });

    expect(reordered.orderChanged).toBe(true);
    expect(reordered.currentFingerprint).toBe(reversedIds.join("|"));
    expect(reordered.images[0].id).toBe(reversedIds[0]);
    expect(module.resolveSourceImages(created.preflightId)[0]).toBe(
      reordered.images[0].orderedPath
    );
  });
});
