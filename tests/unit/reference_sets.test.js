const fs = require("fs");
const path = require("path");

const {
  listReferenceSets,
  loadReferenceManifest,
  normalizeSceneTexts,
  referenceSetPaths,
  validateReferenceManifest,
} = require("../../backend/src/modules/reference_sets");
const backendConfig = require("../../backend/src/config");

const fixtureReferenceId = `ref_test_${Date.now().toString(36)}`;

beforeAll(() => {
  const { manifestPath } = referenceSetPaths(fixtureReferenceId);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({
    id: fixtureReferenceId,
    label: "Reference test fixture",
    source: "test",
    referenceKind: "source",
    language: "ja-JP",
    pageCount: 1,
    imageDir: `references/other_images/${fixtureReferenceId}`,
    extractedDir: `references/extracted/${fixtureReferenceId}`,
    enabled: true,
  }));
});

afterAll(() => {
  fs.rmSync(referenceSetPaths(fixtureReferenceId).manifestPath, { force: true });
});

describe("reference sets", () => {
  test("example manifest contains required keys", () => {
    const manifestPath = path.join(
      __dirname,
      "../../references/manifests/_schema.example.json"
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    expect(() => validateReferenceManifest(manifest)).not.toThrow();
    expect(manifest.id).toBe("ref_001");
  });

  test("referenceSetPaths resolves all derived paths", () => {
    const paths = referenceSetPaths("ref_123");

    expect(paths.imagesDir).toContain(path.join("references", "other_images", "ref_123"));
    expect(paths.textsPath).toContain(path.join("references", "extracted", "ref_123", "texts.json"));
    expect(paths.scenePath).toContain(path.join("references", "extracted", "ref_123", "scene.json"));
    expect(paths.comparisonsDir).toContain(path.join("references", "comparisons", "ref_123"));
  });

  test("reference manifests no longer require a comparison directory", () => {
    expect(() =>
      validateReferenceManifest({
        id: "ref_optional_comparison",
        label: "fan_translation_b",
        source: "provided_by_user",
        language: "zh-TW",
        pageCount: 4,
        imageDir: "references/other_images/ref_optional_comparison",
        extractedDir: "references/extracted/ref_optional_comparison",
        enabled: true,
      })
    ).not.toThrow();
  });

  test("backend config exposes absolute reference asset paths", () => {
    expect(path.isAbsolute(backendConfig.paths.references)).toBe(true);
    expect(path.isAbsolute(backendConfig.paths.referenceImages)).toBe(true);
    expect(path.isAbsolute(backendConfig.paths.referenceExtracted)).toBe(true);
    expect(path.isAbsolute(backendConfig.paths.legacyReferenceDiagnostics)).toBe(true);
    expect(path.isAbsolute(backendConfig.paths.referenceComparisons)).toBe(true);
    expect(path.isAbsolute(backendConfig.paths.referenceManifests)).toBe(true);
    expect(backendConfig.paths.legacyReferenceDiagnostics).toBe(
      backendConfig.paths.referenceComparisons
    );
  });

  test("normalizeSceneTexts builds extracted reference text structure", () => {
    const scene = {
      scene: {
        pages: {
          page1: {
            name: "001.jpg",
            nodes: {
              node1: {
                kind: {
                  text: {
                    text: "原文",
                    translation: "譯文",
                  },
                },
                transform: {
                  x: 10,
                  y: 20,
                  width: 100,
                  height: 50,
                },
              },
            },
          },
        },
      },
    };

    const normalized = normalizeSceneTexts(scene, "other");

    expect(normalized.source).toBe("other");
    expect(normalized.pages[0].pageName).toBe("001.jpg");
    expect(normalized.pages[0].texts[0].bbox.width).toBe(100);
    expect(normalized.pages[0].texts[0].center.x).toBe(60);
  });

  test("loadReferenceManifest validates stored manifests", () => {
    const manifest = loadReferenceManifest(fixtureReferenceId);
    expect(manifest.id).toBe(fixtureReferenceId);
    expect(manifest.enabled).toBe(true);
  });

  test("listReferenceSets exposes enabled manifest summaries for gui dropdowns", () => {
    const referenceSets = listReferenceSets();
    expect(referenceSets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: fixtureReferenceId,
          label: expect.any(String),
          source: expect.any(String),
          language: expect.any(String),
          pageCount: expect.any(Number),
          extractionAvailable: expect.any(Boolean),
          enabled: true,
        }),
      ])
    );
  });
});
