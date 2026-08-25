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

export function ReferenceLibraryPane({
  mangaSeries,
  referenceSets,
  selectedMangaId,
  selectedTranslatorId,
  loading,
  failed,
  onSelectManga,
  onSelectSource,
  onImport,
}: ReferenceLibraryPaneProps) {
  const t = useLanguageStore((state) => state.t);
  const [search, setSearch] = useState("");
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleManga = mangaSeries.filter((manga) => {
    if (!normalizedSearch) return true;
    return (
      manga.label.toLocaleLowerCase().includes(normalizedSearch) ||
      manga.translators.some((translator) =>
        translator.label.toLocaleLowerCase().includes(normalizedSearch)
      )
    );
  });

  return (
    <aside className="reference-library-pane reference-workbench-pane">
      <div className="reference-pane-heading">
        <div>
          <h2>{t("reference.workspace.libraryTitle")}</h2>
          <p>{t("reference.workspace.libraryDescription")}</p>
        </div>
        <button className="secondary-button reference-library-import" type="button" onClick={onImport}>
          {t("reference.workspace.importAction")}
        </button>
      </div>
      <label className="reference-library-search">
        <span className="reference-sr-only">{t("reference.workspace.searchLabel")}</span>
        <input
          value={search}
          placeholder={t("reference.workspace.searchPlaceholder")}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
      </label>
      <div className="reference-pane-scroll reference-library-scroll">
        {loading ? <p className="muted-text">{t("shared.state.loading")}</p> : null}
        {failed ? <p className="error-text">{t("reference.workspace.libraryError")}</p> : null}
        {!loading && !failed && visibleManga.length === 0 ? (
          <p className="muted-text">{t("reference.workspace.libraryEmpty")}</p>
        ) : null}
        {visibleManga.map((manga) => {
          const expanded = selectedMangaId === manga.mangaId;
          return (
            <div className="reference-library-group" key={manga.mangaId}>
              <button
                className={expanded ? "reference-library-manga selected" : "reference-library-manga"}
                type="button"
                onClick={() => onSelectManga(manga.mangaId)}
              >
                <strong>{manga.label}</strong>
                <span>{t("reference.workspace.sourceCount", { count: manga.translators.length })}</span>
              </button>
              {expanded ? (
                <div className="reference-library-sources">
                  {manga.translators.map((translator) => {
                    const selected = selectedTranslatorId === translator.translatorId;
                    const chapterCount = referenceSets.filter(
                      (referenceSet) =>
                        referenceSet.mangaId === manga.mangaId &&
                        referenceSet.translatorId === translator.translatorId
                    ).length;
                    return (
                      <button
                        className={selected ? "reference-library-source selected" : "reference-library-source"}
                        key={translator.translatorId}
                        type="button"
                        onClick={() => onSelectSource(manga, translator)}
                      >
                        <strong>{translator.label}</strong>
                        <span>{t("reference.workspace.chapterCount", { count: chapterCount })}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
