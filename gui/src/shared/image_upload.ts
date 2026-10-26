export type ImageUploadKind = "source" | "reference";

export type ImageUploadFile = {
  fileName: string;
  size: number;
  uploadedAt: string;
};

export type ImageUploadResult = {
  uploadId: string;
  kind: ImageUploadKind;
  status: "uploading" | "ready";
  files: ImageUploadFile[];
  createdAt: string;
  updatedAt: string;
};

export type ImageFolderUploadRequest = {
  sourceFolder: string;
  kind: ImageUploadKind;
};
