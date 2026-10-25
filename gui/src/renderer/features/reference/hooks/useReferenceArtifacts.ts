import { useQuery } from "@tanstack/react-query";
import { useState, type Dispatch, type SetStateAction } from "react";
import { getJobArtifacts, type GuiArtifact } from "../../../api/jobs";
import { deleteDesktopPath, readJsonFile, writeJsonFile } from "../../../services/desktop_api";

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

type ReferenceArtifactsQuery = {
  artifacts: GuiArtifact[];
};

export type UseReferenceArtifactsResult = {
  artifactsQuery: ReturnType<typeof useQuery<ReferenceArtifactsQuery>>;
  previewArtifact: GuiArtifact | null;
  previewData: unknown;
  editorValue: string;
  previewStatus: string;
  setEditorValue: (value: string) => void;
  loadArtifact: (artifact: GuiArtifact) => Promise<void>;
  saveEditedArtifact: () => Promise<void>;
  deleteArtifact: () => Promise<void>;
  resetPreview: (status?: string) => void;
};

type PreviewSetters = {
  artifact: Dispatch<SetStateAction<GuiArtifact | null>>;
  data: Dispatch<SetStateAction<unknown>>;
  editor: Dispatch<SetStateAction<string>>;
  status: Dispatch<SetStateAction<string>>;
};

function clearPreview(setters: PreviewSetters, status: string) {
  setters.artifact(null);
  setters.data(null);
  setters.editor("");
  setters.status(status);
}

async function loadArtifactData(artifact: GuiArtifact, setters: PreviewSetters) {
  try {
    setters.artifact(artifact);
    setters.status("載入 Artifact 中...");
    const loaded = await readJsonFile(artifact.path);
    setters.data(loaded.data);
    setters.editor(formatJson(loaded.data));
    setters.status("Artifact 已載入。");
  } catch (error) {
    setters.data(null);
    setters.editor("");
    setters.status(error instanceof Error ? error.message : "載入 Artifact 失敗。");
  }
}

async function saveArtifactData(
  artifact: GuiArtifact | null,
  value: string,
  setters: PreviewSetters,
  refetch: () => Promise<unknown>,
) {
  if (!artifact) return;
  try {
    const parsed = JSON.parse(value);
    await writeJsonFile(artifact.path, parsed);
    setters.data(parsed);
    setters.status("Artifact 已儲存。");
    await refetch();
  } catch (error) {
    setters.status(error instanceof Error ? error.message : "儲存 Artifact 失敗。");
  }
}

async function deleteArtifactData(
  artifact: GuiArtifact | null,
  setters: PreviewSetters,
  refetch: () => Promise<unknown>,
) {
  if (!artifact) return;
  try {
    await deleteDesktopPath(artifact.path);
    clearPreview(setters, "Artifact 已刪除。");
    await refetch();
  } catch (error) {
    setters.status(error instanceof Error ? error.message : "刪除 Artifact 失敗。");
  }
}

function useArtifactPreview() {
  const [previewArtifact, setPreviewArtifact] = useState<GuiArtifact | null>(null);
  const [previewData, setPreviewData] = useState<unknown>(null);
  const [editorValue, setEditorValue] = useState("");
  const [previewStatus, setPreviewStatus] = useState("請先選擇要預覽的 Artifact。");
  const setters = {
    artifact: setPreviewArtifact,
    data: setPreviewData,
    editor: setEditorValue,
    status: setPreviewStatus,
  };
  return { previewArtifact, previewData, editorValue, previewStatus, setEditorValue, setters };
}

export function useReferenceArtifacts(selectedReferenceJobId: string | null): UseReferenceArtifactsResult {
  const preview = useArtifactPreview();
  const artifactsQuery = useQuery<ReferenceArtifactsQuery>({
    queryKey: ["reference-artifacts", selectedReferenceJobId],
    queryFn: () => getJobArtifacts(selectedReferenceJobId as string),
    enabled: Boolean(selectedReferenceJobId),
  });
  const resetPreview = (status = "請先選擇要預覽的 Artifact。"): void => clearPreview(preview.setters, status);
  const loadArtifact = (artifact: GuiArtifact) => loadArtifactData(artifact, preview.setters);
  const saveEditedArtifact = () => saveArtifactData(
    preview.previewArtifact, preview.editorValue, preview.setters, artifactsQuery.refetch,
  );
  const deleteArtifact = () => deleteArtifactData(preview.previewArtifact, preview.setters, artifactsQuery.refetch);
  return {
    artifactsQuery,
    ...preview,
    loadArtifact,
    saveEditedArtifact,
    deleteArtifact,
    resetPreview,
  };
}
