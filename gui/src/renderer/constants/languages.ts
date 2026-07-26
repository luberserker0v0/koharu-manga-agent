export const DEFAULT_REFERENCE_LANGUAGE = "zh-TW";

export const REFERENCE_LANGUAGE_OPTIONS = [
  { value: "zh-TW", label: "zh-TW" },
  { value: "zh-CN", label: "zh-CN" },
  { value: "ja-JP", label: "ja-JP" },
  { value: "en-US", label: "en-US" },
  { value: "ko-KR", label: "ko-KR" },
] as const;

const LANGUAGE_ALIASES = new Map<string, string>([
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
]);

export function normalizeReferenceLanguage(value: string | null | undefined) {
  return LANGUAGE_ALIASES.get(String(value || "").trim().toLowerCase()) || DEFAULT_REFERENCE_LANGUAGE;
}
