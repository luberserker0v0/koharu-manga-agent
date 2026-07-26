import type { TranslatorProfileSummary } from "../api/jobs";

export const CREATE_NEW_TRANSLATOR_VALUE = "__create_new_translator__";

export function resolveSelectedTranslator(
  selectedValue: string,
  options: TranslatorProfileSummary[]
): TranslatorProfileSummary | null {
  return options.find((entry) => entry.translatorId === selectedValue) || null;
}

type TranslatorSelectorProps = {
  label: string;
  helpText?: string;
  selectedValue: string;
  newTranslatorLabel: string;
  options: TranslatorProfileSummary[];
  loading?: boolean;
  failed?: boolean;
  disabled?: boolean;
  emptyLabel: string;
  loadingLabel: string;
  failedLabel: string;
  createLabel: string;
  inputPlaceholder: string;
  onSelectionChange: (value: string) => void;
  onNewTranslatorLabelChange: (value: string) => void;
};

export function TranslatorSelector({
  label,
  helpText,
  selectedValue,
  newTranslatorLabel,
  options,
  loading = false,
  failed = false,
  disabled = false,
  emptyLabel,
  loadingLabel,
  failedLabel,
  createLabel,
  inputPlaceholder,
  onSelectionChange,
  onNewTranslatorLabelChange,
}: TranslatorSelectorProps) {
  return (
    <label>
      <span>{label}</span>
      {helpText ? <small className="muted-text">{helpText}</small> : null}
      <div className="inline-field-row">
        <select
          value={selectedValue}
          onChange={(event) => onSelectionChange(event.currentTarget.value)}
          disabled={disabled}
        >
          <option value="">{loading ? loadingLabel : failed ? failedLabel : emptyLabel}</option>
          {options.map((entry) => (
            <option key={entry.translatorId} value={entry.translatorId}>
              {entry.label}
            </option>
          ))}
          <option value={CREATE_NEW_TRANSLATOR_VALUE}>{createLabel}</option>
        </select>
        {selectedValue === CREATE_NEW_TRANSLATOR_VALUE ? (
          <input
            placeholder={inputPlaceholder}
            value={newTranslatorLabel}
            onChange={(event) => onNewTranslatorLabelChange(event.currentTarget.value)}
          />
        ) : null}
      </div>
    </label>
  );
}
