import { appMessagesEnUS, appMessagesZhTW } from "./messages/app";
import { jobDetailMessagesEnUS, jobDetailMessagesZhTW } from "./messages/job-detail";
import { jobListMessagesEnUS, jobListMessagesZhTW } from "./messages/job-list";
import { jobsMessagesEnUS, jobsMessagesZhTW } from "./messages/jobs";
import { mangaMessagesEnUS, mangaMessagesZhTW } from "./messages/manga";
import { postEditMessagesEnUS, postEditMessagesZhTW } from "./messages/post-edit";
import { referenceExtraMessagesEnUS, referenceExtraMessagesZhTW } from "./messages/reference-extra";
import { settingsMessagesEnUS, settingsMessagesZhTW } from "./messages/settings";
import { sharedExtraMessagesEnUS, sharedExtraMessagesZhTW } from "./messages/shared-extra";
import { referenceMessagesEnUS, referenceMessagesZhTW } from "./messages/reference";
import { sharedMessagesEnUS, sharedMessagesZhTW } from "./messages/shared";
import { zhTwLegacyLiteralOverrides } from "./messages/legacy-literals";

export type AppLocale = "zh-TW" | "en-US";

type MessageValue = string | ((params?: Record<string, string | number>) => string);
type MessageDictionary = Record<string, MessageValue>;

function interpolate(template: string, params?: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (_match, key) => String(params?.[key] ?? ""));
}

export const MESSAGES: Record<AppLocale, MessageDictionary> = {
  "zh-TW": {
  ...appMessagesZhTW,
  ...jobDetailMessagesZhTW,
  ...jobListMessagesZhTW,
  ...jobsMessagesZhTW,
  ...mangaMessagesZhTW,
  ...postEditMessagesZhTW,
  ...referenceExtraMessagesZhTW,
  ...settingsMessagesZhTW,
  ...sharedExtraMessagesZhTW,
  ...referenceMessagesZhTW,
  ...sharedMessagesZhTW,
  },
  "en-US": {
  ...appMessagesEnUS,
  ...jobDetailMessagesEnUS,
  ...jobListMessagesEnUS,
  ...jobsMessagesEnUS,
  ...mangaMessagesEnUS,
  ...postEditMessagesEnUS,
  ...referenceExtraMessagesEnUS,
  ...settingsMessagesEnUS,
  ...sharedExtraMessagesEnUS,
  ...referenceMessagesEnUS,
  ...sharedMessagesEnUS,
  },
};

export function translateLiteral(locale: AppLocale, text: string): string {
  return locale === "zh-TW" ? zhTwLegacyLiteralOverrides[text] ?? text : text;
}

export function translate(locale: AppLocale, key: string, params?: Record<string, string | number>) {
  const dictionary = MESSAGES[locale] || MESSAGES["zh-TW"];
  const value = dictionary[key] ?? MESSAGES["zh-TW"][key] ?? key;
  return typeof value === "function" ? value(params) : interpolate(value, params);
}
