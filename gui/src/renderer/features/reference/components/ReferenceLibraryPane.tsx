import { useState } from "react";
import type { MangaSeriesSummary, ReferenceSetSummary, TranslatorProfileSummary } from "../../../api/jobs";
import { useLanguageStore } from "../../../stores/language_store";

type ReferenceLibraryPaneProps = {
  mangaSeries: MangaSeriesSummary[];
  referenceSets: ReferenceSetSummary[];
  selectedMangaId: string;
  selectedTranslatorId: string;
  loading: boolean;
  failed: boolean;
  onSelectManga: (mangaId: string) => void;
  onSelectSource: (manga: MangaSeriesSummary, translator: TranslatorProfileSummary) => void;
  onImport: () => void;
};
type GroupProps = {
  manga: MangaSeriesSummary;
  expanded: boolean;
  selectedTranslatorId: string;
  referenceSets: ReferenceSetSummary[];
  onSelectManga: (mangaId: string) => void;
  onSelectSource: (manga: MangaSeriesSummary, translator: TranslatorProfileSummary) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
};

function ReferenceSource(props: GroupProps & { translator: TranslatorProfileSummary }) {
  const { manga, translator, referenceSets, selectedTranslatorId, onSelectSource, t } = props;
  const count = referenceSets.filter(
    (set) => set.mangaId === manga.mangaId && set.translatorId === translator.translatorId,
  ).length;
  return (
    <button
      className={
        selectedTranslatorId === translator.translatorId
          ? "reference-library-source selected"
          : "reference-library-source"
      }
      type="button"
      onClick={() => onSelectSource(manga, translator)}
    >
      <strong>{translator.label}</strong>
      <span>{t("reference.workspace.chapterCount", { count })}</span>
    </button>
  );
}

function ReferenceMangaGroup(props: GroupProps) {
  const { manga, expanded, onSelectManga, t } = props;
  return (
    <div className="reference-library-group" key={manga.mangaId}>
      <button
        className={expanded ? "reference-library-manga selected" : "reference-library-manga"}
        type="button"
        onClick={() => onSelectManga(manga.mangaId)}
      >
        <strong>{manga.label}</strong>
        <span>
          {t("reference.workspace.sourceCount", {
            count: manga.translators.length,
          })}
        </span>
      </button>
      {expanded ? (
        <div className="reference-library-sources">
          {manga.translators.map((translator) => (
            <ReferenceSource {...props} key={translator.translatorId} translator={translator} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LibraryHeader(props: { onImport: () => void; t: GroupProps["t"] }) {
  return (
    <div className="reference-pane-heading">
      <div>
        <h2>{props.t("reference.workspace.libraryTitle")}</h2>
        <p>{props.t("reference.workspace.libraryDescription")}</p>
      </div>
      <button className="secondary-button reference-library-import" type="button" onClick={props.onImport}>
        {props.t("reference.workspace.importAction")}
      </button>
    </div>
  );
}

function LibraryResults(props: ReferenceLibraryPaneProps & { visibleManga: MangaSeriesSummary[]; t: GroupProps["t"] }) {
  const { loading, failed, visibleManga, t } = props;
  return (
    <div className="reference-pane-scroll reference-library-scroll">
      {loading && <p className="muted-text">{t("shared.state.loading")}</p>}
      {failed && <p className="error-text">{t("reference.workspace.libraryError")}</p>}
      {!loading && !failed && !visibleManga.length && (
        <p className="muted-text">{t("reference.workspace.libraryEmpty")}</p>
      )}
      {visibleManga.map((manga) => (
        <ReferenceMangaGroup
          {...props}
          expanded={props.selectedMangaId === manga.mangaId}
          key={manga.mangaId}
          manga={manga}
        />
      ))}
    </div>
  );
}

function filterManga(series: MangaSeriesSummary[], search: string) {
  const normalized = search.trim().toLocaleLowerCase();
  return series.filter(
    (manga) =>
      !normalized ||
      manga.label.toLocaleLowerCase().includes(normalized) ||
      manga.translators.some((translator) => translator.label.toLocaleLowerCase().includes(normalized)),
  );
}

export function ReferenceLibraryPane(props: ReferenceLibraryPaneProps) {
  const t = useLanguageStore((state) => state.t);
  const [search, setSearch] = useState("");
  const visibleManga = filterManga(props.mangaSeries, search);
  return (
    <aside className="reference-library-pane reference-workbench-pane">
      <LibraryHeader onImport={props.onImport} t={t} />
      <label className="reference-library-search">
        <span className="reference-sr-only">{t("reference.workspace.searchLabel")}</span>
        <input
          value={search}
          placeholder={t("reference.workspace.searchPlaceholder")}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
      </label>
      <LibraryResults {...props} visibleManga={visibleManga} t={t} />
    </aside>
  );
}
