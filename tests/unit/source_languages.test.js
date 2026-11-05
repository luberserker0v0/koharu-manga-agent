const {
  normalizeSourceLanguage,
  primarySourceLanguage,
  sourceLanguageContext,
} = require("../../backend/src/domains/manga_processing/source_languages");

describe("source language contract", () => {
  test("keeps legacy strings and canonicalizes BCP 47 tags", () => {
    expect(normalizeSourceLanguage("EN-us")).toBe("en-US");
    expect(primarySourceLanguage("ja")).toBe("ja");
  });

  test("preserves ordered arrays while removing duplicates", () => {
    expect(normalizeSourceLanguage(["en", "JA-jp", "en"]))
      .toEqual(["en", "ja-JP"]);
    expect(sourceLanguageContext(["en", "ja"])).toEqual({
      requested: ["en", "ja"], primary: "en", mode: "explicit",
    });
  });

  test("treats omitted and empty values as automatic selection", () => {
    expect(normalizeSourceLanguage(null)).toBeNull();
    expect(normalizeSourceLanguage("")).toBeNull();
    expect(normalizeSourceLanguage([])).toBeNull();
    expect(sourceLanguageContext(null)).toEqual({ requested: [], primary: null, mode: "auto" });
  });

  test("rejects invalid language values", () => {
    expect(() => normalizeSourceLanguage(["en", "not_a_tag"]))
      .toThrow("valid BCP 47");
    expect(() => normalizeSourceLanguage({ language: "en" }))
      .toThrow("ordered array");
  });
});
