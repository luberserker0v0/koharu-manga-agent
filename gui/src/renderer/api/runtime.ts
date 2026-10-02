import { apiFetch, buildApiUrl } from "./client";

export type BackendReadiness = {
  ok: boolean;
  status: "ready" | "degraded" | "blocked";
  checkedAt: string;
  deploymentMode: string;
  services: {
    backend: { required: true; ready: boolean; status: string };
    koharu: { required: true; ready: boolean; status: string; mode: string; baseUrl: string | null };
    ao: { required: false; ready: boolean; status: string; baseUrl: string | null };
  };
  capabilities: { koharuJobs: boolean; aoJobs: boolean };
  blockers: Array<{ service: string; code: string; message: string }>;
  warnings: Array<{ service: string; code: string; message: string }>;
};

export type RuntimeStatus = {
  backend: {
    status: string;
    host: string;
    port: number;
    deploymentMode: string;
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
    baseUrl?: string | null;
    model?: string | null;
    agentName?: string | null;
    lastError?: string | null;
    provider?: string | null;
    runtime?: unknown;
  };
  quality: {
    enabled: boolean;
    modelId: string | null;
    serverUrl: string | null;
  };
  translation: {
    defaultTarget: TranslationTarget | null;
  };
};

export type TranslationTarget = {
  providerId: string;
  modelId: string;
};

export type BackendConfig = {
  api?: {
    baseUrl?: string;
  };
  translation?: {
    defaultTarget?: TranslationTarget;
    machineTranslation?: {
      referencePostEdit?: boolean;
      learningPostEdit?: boolean;
    };
  };
  workflow?: {
    qualityCheck?: {
      enabled?: boolean;
    };
  };
  agent?: {
    baseUrl?: string;
    apiKey?: string | null;
    model?: string;
    agentName?: string | null;
    startTimeoutMs?: number;
    readyPollIntervalMs?: number;
    readyTimeoutMs?: number;
    messageTimeoutMs?: number;
    modelSilenceTimeoutMs?: number;
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

export type AOModelOption = {
  id: string;
  providerId: string;
  providerName: string;
  modelId: string;
  name: string;
};

export type AOProviderCatalog = {
  baseUrl: string;
  models: AOModelOption[];
  providers: Array<{ id: string; name: string }>;
  defaults: Record<string, string>;
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

export type KoharuTranslationModel = {
  modelId: string;
  name: string;
  languages: string[];
  targetKind: "local" | "provider";
  providerId: string;
};

export type KoharuTranslationProvider = {
  providerId: string;
  name: string;
  kind: "local_llm" | "hosted_llm" | "machine_translation";
  status: string;
  hasCredential: boolean | null;
  requiresCredential?: boolean;
  models: KoharuTranslationModel[];
  error?: string | null;
};

export type KoharuTranslationCatalog = {
  baseUrl: string;
  defaultTarget: TranslationTarget | null;
  providers: KoharuTranslationProvider[];
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
  hostAccessible: boolean;
  exists: Record<string, boolean>;
  projectSamples: Array<{
    id: string | null;
    name: string | null;
    path: string | null;
    updatedAtMs: number | null;
  }>;
  projectApiError: string | null;
};

export type BackendStoragePaths = {
  dataRoot: string;
  configPath: string;
  databasePath: string;
  translatedRoot: string;
  referencesRoot: string;
  hostAccessible: boolean;
};

export function getRuntimeStatus(): Promise<RuntimeStatus> {
  return apiFetch("/runtime/status");
}

export async function getBackendReadiness(): Promise<BackendReadiness> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(buildApiUrl("/ready"), { signal: controller.signal });
    const payload = await response.json() as BackendReadiness & { error?: string };
    if (response.status !== 200 && response.status !== 503) {
      throw new Error(payload.error || `Readiness request failed: ${response.status}`);
    }
    return payload;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export function getBackendConfig(): Promise<BackendConfig> {
  return apiFetch("/config");
}

export function updateBackendConfig(config: BackendConfig): Promise<BackendConfig> {
  return apiFetch("/config", { method: "PATCH", body: JSON.stringify(config) });
}

export function resetBackendConfig(): Promise<BackendConfig> {
  return apiFetch("/config/reset", { method: "POST" });
}

export function testAOConnection(baseUrl: string, apiKey: string | null): Promise<{ available: boolean; baseUrl: string }> {
  return apiFetch("/runtime/ao/connect", { method: "POST", body: JSON.stringify({ baseUrl, apiKey }), timeoutMs: 10000 });
}

export function getAOProviderCatalog(baseUrl: string, apiKey: string | null): Promise<AOProviderCatalog> {
  return apiFetch("/runtime/ao/providers", { method: "POST", body: JSON.stringify({ baseUrl, apiKey }), timeoutMs: 60000 });
}

export function getKoharuEngineCatalog(): Promise<{ engines: KoharuEngineCatalog }> {
  return apiFetch("/runtime/koharu/engines", { timeoutMs: 30000 });
}

export function getKoharuTranslationCatalog(): Promise<KoharuTranslationCatalog> {
  return apiFetch("/runtime/koharu/translation-providers", { timeoutMs: 30000 });
}

export function getKoharuRuntimePaths(): Promise<{
  backend: BackendStoragePaths;
  koharu: KoharuRuntimePaths;
}> {
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
