import type { Dispatch, SetStateAction } from "react";
import { MangaSelector } from "../../../components/MangaSelector";
import { TranslatorSelector } from "../../../components/TranslatorSelector";
import {
  DEFAULT_REFERENCE_LANGUAGE,
  normalizeReferenceLanguage,
  REFERENCE_LANGUAGE_OPTIONS,
} from "../../../constants/languages";
import { useLanguageStore } from "../../../stores/language_store";
import { SectionCard } from "../../shared/components/SectionCard";
import type {
  QueuedReferenceFolder,
  ReferenceImportForm,
  ReferenceMangaOption,
  ReferenceTranslatorOption,
} from "../types";

type ReferenceImportPaneProps = {
  importForm: ReferenceImportForm;
  setImportForm: Dispatch<SetStateAction<ReferenceImportForm>>;
  importQueue: QueuedReferenceFolder[];
  isWorklistImporting: boolean;
  mangaSeriesOptions: ReferenceMangaOption[];
  mangaSeriesLoading: boolean;
  mangaSeriesFailed: boolean;
  availableImportTranslators: ReferenceTranslatorOption[];
  isSourceReferenceKind: (kind: string | undefined) => boolean;
  sourceReferenceTranslatorLabel: string;
  hasSourceReferenceInWorklist: boolean;
  hasTranslatorReferenceInWorklist: boolean;
  importBlockedReason: string | null;
  removeQueuedReferenceFolder: (id: string) => void;
  updateQueuedReferenceFolderLabel: (id: string, label: string) => void;
  importQueuedReferenceFolders: () => Promise<void>;
  pickSingleFolder: () => Promise<void>;
  pickMultipleFolders: () => Promise<void>;
  clearQueuedReferenceFolders: () => void;
};

