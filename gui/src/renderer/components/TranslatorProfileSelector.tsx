import type { MangaSeriesSummary } from "../api/jobs";
import { useLanguageStore } from "../stores/language_store";

export const CREATE_NEW_PROFILE_VALUE = "__create_new_profile__";

export type TranslatorProfileSelection = {
  mangaId: string;
  mangaLabel: string;
  translatorId: string;
  translatorLabel: string;
};

export function flattenTranslatorProfiles(series: MangaSeriesSummary[]) {
  return series.flatMap((manga) =>
    (manga.translators || []).map((translator) => ({
      mangaId: manga.mangaId,
      mangaLabel: manga.label,
      translatorId: translator.translatorId,
      translatorLabel: translator.label,
      displayLabel: `${manga.label} + ${translator.label} (${manga.mangaId})`,
      chapters: translator.chapters || [],
    }))
  );
}

export function resolveSelectedTranslatorProfile(
  selectedValue: string,
  series: MangaSeriesSummary[]
): TranslatorProfileSelection | null {
  const matched = flattenTranslatorProfiles(series).find(
    (entry) => `${entry.mangaId}::${entry.translatorId}` === selectedValue
  );
  if (!matched) {
    return null;
  }

  return {
    mangaId: matched.mangaId,
    mangaLabel: matched.mangaLabel,
    translatorId: matched.translatorId,
    translatorLabel: matched.translatorLabel,
  };
}

type TranslatorProfileSelectorProps = {
  label: string;
  helpText?: string;
  selectedValue: string;
  series: MangaSeriesSummary[];
  loading?: boolean;
  failed?: boolean;
  allowCreate?: boolean;
  newMangaLabel: string;
  newTranslatorLabel: string;
  onSelectionChange: (value: string) => void;
  onNewMangaLabelChange: (value: string) => void;
  onNewTranslatorLabelChange: (value: string) => void;
};

export function TranslatorProfileSelector({
  label,
  helpText,
  selectedValue,
  series,
  loading = false,
  failed = false,
  allowCreate = true,
  newMangaLabel,
  newTranslatorLabel,
  onSelectionChange,
  onNewMangaLabelChange,
  onNewTranslatorLabelChange,
}: TranslatorProfileSelectorProps) {
  const t = useLanguageStore((state) => state.t);
  const options = flattenTranslatorProfiles(series);

  return (
    <label>
      <span>{label}</span>
      {helpText ? <small className="muted-text">{helpText}</small> : null}
      <div className="stacked-field-row">
        <select value={selectedValue} onChange={(event) => onSelectionChange(event.currentTarget.value)}>
          <option value="">
            {loading
              ? t("selector.profile.loading")
              : failed
                ? t("selector.profile.failed")
                : t("selector.profile.select")}
          </option>
          {options.map((entry) => (
            <option key={`${entry.mangaId}::${entry.translatorId}`} value={`${entry.mangaId}::${entry.translatorId}`}>
              {entry.displayLabel}
            </option>
          ))}
          {allowCreate ? (
            <option value={CREATE_NEW_PROFILE_VALUE}>{t("selector.profile.create")}</option>
          ) : null}
        </select>
        {allowCreate && selectedValue === CREATE_NEW_PROFILE_VALUE ? (
          <div className="inline-field-row">
            <input
              placeholder={t("selector.profile.mangaPlaceholder")}
              value={newMangaLabel}
              onChange={(event) => onNewMangaLabelChange(event.currentTarget.value)}
            />
            <input
              placeholder={t("selector.profile.translatorPlaceholder")}
              value={newTranslatorLabel}
              onChange={(event) => onNewTranslatorLabelChange(event.currentTarget.value)}
            />
          </div>
        ) : null}
      </div>
    </label>
  );
}
