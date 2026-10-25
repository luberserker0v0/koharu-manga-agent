import type { MangaSeriesSummary } from "../api/jobs";
import { useLanguageStore } from "../stores/language_store";

export const CREATE_NEW_PROFILE_VALUE = "__create_new_profile__";

export type TranslatorProfileSelection = {
  mangaId: string;
  mangaLabel: string;
  translatorId: string;
  translatorLabel: string;
};

type TranslatorProfileOption = ReturnType<typeof flattenTranslatorProfiles>[number];

export function flattenTranslatorProfiles(series: MangaSeriesSummary[]) {
  return series.flatMap((manga) =>
    (manga.translators || []).map((translator) => ({
      mangaId: manga.mangaId,
      mangaLabel: manga.label,
      translatorId: translator.translatorId,
      translatorLabel: translator.label,
      displayLabel: `${manga.label} + ${translator.label} (${manga.mangaId})`,
      chapters: translator.chapters || [],
    })),
  );
}

export function resolveSelectedTranslatorProfile(
  selectedValue: string,
  series: MangaSeriesSummary[],
): TranslatorProfileSelection | null {
  const matched = flattenTranslatorProfiles(series).find(
    (entry) => `${entry.mangaId}::${entry.translatorId}` === selectedValue,
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

function ProfileOptions({ options }: { options: TranslatorProfileOption[] }) {
  return options.map((entry) => (
    <option key={`${entry.mangaId}::${entry.translatorId}`} value={`${entry.mangaId}::${entry.translatorId}`}>
      {entry.displayLabel}
    </option>
  ));
}

function NewProfileFields(
  props: TranslatorProfileSelectorProps & {
    mangaPlaceholder: string;
    translatorPlaceholder: string;
  },
) {
  return (
    <div className="inline-field-row">
      <input
        placeholder={props.mangaPlaceholder}
        value={props.newMangaLabel}
        onChange={(event) => props.onNewMangaLabelChange(event.currentTarget.value)}
      />
      <input
        placeholder={props.translatorPlaceholder}
        value={props.newTranslatorLabel}
        onChange={(event) => props.onNewTranslatorLabelChange(event.currentTarget.value)}
      />
    </div>
  );
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

export function TranslatorProfileSelector(props: TranslatorProfileSelectorProps) {
  const t = useLanguageStore((state) => state.t);
  const { label, helpText, selectedValue, loading = false, failed = false, allowCreate = true } = props;
  const options = flattenTranslatorProfiles(props.series);
  const emptyText = loading
    ? t("selector.profile.loading")
    : failed
      ? t("selector.profile.failed")
      : t("selector.profile.select");
  return (
    <label>
      <span>{label}</span>
      {helpText ? <small className="muted-text">{helpText}</small> : null}
      <div className="stacked-field-row">
        <select value={selectedValue} onChange={(event) => props.onSelectionChange(event.currentTarget.value)}>
          <option value="">{emptyText}</option>
          <ProfileOptions options={options} />
          {allowCreate ? <option value={CREATE_NEW_PROFILE_VALUE}>{t("selector.profile.create")}</option> : null}
        </select>
        {allowCreate && selectedValue === CREATE_NEW_PROFILE_VALUE ? (
          <NewProfileFields
            {...props}
            mangaPlaceholder={t("selector.profile.mangaPlaceholder")}
            translatorPlaceholder={t("selector.profile.translatorPlaceholder")}
          />
        ) : null}
      </div>
    </label>
  );
}
