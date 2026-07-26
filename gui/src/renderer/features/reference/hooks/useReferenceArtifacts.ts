import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
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

export function useReferenceArtifacts(selectedReferenceJobId: string | null): UseReferenceArtifactsResult {
  const [previewArtifact, setPreviewArtifact] = useState<GuiArtifact | null>(null);
  const [previewData, setPreviewData] = useState<unknown>(null);
  const [editorValue, setEditorValue] = useState("");
  const [previewStatus, setPreviewStatus] = useState("請先選擇要預覽的 Artifact。");

  const artifactsQuery = useQuery<ReferenceArtifactsQuery>({
    queryKey: ["reference-artifacts", selectedReferenceJobId],
    queryFn: () => getJobArtifacts(selectedReferenceJobId as string),
    enabled: Boolean(selectedReferenceJobId),
  });

  const resetPreview = (status = "請先選擇要預覽的 Artifact。") => {
    setPreviewArtifact(null);
    setPreviewData(null);
    setEditorValue("");
    setPreviewStatus(status);
  };

  const loadArtifact = async (artifact: GuiArtifact) => {
    try {
      setPreviewArtifact(artifact);
      setPreviewStatus("載入 Artifact 中...");
      const loaded = await readJsonFile(artifact.path);
      setPreviewData(loaded.data);
      setEditorValue(formatJson(loaded.data));
      setPreviewStatus("Artifact 已載入。");
    } catch (error) {
      setPreviewData(null);
      setEditorValue("");
      setPreviewStatus(error instanceof Error ? error.message : "載入 Artifact 失敗。");
    }
  };

  const saveEditedArtifact = async () => {
    if (!previewArtifact) {
      return;
    }
    try {
      const parsed = JSON.parse(editorValue);
      await writeJsonFile(previewArtifact.path, parsed);
      setPreviewData(parsed);
      setPreviewStatus("Artifact 已儲存。");
      await artifactsQuery.refetch();
    } catch (error) {
      setPreviewStatus(error instanceof Error ? error.message : "儲存 Artifact 失敗。");
    }
  };

  const deleteArtifact = async () => {
    if (!previewArtifact) {
      return;
    }
    try {
      await deleteDesktopPath(previewArtifact.path);
      resetPreview("Artifact 已刪除。");
      await artifactsQuery.refetch();
    } catch (error) {
      setPreviewStatus(error instanceof Error ? error.message : "刪除 Artifact 失敗。");
    }
  };

  return {
    artifactsQuery,
    previewArtifact,
    previewData,
    editorValue,
    previewStatus,
    setEditorValue,
    loadArtifact,
    saveEditedArtifact,
    deleteArtifact,
    resetPreview,
  };
}
