function languageError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode, code: "invalid_language" });
}

function canonicalLanguageTag(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw languageError(`${fieldName} must contain non-empty BCP 47 language tags.`);
  }
  try {
    return Intl.getCanonicalLocales(value.trim())[0];
  } catch {
    throw languageError(`${fieldName} must contain valid BCP 47 language tags.`, 422);
  }
}

function normalizeSourceLanguage(value, fieldName = "sourceLanguage") {
  if (value == null || value === "") return null;
  if (typeof value === "string") return canonicalLanguageTag(value, fieldName);
  if (!Array.isArray(value)) {
    throw languageError(`${fieldName} must be a BCP 47 language tag or an ordered array of tags.`);
  }
  if (value.length === 0) return null;
  const ordered = value.map((entry) => canonicalLanguageTag(entry, fieldName));
  return [...new Set(ordered)];
}

function sourceLanguageList(value) {
  const normalized = normalizeSourceLanguage(value);
  if (normalized == null) return [];
  return Array.isArray(normalized) ? normalized : [normalized];
}

function primarySourceLanguage(value) {
  return sourceLanguageList(value)[0] || null;
}

function sourceLanguageContext(value) {
  const requested = sourceLanguageList(value);
  return {
    requested,
    primary: requested[0] || null,
    mode: requested.length > 0 ? "explicit" : "auto",
  };
}

module.exports = {
  normalizeSourceLanguage,
  primarySourceLanguage,
  sourceLanguageContext,
  sourceLanguageList,
};
