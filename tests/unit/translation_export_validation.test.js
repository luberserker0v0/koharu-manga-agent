const fs = require("fs");
const os = require("os");
const path = require("path");
const { createZipBuffer } = require("../../backend/src/integrations/ao/assets/ao_assets");
const { ExportModule } = require("../../backend/src/domains/translation/execution/export");

function writeExportZip(imageCount) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "translation-export-validation-"));
  const exportPath = path.join(directory, "export.zip");
  const files = Array.from({ length: imageCount }, (_, index) => ({
    name: `${String(index + 1).padStart(3, "0")}.png`,
    content: Buffer.from(`image-${index + 1}`),
  }));
  fs.writeFileSync(exportPath, createZipBuffer(files));
  return exportPath;
}

describe("translation export validation", () => {
  test("accepts an export containing every selected source image", async () => {
    const artifact = { path: writeExportZip(2), format: "rendered" };
    const module = new ExportModule({ exportCurrentProject: jest.fn().mockResolvedValue(artifact) });

    await expect(module.run({ outputDir: os.tmpdir(), expectedImageCount: 2 })).resolves.toBe(artifact);
  });

  test("rejects a partial export", async () => {
    const artifact = { path: writeExportZip(1), format: "rendered" };
    const module = new ExportModule({ exportCurrentProject: jest.fn().mockResolvedValue(artifact) });

    await expect(module.run({ outputDir: os.tmpdir(), expectedImageCount: 2 }))
      .rejects.toMatchObject({ code: "translated_image_mapping_mismatch" });
  });
});
