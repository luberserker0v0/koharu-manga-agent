const fs = require("fs");
const path = require("path");

const {
  listReferenceSets,
  loadReferenceManifest,
  normalizeSceneTexts,
  referenceSetPaths,
  validateReferenceManifest,
} = require("../../backend/src/domains/reference/sets/reference_sets");
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
    imageDir: `domains/reference/images/${fixtureReferenceId}`,
    extractedDir: `domains/reference/extraction/${fixtureReferenceId}`,
    enabled: true,
  }));
});

afterAll(() => {
  fs.rmSync(referenceSetPaths(fixtureReferenceId).manifestPath, { force: true });
});

describe("reference sets", () => {
  test("manifest contract contains required keys", () => {
    const manifest = {
      id: "ref_001",
      label: "Contract fixture",
      source: "test",
      language: "ja-JP",
      pageCount: 1,
      imageDir: "domains/reference/images/ref_001",
      extractedDir: "domains/reference/extraction/ref_001",
      enabled: true,
    };

    expect(() => validateReferenceManifest(manifest)).not.toThrow();
    expect(manifest.id).toBe("ref_001");
  });

  test("referenceSetPaths resolves all derived paths", () => {
    const paths = referenceSetPaths("ref_123");

    expect(paths.imagesDir).toContain(path.join("domains", "reference", "images", "ref_123"));
    expect(paths.textsPath).toContain(path.join("domains", "reference", "extraction", "ref_123", "texts.json"));
    expect(paths.scenePath).toContain(path.join("domains", "reference", "extraction", "ref_123", "scene.json"));
    expect(paths.comparisonsDir).toContain(path.join("domains", "reference", "comparisons", "ref_123"));
  });

  test("reference manifests no longer require a comparison directory", () => {
    expect(() =>
      validateReferenceManifest({
        id: "ref_optional_comparison",
        label: "fan_translation_b",
        source: "provided_by_user",
        language: "zh-TW",
        pageCount: 4,
        imageDir: "domains/reference/images/ref_optional_comparison",
        extractedDir: "domains/reference/extraction/ref_optional_comparison",
        enabled: true,
      })
    ).not.toThrow();
  });

  test("backend config exposes absolute reference asset paths", () => {
    expect(path.isAbsolute(backendConfig.paths.references)).toBe(true);
    expect(path.isAbsolute(backendConfig.paths.referenceImages)).toBe(true);
    expect(path.isAbsolute(backendConfig.paths.referenceExtracted)).toBe(true);
    expect(path.isAbsolute(backendConfig.paths.referenceComparisons)).toBe(true);
    expect(path.isAbsolute(backendConfig.paths.referenceManifests)).toBe(true);
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
