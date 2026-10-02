export type GuiSettings = {
  schemaVersion: 4;
  updatedAt: string;
  locale: "zh-TW" | "en-US";
  backendBaseUrl: string;
  koharuExecutablePath: string;
  koharuAutoStart: boolean;
  sourceFolder: string;
  outputFolder: string;
  referenceFolder: string;
  lastPickedSourceFolder: string;
  lastSelectedPage: string;
  lastSelectedJobId: string | null;
  lastSelectedMangaId: string | null;
};

export type DesktopInfo = {
  shellPaths: {
    userData: string;
    downloads: string;
    documents: string;
  };
  settingsFilePath: string;
  backendProcess: {
    mode: string;
    deploymentMode: string;
    fallbackUsed: boolean;
    baseUrl: string;
    status: string;
    note: string;
  };
  koharuProcess: KoharuHostProcessState;
};

export type KoharuHostProcessState = {
  mode: "external" | "managed";
  status: "checking" | "downloading" | "running" | "stopped" | "unavailable" | "failed";
  baseUrl: string;
  executablePath: string | null;
  pid: number | null;
  note: string;
};

export type PathValidationResult = {
  ok: boolean;
  exists: boolean;
  writable: boolean;
  reason: string;
};

export type PathValidationSummary = {
  sourceFolder: PathValidationResult;
  outputFolder: PathValidationResult;
  referenceFolder: PathValidationResult;
};

export type SourcePreflightImage = {
  id: string;
  fileName: string;
  sourcePath: string;
  normalizedPath: string;
  orderedName: string;
  orderedPath: string;
  previewPath: string;
  actualFormat: string;
  converted: boolean;
  convertedFrom: string | null;
  orderIndex: number;
};

export type SourcePreflightRejectedFile = {
  fileName: string;
  path: string;
  reason: string;
};

export type SourcePreflightResult = {
  preflightId: string;
  sourceFolder: string;
  createdAt: string;
  updatedAt: string;
  preflightRoot: string;
  normalizedDir: string;
  orderedDir: string;
  manifestPath: string;
  ready: boolean;
  orderChanged: boolean;
  originalFingerprint: string;
  currentFingerprint: string;
  summary: {
    discoveredCount: number;
    acceptedCount: number;
    convertedCount: number;
    rejectedCount: number;
  };
  discoveredFiles: Array<{
    fileName: string;
    path: string;
    accepted: boolean;
    converted: boolean;
    reason: string;
  }>;
  rejectedFiles: SourcePreflightRejectedFile[];
  images: SourcePreflightImage[];
};
