import { useLanguageStore } from "../stores/language_store";

export type ReferenceGlossaryStrategy = "canonical" | "reference_only" | "disabled";

type StrategyDefinition = {
  value: ReferenceGlossaryStrategy;
  label: string;
  description: string;
};

function buildStrategyDefinitions(t: (key: string) => string): StrategyDefinition[] {
  return [
    {
      value: "canonical",
      label: t("referenceGlossaryStrategy.canonical.label"),
      description: t("referenceGlossaryStrategy.canonical.description"),
    },
    {
      value: "reference_only",
      label: t("referenceGlossaryStrategy.referenceOnly.label"),
      description: t("referenceGlossaryStrategy.referenceOnly.description"),
    },
    {
      value: "disabled",
      label: t("referenceGlossaryStrategy.disabled.label"),
      description: t("referenceGlossaryStrategy.disabled.description"),
    },
  ];
}

export function ReferenceGlossaryStrategySelector({
  label,
  helpText,
  value,
  onChange,
}: {
  label: string;
  helpText?: string;
  value: ReferenceGlossaryStrategy;
  onChange: (value: ReferenceGlossaryStrategy) => void;
}) {
  const t = useLanguageStore((state) => state.t);
  const definitions = buildStrategyDefinitions(t);
  const selectedDefinition =
    definitions.find((definition) => definition.value === value) || definitions[0];

  return (
    <article className="compact-grid">
      <h3>{label}</h3>
      {helpText ? <p className="muted-text">{helpText}</p> : null}
      <div className="translation-mode-grid">
        {definitions.map((definition) => (
          <button
            key={definition.value}
            className={value === definition.value ? "translation-mode-card active" : "translation-mode-card"}
            onClick={() => onChange(definition.value)}
            type="button"
          >
            <strong>{definition.label}</strong>
            <span>{definition.description}</span>
          </button>
        ))}
      </div>
      <div className="artifact-summary-card">
        <strong>{selectedDefinition.label}</strong>
        <p className="muted-text">{selectedDefinition.description}</p>
      </div>
    </article>
  );
}
