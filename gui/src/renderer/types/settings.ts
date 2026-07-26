export type GuiSettings = {
  schemaVersion: 1;
  updatedAt: string;
  locale: "zh-TW" | "en-US";
  sourceFolder: string;
  outputFolder: string;
  referenceFolder: string;
  lastPickedSourceFolder: string;
  lastSelectedPage: string;
  lastSelectedJobId: string | null;
  lastSelectedMangaId: string | null;
  agent: {
    provider: "opencode";
    runtimeMode: "managed" | "external";
    baseUrl: string;
    commandDir: string;
    moduleName: string;
    exportName: string;
    timeoutMs: number;
  };
  quality: {
    enabled: boolean;
    modelId: string;
    serverUrl: string;
  };
  translation: {
    modelId: string;
    serverUrl: string;
    providerId: string;
  };
  koharu: {
    baseUrl: string;
  };
  engines: Record<string, string>;
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
    status: string;
    note: string;
  };
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
