const {
  profileFingerprint,
  resolvePipelineProfile,
} = require("../../backend/src/domains/translation/pipeline/pipeline_profiles");

const pipeline = {
  defaultProfile: "quality",
  modeProfiles: { quick: "fast", reference_style: "quality" },
  profiles: {
    fast: { engines: { clean: "lama-manga" } },
    quality: { engines: { clean: "flux2-klein", ocr: "manga-ocr" } },
  },
};

describe("translation pipeline profiles", () => {
  test("maps quick translation to the fast Lama Manga profile", () => {
    expect(resolvePipelineProfile(pipeline, { translationMode: "quick" })).toEqual({
      id: "fast",
      source: "translation_mode",
      engines: { clean: "lama-manga" },
      fingerprint: profileFingerprint("fast", { clean: "lama-manga" }),
    });
  });

  test("uses the default profile outside a mapped translation mode", () => {
    expect(resolvePipelineProfile(pipeline)).toEqual(expect.objectContaining({
      id: "quality", source: "default", engines: { ocr: "manga-ocr", clean: "flux2-klein" },
    }));
  });

  test("request selection wins and missing profiles fail explicitly", () => {
    expect(resolvePipelineProfile(pipeline, { requestedProfileId: "fast" }).source).toBe("request");
    expect(() => resolvePipelineProfile(pipeline, { requestedProfileId: "missing" }))
      .toThrow("Pipeline profile is unavailable");
  });
});
