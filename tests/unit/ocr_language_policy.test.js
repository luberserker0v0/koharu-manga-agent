const {
  resolveKoharuOcr,
} = require("../../backend/src/integrations/koharu/pipeline/ocr_language_policy");

const catalog = {
  ocr: [
    { id: "manga-ocr" },
    { id: "mit48px-ocr" },
    { id: "paddle-ocr-vl-1.5" },
  ],
};

describe("Koharu OCR language policy", () => {
  test("uses multilingual OCR for English and reports unsupported hints", () => {
    const selected = resolveKoharuOcr({ catalog, sourceLanguage: ["en", "ja"] });

    expect(selected.engineId).toBe("paddle-ocr-vl-1.5");
    expect(selected.resolution).toEqual(expect.objectContaining({
      requestedSourceLanguages: ["en", "ja"],
      effectiveSourceLanguages: ["en", "ja"],
      primarySourceLanguage: "en",
      selectionSource: "language_policy",
      hintsSupported: false,
      hintsApplied: false,
      appliedLanguageHints: [],
    }));
    expect(selected.resolution.warnings[0]).toContain("does not expose OCR language hints");
  });

  test("uses the documented multilingual adapter default for automatic mode", () => {
    const selected = resolveKoharuOcr({ catalog });
    expect(selected.engineId).toBe("paddle-ocr-vl-1.5");
    expect(selected.resolution).toEqual(expect.objectContaining({
      mode: "auto", selectionSource: "adapter_default",
    }));
  });

  test("allows an unknown explicit engine but exposes uncertain compatibility", () => {
    const selected = resolveKoharuOcr({
      catalog,
      configuredEngine: "mit48px-ocr",
      sourceLanguage: "en",
    });
    expect(selected.engineId).toBe("mit48px-ocr");
    expect(selected.resolution.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("compatibility is not declared"),
    ]));
  });

  test("returns an actionable error when no compatible engine is available", () => {
    expect(() => resolveKoharuOcr({
      catalog: { ocr: [{ id: "manga-ocr" }] },
      sourceLanguage: "en",
    })).toThrow(expect.objectContaining({
      code: "unsupported_ocr_language_combination",
      statusCode: 422,
    }));
  });
});
