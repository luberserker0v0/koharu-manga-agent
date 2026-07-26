import { create } from "zustand";
import type { AppLocale } from "../i18n/messages";
import { translate } from "../i18n/messages";

type LanguageState = {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
};

export const useLanguageStore = create<LanguageState>((set, get) => ({
  locale: "zh-TW",
  setLocale: (locale) => set((state) => (state.locale === locale ? state : { locale })),
  t: (key, params) => translate(get().locale, key, params),
}));
