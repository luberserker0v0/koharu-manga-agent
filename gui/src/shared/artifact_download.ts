export type ArtifactDownloadRequest = {
  jobId: string;
  artifactId: number;
};

export type ArtifactDownloadResult = {
  path: string;
  fileName: string;
  size: number;
};
