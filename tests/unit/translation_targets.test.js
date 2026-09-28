const {
  normalizeTranslationCatalog,
  resolveTranslationTarget,
  validateTranslationTargetShape,
} = require("../../backend/src/integrations/koharu/translation/translation_targets");

function catalog() {
  return {
    localModels: [{ target: { kind: "local", modelId: "local-model", providerId: null }, name: "Local model", languages: ["zh-TW"] }],
    providers: [
      {
        id: "deepl",
        name: "DeepL",
        requiresApiKey: true,
        hasApiKey: true,
        status: "ready",
        models: [{ target: { kind: "provider", providerId: "deepl", modelId: "mt" }, name: "Machine Translation", languages: ["zh-TW"] }],
      },
      {
        id: "caiyun",
        name: "Caiyun",
        requiresApiKey: true,
        hasApiKey: false,
        status: "missing_configuration",
        models: [{ target: { kind: "provider", providerId: "caiyun", modelId: "mt" }, languages: ["zh-TW"] }],
      },
    ],
  };
}

describe("Koharu translation targets", () => {
  test("normalizes local, hosted, and machine translation providers without credentials", () => {
    const result = normalizeTranslationCatalog(catalog());
    expect(result.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: "local", kind: "local_llm", status: "ready" }),
      expect.objectContaining({ providerId: "deepl", kind: "machine_translation", hasCredential: true }),
      expect.objectContaining({ providerId: "caiyun", kind: "machine_translation", hasCredential: false }),
    ]));
    expect(JSON.stringify(result)).not.toContain("apiKey");
  });

  test("resolves a ready machine translation target", () => {
    expect(resolveTranslationTarget({
      catalog: catalog(),
      requestedTarget: { providerId: "deepl", modelId: "mt" },
      targetLanguage: "zh-TW",
    })).toEqual(expect.objectContaining({
      kind: "machine_translation",
      targetKind: "provider",
      providerId: "deepl",
      modelId: "mt",
    }));
  });

  test("rejects an unconfigured provider before project creation", () => {
    expect(() => resolveTranslationTarget({
      catalog: catalog(),
      requestedTarget: { providerId: "caiyun", modelId: "mt" },
      targetLanguage: "zh-TW",
    })).toThrow("not ready");
    try {
      resolveTranslationTarget({ catalog: catalog(), requestedTarget: { providerId: "caiyun", modelId: "mt" } });
    } catch (error) {
      expect(error.statusCode).toBe(409);
      expect(error.code).toBe("translation_provider_not_ready");
    }
  });

  test("validates the public request shape", () => {
    expect(validateTranslationTargetShape({ providerId: "deepl", modelId: "mt" }))
      .toEqual({ providerId: "deepl", modelId: "mt" });
    expect(() => validateTranslationTargetShape({ providerId: "deepl", modelId: "mt", apiKey: "secret" }))
      .toThrow("only accepts");
  });
});
