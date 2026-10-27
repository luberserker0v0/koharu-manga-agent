import type { TextRegionGeometry } from "../../api/jobs";
import type { TextRegionCorrectionController } from "./useTextRegionCorrection";

type Translate = (key: string, params?: Record<string, string | number>) => string;
type GeometryField = keyof TextRegionGeometry;

const GEOMETRY_FIELDS: GeometryField[] = ["x", "y", "width", "height", "rotation"];

function GeometryInput(props: {
  field: GeometryField;
  correction: TextRegionCorrectionController;
  t: Translate;
}) {
  return (
    <label>
      <span>{props.t(`postEdit.correction.geometry.${props.field}`)}</span>
      <input
        type="number"
        step="any"
        value={props.correction.draft?.geometry[props.field] || ""}
        onChange={(event) => props.correction.updateGeometry(props.field, event.currentTarget.value)}
      />
    </label>
  );
}

function CorrectionForm(props: { correction: TextRegionCorrectionController; t: Translate }) {
  const { correction, t } = props;
  return (
    <div className="text-region-correction-form">
      <label>
        <span>{t("postEdit.correction.sourceText")}</span>
        <textarea
          rows={3}
          value={correction.draft?.sourceText || ""}
          onChange={(event) => correction.updateSourceText(event.currentTarget.value)}
        />
      </label>
      <div className="text-region-correction-geometry">
        {GEOMETRY_FIELDS.map((field) => (
          <GeometryInput key={field} field={field} correction={correction} t={t} />
        ))}
      </div>
      <p className="muted-text">{t("postEdit.correction.note")}</p>
      <button
        className="primary-button"
        type="button"
        disabled={!correction.valid || !correction.changed || correction.mutation.isPending}
        onClick={correction.submit}
      >
        {t(correction.mutation.isPending ? "postEdit.correction.submitting" : "postEdit.correction.submit")}
      </button>
    </div>
  );
}

export function TextRegionCorrectionEditor(props: {
  correction: TextRegionCorrectionController;
  t: Translate;
}) {
  const { correction, t } = props;
  if (correction.query.isPending) return <p className="muted-text">{t("postEdit.correction.loading")}</p>;
  if (!correction.context || !correction.draft) {
    return <p className="muted-text">{t("postEdit.correction.unavailable")}</p>;
  }
  return (
    <section className="text-region-correction-editor">
      <h3>{t("postEdit.correction.title")}</h3>
      <CorrectionForm correction={correction} t={t} />
    </section>
  );
}