export function ReferenceImportPane({
  importForm,
  setImportForm,
  importQueue,
  isWorklistImporting,
  mangaSeriesOptions,
  mangaSeriesLoading,
  mangaSeriesFailed,
  availableImportTranslators,
  isSourceReferenceKind,
  sourceReferenceTranslatorLabel,
  hasSourceReferenceInWorklist,
  hasTranslatorReferenceInWorklist,
  importBlockedReason,
  removeQueuedReferenceFolder,
  updateQueuedReferenceFolderLabel,
  importQueuedReferenceFolders,
  pickSingleFolder,
  pickMultipleFolders,
  clearQueuedReferenceFolders,
}: ReferenceImportPaneProps) {
  const t = useLanguageStore((state) => state.t);

  return (
    <SectionCard
      title={t("reference.section.import.title")}
      description={t("reference.section.import.description")}
      defaultOpen
    >
      <p className="muted-text">
        Load one or many translated chapter folders first, then review their display names before importing.
      </p>
      <div className="form-grid">
        <label>
          <span>Reference folder</span>
          <div className="inline-field-row">
            <input
              readOnly
              value={importForm.sourceFolder}
              placeholder="Choose one or more folders"
            />
            <button className="secondary-button" type="button" onClick={() => void pickSingleFolder()}>
              Add folder
            </button>
            <button className="secondary-button" type="button" onClick={() => void pickMultipleFolders()}>
              Add multiple folders
            </button>
          </div>
          <small className="muted-text">
            Load one or many translated chapter folders first, then review their display names before importing.
          </small>
        </label>
        <label>
          <span>Language</span>
          <select
            value={normalizeReferenceLanguage(importForm.language || DEFAULT_REFERENCE_LANGUAGE)}
            onChange={(event) => {
              const nextLanguage = normalizeReferenceLanguage(event.currentTarget?.value);
              setImportForm((current) => ({
                ...current,
                language: nextLanguage,
              }));
            }}
          >
            {REFERENCE_LANGUAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <small className="muted-text">
            This language is written into the imported reference metadata for downstream processing.
          </small>
        </label>
        <label>
          <span>Reference type</span>
          <select
            value={importForm.referenceKind}
            onChange={(event) => {
              const nextKind = event.currentTarget.value === "source" ? "source" : "translator";
              setImportForm((current) => ({
                ...current,
                referenceKind: nextKind,
                translatorSelection: nextKind === "source" ? "" : current.translatorSelection,
                newTranslatorLabel: nextKind === "source" ? "" : current.newTranslatorLabel,
              }));
            }}
          >
            <option value="source">{t("reference.import.referenceType.source")}</option>
            <option value="translator">{t("reference.import.referenceType.translator")}</option>
          </select>
          <small className="muted-text">{t("reference.import.referenceType.help")}</small>
        </label>
        <MangaSelector
          label="Manga"
          helpText="Optional. Bind imported folders to a manga; each folder becomes a chapter under that manga."
          selectedValue={importForm.mangaSelection}
          newMangaLabel={importForm.newMangaLabel}
          options={mangaSeriesOptions}
          loading={mangaSeriesLoading}
          failed={mangaSeriesFailed}
          onSelectionChange={(value) =>
            setImportForm((current) => ({
              ...current,
              mangaSelection: value,
              translatorSelection: "",
              newTranslatorLabel: "",
            }))
          }
          onNewMangaLabelChange={(value) =>
            setImportForm((current) => ({
              ...current,
              newMangaLabel: value,
            }))
          }
        />
        {isSourceReferenceKind(importForm.referenceKind) ? (
          <label>
            <span>Translator</span>
            <small className="muted-text">{t("reference.import.originalTranslator.help")}</small>
            <input value={sourceReferenceTranslatorLabel} readOnly />
          </label>
        ) : (
          <TranslatorSelector
            label="Translator"
            helpText="After choosing a manga, select or create a translator. Chapter bindings will be created from folder names automatically."
            selectedValue={importForm.translatorSelection}
            newTranslatorLabel={importForm.newTranslatorLabel}
            options={availableImportTranslators}
            loading={mangaSeriesLoading}
            failed={mangaSeriesFailed}
            disabled={!importForm.mangaSelection}
            emptyLabel={importForm.mangaSelection ? "Select translator" : "Choose manga first"}
            loadingLabel="Loading translators..."
            failedLabel="Failed to load translators"
            createLabel="Create new translator"
            inputPlaceholder="Enter translator name"
            onSelectionChange={(value) =>
              setImportForm((current) => ({
                ...current,
                translatorSelection: value,
              }))
            }
            onNewTranslatorLabelChange={(value) =>
              setImportForm((current) => ({
                ...current,
                newTranslatorLabel: value,
              }))
            }
          />
        )}
      </div>
      {hasSourceReferenceInWorklist ? (
        <p className="muted-text">
          {"\u539F\u6587 Reference \u53EA\u6703\u7D2F\u7A4D\u6558\u4E8B / \u5C0D\u8A71 / \u65C1\u767D\u8B49\u64DA\u8207\u5C08\u6709\u540D\u8A5E\uFF0C\u4E0D\u6703\u5EFA\u7ACB\u7FFB\u8B6F\u98A8\u683C\u3002"}
          {hasTranslatorReferenceInWorklist
            ? " \u82E5\u6E05\u55AE\u6DF7\u6709\u8B6F\u8005 reference\uFF0C\u7FFB\u8B6F\u98A8\u683C\u53EA\u6703\u5957\u7528\u5728\u8B6F\u8005\u8CC7\u6599\u3002"
            : ""}
        </p>
      ) : null}
      <div className="button-row">
        <button
          className="primary-button"
          type="button"
          disabled={Boolean(importBlockedReason)}
          onClick={() => void importQueuedReferenceFolders()}
        >
          {"\u532F\u5165\u5DF2\u8F09\u5165\u8CC7\u6599\u593E"}
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={importQueue.length === 0}
          onClick={clearQueuedReferenceFolders}
        >
          {"\u6E05\u7A7A\u8F09\u5165\u6E05\u55AE"}
        </button>
        <span className="muted-text">{`\u5171 ${importQueue.length} \u7B46`}</span>
      </div>
      {importBlockedReason ? <p className="muted-text">{importBlockedReason}</p> : null}
      {importQueue.length > 0 ? (
        <ul className="artifact-list">
          {importQueue.map((entry) => (
            <li key={entry.id} className="artifact-item">
              <div>
                <input
                  value={entry.label}
                  onChange={(event) => {
                    updateQueuedReferenceFolderLabel(entry.id, event.currentTarget.value);
                  }}
                />
                <div className="job-subtext">{entry.sourceFolder}</div>
              </div>
              <div className="job-actions">
                <button
                  className="secondary-button danger-button"
                  type="button"
                  onClick={() => removeQueuedReferenceFolder(entry.id)}
                >
                  {"\u79FB\u9664"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted-text">{"\u5C1A\u672A\u8F09\u5165\u4EFB\u4F55\u8CC7\u6599\u593E\u3002"}</p>
      )}
    </SectionCard>
  );
}
