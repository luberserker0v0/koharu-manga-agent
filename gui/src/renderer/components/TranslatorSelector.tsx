import type { TranslatorProfileSummary } from "../api/jobs";

export const CREATE_NEW_TRANSLATOR_VALUE = "__create_new_translator__";

export function resolveSelectedTranslator(
  selectedValue: string,
  options: TranslatorProfileSummary[],
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

function TranslatorOptions({ options }: Pick<TranslatorSelectorProps, "options">) {
  return options.map((entry) => (
    <option key={entry.translatorId} value={entry.translatorId}>
      {entry.label}
    </option>
  ));
}

export function TranslatorSelector(props: TranslatorSelectorProps) {
  const { label, helpText, selectedValue, newTranslatorLabel, options } = props;
  const { loading = false, failed = false, disabled = false } = props;
  const emptyText = loading ? props.loadingLabel : failed ? props.failedLabel : props.emptyLabel;
  return (
    <label>
      <span>{label}</span>
      {helpText ? <small className="muted-text">{helpText}</small> : null}
      <div className="inline-field-row">
        <select
          value={selectedValue}
          onChange={(event) => props.onSelectionChange(event.currentTarget.value)}
          disabled={disabled}
        >
          <option value="">{emptyText}</option>
          <TranslatorOptions options={options} />
          <option value={CREATE_NEW_TRANSLATOR_VALUE}>{props.createLabel}</option>
        </select>
        {selectedValue === CREATE_NEW_TRANSLATOR_VALUE ? (
          <input
            placeholder={props.inputPlaceholder}
            value={newTranslatorLabel}
            onChange={(event) => props.onNewTranslatorLabelChange(event.currentTarget.value)}
          />
        ) : null}
      </div>
    </label>
  );
}
