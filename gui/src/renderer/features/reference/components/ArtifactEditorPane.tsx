import { SectionCard } from "../../shared/components/SectionCard";
import type { GuiArtifact } from "../../../api/jobs";

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

type ArtifactEditorPaneProps = {
  selectedReferenceJobId: string | null;
  artifactsLoading: boolean;
  artifacts: GuiArtifact[];
  previewArtifact: GuiArtifact | null;
  previewData: unknown;
  previewStatus: string;
  editorValue: string;
  setEditorValue: (value: string) => void;
  loadArtifact: (artifact: GuiArtifact) => Promise<void>;
  saveEditedArtifact: () => Promise<void>;
  deleteArtifact: () => Promise<void>;
  openArtifactPath: (path: string) => void;
  prettyArtifactKind: (kind: string) => string;
  isEditableArtifact: (kind: string) => boolean;
};

export function ArtifactEditorPane({
  selectedReferenceJobId,
  artifactsLoading,
  artifacts,
  previewArtifact,
  previewData,
  previewStatus,
  editorValue,
  setEditorValue,
  loadArtifact,
  saveEditedArtifact,
  deleteArtifact,
  openArtifactPath,
  prettyArtifactKind,
  isEditableArtifact,
}: ArtifactEditorPaneProps) {
  return (
    <SectionCard
      title={"Artifact \u7DE8\u8F2F\u5668"}
      description={"\u6AA2\u8996\u6216\u7DE8\u8F2F\u76EE\u524D Reference Job \u7522\u751F\u7684 Artifacts\u3002"}
      defaultOpen={Boolean(previewArtifact)}
    >
      {selectedReferenceJobId && artifactsLoading ? <p>{"\u8F09\u5165 Artifacts \u4E2D..."}</p> : null}
      {!selectedReferenceJobId ? (
        <p className="muted-text">{"\u8ACB\u5148\u9078\u64C7\u4E00\u500B Reference Job \u4F86\u6AA2\u8996 Artifacts\u3002"}</p>
      ) : null}
      {artifacts.length > 0 ? (
        <ul className="artifact-list">
          {artifacts.map((artifact) => (
            <li key={artifact.id} className="artifact-item">
              <div>
                <strong>{prettyArtifactKind(artifact.kind)}</strong>
                <div className="job-subtext">{artifact.path}</div>
              </div>
              <div className="job-actions">
                <button className="secondary-button" onClick={() => void loadArtifact(artifact)} type="button">
                  {"\u9810\u89BD"}
                </button>
                <button className="secondary-button" onClick={() => openArtifactPath(artifact.path)} type="button">
                  {"\u6253\u958B"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : selectedReferenceJobId && !artifactsLoading ? (
        <p>{"\u9019\u500B Job \u76EE\u524D\u6C92\u6709 Artifacts\u3002"}</p>
      ) : null}
      <p className="muted-text">{previewStatus}</p>
      {previewArtifact ? (
        <>
          <div className="summary-grid">
            <div>
              <strong>Artifact</strong>
              <span>{prettyArtifactKind(previewArtifact.kind)}</span>
            </div>
            <div>
              <strong>{"\u8DEF\u5F91"}</strong>
              <span>{previewArtifact.path}</span>
            </div>
          </div>
          {isEditableArtifact(previewArtifact.kind) ? (
            <>
              <textarea
                rows={20}
                value={editorValue}
                onChange={(event) => setEditorValue(event.currentTarget.value)}
              />
              <div className="button-row">
                <button className="primary-button" onClick={() => void saveEditedArtifact()} type="button">
                  {"\u5132\u5B58 JSON"}
                </button>
                <button className="secondary-button" onClick={() => void deleteArtifact()} type="button">
                  {"\u522A\u9664 Artifact"}
                </button>
                <button
                  className="secondary-button"
                  onClick={() => openArtifactPath(previewArtifact.path)}
                  type="button"
                >
                  {"\u6253\u958B\u6240\u5728\u8CC7\u6599\u593E"}
                </button>
              </div>
            </>
          ) : (
            <pre>{previewData ? formatJson(previewData) : ""}</pre>
          )}
        </>
      ) : (
        <p>{"\u9078\u64C7 Extraction \u6216 Ingestion \u7522\u751F\u7684 Artifact \u5F8C\uFF0C\u6703\u5728\u9019\u88E1\u986F\u793A\u5167\u5BB9\u3002"}</p>
      )}
    </SectionCard>
  );
}
