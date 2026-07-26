const DEFAULT_LANGUAGE_TAG = "zh-TW";

const SUPPORTED_LANGUAGE_OPTIONS = [
  { value: "zh-TW", label: "Traditional Chinese (Taiwan)" },
  { value: "zh-CN", label: "Simplified Chinese" },
  { value: "ja-JP", label: "Japanese" },
  { value: "en-US", label: "English (US)" },
  { value: "ko-KR", label: "Korean" },
];

const LANGUAGE_ALIASES = new Map(
  [
    ["zh-tw", "zh-TW"],
    ["zh-hant", "zh-TW"],
    ["zh-hant-tw", "zh-TW"],
    ["zh-cn", "zh-CN"],
    ["zh-hans", "zh-CN"],
    ["zh-hans-cn", "zh-CN"],
    ["ja", "ja-JP"],
    ["ja-jp", "ja-JP"],
    ["en", "en-US"],
    ["en-us", "en-US"],
    ["ko", "ko-KR"],
    ["ko-kr", "ko-KR"],
  ]
);

function normalizeLanguageTag(value, fallback = DEFAULT_LANGUAGE_TAG) {
  const normalizedFallback = LANGUAGE_ALIASES.get(String(fallback || "").trim().toLowerCase()) || DEFAULT_LANGUAGE_TAG;
  const normalizedValue = LANGUAGE_ALIASES.get(String(value || "").trim().toLowerCase());
  return normalizedValue || normalizedFallback;
}

module.exports = {
  DEFAULT_LANGUAGE_TAG,
  SUPPORTED_LANGUAGE_OPTIONS,
  normalizeLanguageTag,
};
