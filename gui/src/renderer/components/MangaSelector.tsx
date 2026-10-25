import type { MangaSeriesSummary } from "../api/jobs";
import { useLanguageStore } from "../stores/language_store";

export const CREATE_NEW_MANGA_VALUE = "__create_new_manga__";

export function resolveSelectedMangaLabel(selectedValue: string, newMangaLabel: string, options: MangaSeriesSummary[]) {
  if (selectedValue === CREATE_NEW_MANGA_VALUE) {
    const trimmed = newMangaLabel.trim();
    return trimmed || "";
  }

  const matched = options.find((entry) => entry.mangaId === selectedValue);
  return matched?.label || "";
}

type MangaSelectorProps = {
  label: string;
  helpText?: string;
  selectedValue: string;
  newMangaLabel: string;
  options: MangaSeriesSummary[];
  loading?: boolean;
  failed?: boolean;
  onSelectionChange: (value: string) => void;
  onNewMangaLabelChange: (value: string) => void;
};

function MangaOptions({ options }: Pick<MangaSelectorProps, "options">) {
  return options.map((entry) => (
    <option key={entry.mangaId} value={entry.mangaId}>
      {entry.label}
    </option>
  ));
}

export function MangaSelector(props: MangaSelectorProps) {
  const t = useLanguageStore((state) => state.t);
  const { label, helpText, selectedValue, newMangaLabel, options } = props;
  const emptyText = props.loading
    ? t("selector.manga.loading")
    : props.failed
      ? t("selector.manga.failed")
      : t("selector.manga.select");
  return (
    <label>
      <span>{label}</span>
      {helpText ? <small className="muted-text">{helpText}</small> : null}
      <div className="inline-field-row">
        <select value={selectedValue} onChange={(event) => props.onSelectionChange(event.currentTarget.value)}>
          <option value="">{emptyText}</option>
          <MangaOptions options={options} />
          <option value={CREATE_NEW_MANGA_VALUE}>{t("selector.manga.create")}</option>
        </select>
        {selectedValue === CREATE_NEW_MANGA_VALUE ? (
          <input
            placeholder={t("selector.manga.placeholder")}
            value={newMangaLabel}
            onChange={(event) => props.onNewMangaLabelChange(event.currentTarget.value)}
          />
        ) : null}
      </div>
    </label>
  );
}
