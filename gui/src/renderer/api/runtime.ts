import { apiFetch } from "./client";

export type RuntimeStatus = {
  backend: {
    status: string;
    host: string;
    port: number;
  };
  koharu: {
    status: string;
    mode: string;
    baseUrl: string | null;
    version: string | null;
    port?: number | null;
    preferredPort?: number | null;
    installed: boolean;
    managedPid: number | null;
    lastError: string | null;
    executablePath?: string | null;
    installRoot?: string | null;
    supported?: boolean;
  };
  agent: {
    status: string;
    provider: string | null;
    runtime: unknown;
  };
  quality: {
    enabled: boolean;
    modelId: string | null;
    serverUrl: string | null;
  };
  translation: {
    modelId: string | null;
    serverUrl: string | null;
    providerId: string | null;
    defaultModel: string | null;
    defaultProvider: string | null;
  };
};

export type BackendConfig = {
  api?: {
    baseUrl?: string;
  };
  llm?: {
    defaultModel?: string;
    defaultProvider?: string;
  };
  workflow?: {
    qualityCheck?: {
      enabled?: boolean;
    };
  };
  translation?: {
    modelId?: string;
    serverUrl?: string;
    providerId?: string;
  };
  quality?: {
    modelId?: string;
    serverUrl?: string;
  };
  agent?: {
    provider?: string;
    opencode?: {
      moduleName?: string;
      exportName?: string | null;
      runtime?: {
        mode?: "managed" | "external";
        baseUrl?: string | null;
        commandDir?: string;
        timeoutMs?: number;
      };
    };
  };
  engines?: Record<string, string> | null;
  koharuRuntime?: {
    managed?: boolean;
    version?: string;
    repository?: string;
    installRoot?: string;
    host?: string;
    port?: number;
  };
};

export type KoharuEngineOption = {
  id: string;
  name?: string;
  produces?: string[];
};

export type KoharuEngineCatalog = {
  detectors?: KoharuEngineOption[];
  fontDetectors?: KoharuEngineOption[];
  segmenters?: KoharuEngineOption[];
  bubbleSegmenters?: KoharuEngineOption[];
  ocr?: KoharuEngineOption[];
  translators?: KoharuEngineOption[];
  inpainters?: KoharuEngineOption[];
  renderers?: KoharuEngineOption[];
};

export type KoharuRuntimePaths = {
  dataRoot: string | null;
  projectsRoot: string | null;
  modelsRoot: string | null;
  runtimeRoot: string | null;
  fontsRoot: string | null;
  configPath: string | null;
  executablePath: string | null;
  managedInstallRoot: string | null;
  versionDir: string | null;
  baseUrl: string | null;
  exists: Record<string, boolean>;
  projectSamples: Array<{
    id: string | null;
    name: string | null;
    path: string | null;
    updatedAtMs: number | null;
  }>;
  projectApiError: string | null;
};

export function getRuntimeStatus(): Promise<RuntimeStatus> {
  return apiFetch("/runtime/status");
}

export function getBackendConfig(): Promise<BackendConfig> {
  return apiFetch("/config");
}

export function getKoharuEngineCatalog(): Promise<{ engines: KoharuEngineCatalog }> {
  return apiFetch("/runtime/koharu/engines", { timeoutMs: 30000 });
}

export function getKoharuRuntimePaths(): Promise<{ koharu: KoharuRuntimePaths }> {
  return apiFetch("/runtime/koharu/paths", { timeoutMs: 30000 });
}

export function startKoharuRuntime(): Promise<{ koharu: RuntimeStatus["koharu"] }> {
  return apiFetch("/runtime/koharu/start", { method: "POST", timeoutMs: 60000 });
}

export function prepareKoharuRuntime(): Promise<{ koharu: RuntimeStatus["koharu"] }> {
  return apiFetch("/runtime/koharu/prepare", { method: "POST", timeoutMs: 600000 });
}

export function stopKoharuRuntime(): Promise<{ koharu: RuntimeStatus["koharu"] }> {
  return apiFetch("/runtime/koharu/stop", { method: "POST", timeoutMs: 30000 });
}
