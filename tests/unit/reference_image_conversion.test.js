const {
  buildConvertedManifest,
  createConvertedReferenceSetId,
  detectImageFormatFromBuffer,
} = require("../../backend/src/modules/reference_image_conversion");

describe("reference image conversion helper", () => {
  test("detects avif payloads even when extension is misleading", () => {
    const buffer = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from("ftyp", "ascii"),
      Buffer.from("avif", "ascii"),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
    ]);

    expect(detectImageFormatFromBuffer(buffer)).toBe("avif");
  });

  test("creates a stable converted reference set id", () => {
    expect(createConvertedReferenceSetId("ref_001")).toBe("ref_001_converted");
  });

  test("builds a converted manifest with remapped directories", () => {
    const manifest = buildConvertedManifest(
      {
        id: "ref_001",
        label: "PhantomFantasy",
        source: "happymh",
        language: "zh-TW",
        pageCount: 43,
        notes: "reference images for quality comparison",
        imageDir: "references/other_images/ref_001",
        extractedDir: "references/extracted/ref_001",
        comparisonDir: "references/comparisons/ref_001",
        enabled: true,
      },
      "ref_001_converted",
      "png"
    );

    expect(manifest.id).toBe("ref_001_converted");
    expect(manifest.imageDir).toBe("references/other_images/ref_001_converted");
    expect(manifest.extractedDir).toBe("references/extracted/ref_001_converted");
    expect(manifest.comparisonDir).toBe("references/comparisons/ref_001_converted");
    expect(manifest.notes).toContain("Converted to PNG from ref_001.");
  });

  test("does not introduce comparisonDir when the source manifest no longer uses it", () => {
    const manifest = buildConvertedManifest(
      {
        id: "ref_002",
        label: "PhantomFantasyNoComparison",
        source: "provided_by_user",
        language: "zh-TW",
        pageCount: 12,
        notes: "reference images for translation-style diagnostics",
        imageDir: "references/other_images/ref_002",
        extractedDir: "references/extracted/ref_002",
        enabled: true,
      },
      "ref_002_converted",
      "png"
    );

    expect(manifest.comparisonDir).toBeUndefined();
    expect(manifest.imageDir).toBe("references/other_images/ref_002_converted");
    expect(manifest.extractedDir).toBe("references/extracted/ref_002_converted");
  });

  test("preflight marks unsupported payloads for conversion before Koharu upload", () => {
    jest.resetModules();
    jest.doMock("child_process", () => ({
      execFileSync: jest.fn(),
    }));

    const fs = require("fs");
    const originalReadFileSync = fs.readFileSync;
    jest.spyOn(fs, "readFileSync").mockImplementation((filePath) => {
      if (String(filePath).endsWith("page_001.jpg")) {
        return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
      }
      if (String(filePath).endsWith("page_002.jpg")) {
        return Buffer.concat([
          Buffer.from([0x00, 0x00, 0x00, 0x18]),
          Buffer.from("ftyp", "ascii"),
          Buffer.from("avif", "ascii"),
          Buffer.from([0x00, 0x00, 0x00, 0x00]),
        ]);
      }
      return originalReadFileSync(filePath);
    });
    jest
      .spyOn(fs, "mkdtempSync")
      .mockImplementation(() => "C:\\temp\\koharu-upload-preflight\\abc");

    const {
      preflightImagesForKoharuUpload,
    } = require("../../backend/src/modules/reference_image_conversion");

    const result = preflightImagesForKoharuUpload([
      "C:\\images\\page_001.jpg",
      "C:\\images\\page_002.jpg",
    ]);

    expect(result.uploadPaths[0]).toBe("C:\\images\\page_001.jpg");
    expect(result.converted).toHaveLength(1);
    expect(result.converted[0].inputPath).toBe("C:\\images\\page_002.jpg");
    expect(result.converted[0].actualFormat).toBe("avif");
    expect(result.converted[0].outputPath).toContain("page_002.jpg");

    fs.readFileSync.mockRestore();
    fs.mkdtempSync.mockRestore();
    jest.dontMock("child_process");
  });
});
