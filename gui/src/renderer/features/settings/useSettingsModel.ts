import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import {
  getAOProviderCatalog, getBackendConfig, getKoharuEngineCatalog, getKoharuRuntimePaths,
  getKoharuTranslationCatalog, getRuntimeStatus, prepareKoharuRuntime, resetBackendConfig,
  startKoharuRuntime, stopKoharuRuntime, testAOConnection, updateBackendConfig,
  type AOModelOption, type BackendConfig,
} from "../../api/runtime";
import {
  getDesktopInfo, installAndStartKoharuHost, openDesktopPath, pickDirectory, pickFile,
  readSettings, startKoharuHost, stopKoharuHost, validatePaths, writeSettings,
} from "../../services/desktop_api";
import { useLanguageStore } from "../../stores/language_store";
import type { DesktopInfo, GuiSettings, PathValidationSummary } from "../../types/settings";

export const TIMEOUT_KEYS = [
  "startTimeoutMs", "readyPollIntervalMs", "readyTimeoutMs", "messageTimeoutMs", "modelSilenceTimeoutMs",
] as const;
export type TimeoutKey = (typeof TIMEOUT_KEYS)[number];
export type Translate = (key: string, params?: Record<string, string | number>) => string;
type LocalKey = "locale" | "backendBaseUrl" | "koharuExecutablePath" | "outputFolder" | "referenceFolder";
type KoharuAction = "start" | "install" | "prepare" | "stop";

function buildAgentPatch(config: BackendConfig) {
  return { baseUrl: config.agent?.baseUrl || "", model: config.agent?.model || "",
    apiKey: config.agent?.apiKey || null, agentName: config.agent?.agentName || null,
    ...Object.fromEntries(TIMEOUT_KEYS.filter((key) => config.agent?.[key] != null)
      .map((key) => [key, config.agent?.[key]])) };
}

function buildConfigPatch(config: BackendConfig): BackendConfig {
  return {
    api: { baseUrl: config.api?.baseUrl || "" },
    translation: { defaultTarget: { modelId: config.translation?.defaultTarget?.modelId || "",
      providerId: config.translation?.defaultTarget?.providerId || "" }, machineTranslation: {
      referencePostEdit: config.translation?.machineTranslation?.referencePostEdit !== false,
      learningPostEdit: config.translation?.machineTranslation?.learningPostEdit !== false } },
    workflow: { qualityCheck: { enabled: config.workflow?.qualityCheck?.enabled !== false } },
    agent: buildAgentPatch(config),
    engines: Object.fromEntries(Object.entries(config.engines || {}).filter(([, value]) => Boolean(value))),
    defaults: { trashRetentionDays: config.defaults?.trashRetentionDays,
      logRetentionDays: config.defaults?.logRetentionDays, logMaxFiles: config.defaults?.logMaxFiles,
      translatedRetentionDays: config.defaults?.translatedRetentionDays,
      workspaceRetentionDays: config.defaults?.workspaceRetentionDays,
      postEditRetentionDays: config.defaults?.postEditRetentionDays },
    cleanup: { enabled: config.cleanup?.enabled, intervalMs: config.cleanup?.intervalMs },
  };
}

function useSettingsState(t: Translate) {
  const [settings, setSettings] = useState<GuiSettings | null>(null);
  const [savedSettings, setSavedSettings] = useState<GuiSettings | null>(null);
  const [config, setConfig] = useState<BackendConfig | null>(null);
  const [savedConfig, setSavedConfig] = useState<BackendConfig | null>(null);
  const [desktopInfo, setDesktopInfo] = useState<DesktopInfo | null>(null);
  const [pathValidation, setPathValidation] = useState<PathValidationSummary | null>(null);
  const [status, setStatus] = useState(t("settings.status.loading"));
  const [koharuAction, setKoharuAction] = useState<KoharuAction | null>(null);
  const [aoModels, setAoModels] = useState<AOModelOption[]>([]);
  const [aoAction, setAoAction] = useState<"connect" | "refresh" | null>(null);
  const [saving, setSaving] = useState(false);
  return { settings, setSettings, savedSettings, setSavedSettings, config, setConfig, savedConfig,
    setSavedConfig, desktopInfo, setDesktopInfo, pathValidation, setPathValidation, status, setStatus,
    koharuAction, setKoharuAction, aoModels, setAoModels, aoAction, setAoAction, saving, setSaving };
}

function useSettingsQueries() {
  const runtimeQuery = useQuery({ queryKey: ["runtime-status"], queryFn: getRuntimeStatus, retry: false });
  const configQuery = useQuery({ queryKey: ["backend-config"], queryFn: getBackendConfig, retry: false });
  const catalogQuery = useQuery({ queryKey: ["koharu-engine-catalog"], queryFn: getKoharuEngineCatalog, retry: false });
  const translationCatalogQuery = useQuery({ queryKey: ["koharu-translation-catalog"],
    queryFn: getKoharuTranslationCatalog, retry: false });
  const pathsQuery = useQuery({ queryKey: ["koharu-runtime-paths"], queryFn: getKoharuRuntimePaths, retry: false });
  return { runtimeQuery, configQuery, catalogQuery, translationCatalogQuery, pathsQuery };
}

type SettingsState = ReturnType<typeof useSettingsState>;
type SettingsQueries = ReturnType<typeof useSettingsQueries>;

async function validateLocalPaths(settings: GuiSettings) {
  return validatePaths({ sourceFolder: "", outputFolder: settings.outputFolder,
    referenceFolder: settings.referenceFolder, sourceRequired: false });
}

function applyLoadedSettings(
  state: SettingsState,
  local: GuiSettings,
  desktop: DesktopInfo,
  setLocale: (locale: GuiSettings["locale"]) => void,
) {
  state.setSettings(local);
  state.setSavedSettings(local);
  state.setDesktopInfo(desktop);
  setLocale(local.locale);
}

async function loadSettings(state: SettingsState, setLocale: (locale: GuiSettings["locale"]) => void,
  t: Translate, isActive: () => boolean) {
  const [local, desktop, backend] = await Promise.allSettled([readSettings(), getDesktopInfo(), getBackendConfig()]);
  if (!isActive()) return;
  if (local.status !== "fulfilled" || desktop.status !== "fulfilled") {
    state.setStatus(t("settings.status.loadFailed"));
    return;
  }
  applyLoadedSettings(state, local.value, desktop.value, setLocale);
  if (backend.status === "fulfilled") {
    state.setConfig(backend.value);
    state.setSavedConfig(backend.value);
    state.setStatus(t("settings.status.loaded"));
  } else {
    const reason = backend.reason instanceof Error ? backend.reason.message : String(backend.reason);
    state.setStatus(`${t("settings.status.loadFailed")}: ${reason}`);
  }
  try {
    const validation = await validateLocalPaths(local.value);
    if (isActive()) state.setPathValidation(validation);
  } catch { /* independent validation */ }
}

function useSettingsBootstrap(state: SettingsState, setLocale: (locale: GuiSettings["locale"]) => void, t: Translate) {
  useEffect(() => {
    let active = true;
    void loadSettings(state, setLocale, t, () => active);
    return () => { active = false; };
  }, [setLocale, t]);
}

function settingsAreDirty(state: SettingsState) {
  const localDirty = state.settings && state.savedSettings &&
    JSON.stringify(state.settings) !== JSON.stringify(state.savedSettings);
  const backendDirty = state.config && state.savedConfig &&
    JSON.stringify(buildConfigPatch(state.config)) !== JSON.stringify(buildConfigPatch(state.savedConfig));
  return Boolean(localDirty || backendDirty);
}

function useConfigQuerySync(state: SettingsState, queries: SettingsQueries, isDirty: boolean) {
  useEffect(() => {
    if (!queries.configQuery.data || isDirty) return;
    state.setConfig(queries.configQuery.data);
    state.setSavedConfig(queries.configQuery.data);
  }, [isDirty, queries.configQuery.data]);
}

function updateLocal(state: SettingsState, key: LocalKey, value: string) {
  state.setSettings((current) => current ? ({ ...current, [key]: value } as GuiSettings) : current);
}

function updateTranslationTarget(state: SettingsState, key: "modelId" | "providerId", value: string) {
  state.setConfig((current) => current ? { ...current, translation: { ...current.translation,
    defaultTarget: { modelId: current.translation?.defaultTarget?.modelId || "",
      providerId: current.translation?.defaultTarget?.providerId || "", [key]: value } } } : current);
}

function updateMaintenance(state: SettingsState, patch: BackendConfig) {
  state.setConfig((current) => current ? { ...current,
    defaults: patch.defaults ? { ...current.defaults, ...patch.defaults } : current.defaults,
    cleanup: patch.cleanup ? { ...current.cleanup, ...patch.cleanup } : current.cleanup } : current);
}

function createSettingsUpdates(state: SettingsState) {
  return {
    updateLocal: (key: LocalKey, value: string) => updateLocal(state, key, value),
    updateApi: (baseUrl: string) => state.setConfig((current) => current
      ? { ...current, api: { ...current.api, baseUrl } } : current),
    updateTranslationTarget: (key: "modelId" | "providerId", value: string) =>
      updateTranslationTarget(state, key, value),
    updateAgent: (key: "baseUrl" | "model" | "apiKey" | "agentName" | TimeoutKey, value: string | number) =>
      state.setConfig((current) => current ? { ...current, agent: { ...current.agent, [key]: value } } : current),
    updateMaintenance: (patch: BackendConfig) => updateMaintenance(state, patch),
    updateAutoStart: (koharuAutoStart: boolean) => state.setSettings((current) => current
      ? { ...current, koharuAutoStart } : current),
    updateQualityEnabled: (enabled: boolean) => state.setConfig((current) => current
      ? { ...current, workflow: { ...current.workflow, qualityCheck: { enabled } } } : current),
    updateEngine: (key: string, value: string) => state.setConfig((current) => current
      ? { ...current, engines: { ...current.engines, [key]: value } } : current),
  };
}

async function refreshSettings(queryClient: ReturnType<typeof useQueryClient>, state: SettingsState) {
  const keys = ["backend-config", "runtime-status", "koharu-engine-catalog",
    "koharu-translation-catalog", "koharu-runtime-paths"];
  await Promise.allSettled(keys.map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
  try { state.setDesktopInfo(await getDesktopInfo()); } catch { /* desktop bridge may be unavailable */ }
}

function validBackendUrl(value: string) {
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}

async function persistSettings(state: SettingsState, setLocale: (locale: GuiSettings["locale"]) => void) {
  if (!state.settings || !state.config) return false;
  const validation = await validateLocalPaths(state.settings);
  state.setPathValidation(validation);
  if (!validation.outputFolder.ok || !validation.referenceFolder.ok) return false;
  const effective = await updateBackendConfig(buildConfigPatch(state.config));
  state.setConfig(effective);
  state.setSavedConfig(effective);
  const local = await writeSettings(state.settings);
  state.setSettings(local);
  state.setSavedSettings(local);
  setLocale(local.locale);
  return true;
}

function resetLocalSettings(settings: GuiSettings, desktop: DesktopInfo | null) {
  return { ...settings, locale: "zh-TW" as const, backendBaseUrl: "http://127.0.0.1:4001",
    koharuExecutablePath: "", koharuAutoStart: false, sourceFolder: "",
    outputFolder: desktop?.shellPaths.downloads || settings.outputFolder,
    referenceFolder: "", lastPickedSourceFolder: "" };
}

async function resetSettings(state: SettingsState, setLocale: (locale: GuiSettings["locale"]) => void) {
  if (!state.settings) return;
  const effective = await resetBackendConfig();
  state.setConfig(effective);
  state.setSavedConfig(effective);
  const local = await writeSettings(resetLocalSettings(state.settings, state.desktopInfo));
  state.setSettings(local);
  state.setSavedSettings(local);
  setLocale(local.locale);
  state.setPathValidation(await validateLocalPaths(local));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function usePersistenceActions(state: SettingsState, refresh: () => Promise<void>,
  setLocale: (locale: GuiSettings["locale"]) => void, t: Translate) {
  const handleSave = async () => {
    if (!state.settings || !state.config) return;
    if (!validBackendUrl(state.settings.backendBaseUrl)) return state.setStatus(t("settings.backend.baseUrl.invalid"));
    state.setSaving(true);
    try {
      const saved = await persistSettings(state, setLocale);
      if (!saved) return state.setStatus(t("settings.status.validationFailed"));
      await refresh();
      state.setStatus(t("settings.status.saved"));
    } catch (error) { state.setStatus(`${t("settings.status.saveFailed")}: ${errorMessage(error)}`); }
    finally { state.setSaving(false); }
  };
  const handleReset = async () => {
    if (!state.settings || !window.confirm(t("settings.reset.confirm"))) return;
    state.setSaving(true);
    try { await resetSettings(state, setLocale); await refresh(); state.setStatus(t("settings.status.resetSaved")); }
    catch (error) { state.setStatus(`${t("settings.status.resetFailed")}: ${errorMessage(error)}`); }
    finally { state.setSaving(false); }
  };
  return { handleSave, handleReset };
}

function useDesktopActions(state: SettingsState, updates: ReturnType<typeof createSettingsUpdates>, t: Translate) {
  const chooseFolder = async (key: "outputFolder" | "referenceFolder", titleKey: string) => {
    try {
      const result = await pickDirectory({ title: t(titleKey),
        defaultPath: state.settings?.[key] || state.desktopInfo?.shellPaths.documents });
      if (!result.canceled && result.path) updates.updateLocal(key, result.path);
    } catch (error) { state.setStatus(`${t("settings.status.pickFolderFailed")}: ${errorMessage(error)}`); }
  };
  const chooseKoharuExecutable = async () => {
    try {
      const result = await pickFile({ title: t("settings.koharu.host.executable.dialogTitle"),
        defaultPath: state.settings?.koharuExecutablePath || undefined, extensions: ["exe"] });
      if (!result.canceled && result.path) {
        updates.updateLocal("koharuExecutablePath", result.path);
        updates.updateAutoStart(true);
      }
    } catch (error) { state.setStatus(`${t("settings.koharu.host.executable.pickFailed")}: ${errorMessage(error)}`); }
  };
  const openStoragePath = async (targetPath: string) => {
    try {
      const result = await openDesktopPath(targetPath);
      if (!result.ok) state.setStatus(`${t("settings.storage.openFailed")}: ${result.error || targetPath}`);
    } catch (error) { state.setStatus(`${t("settings.storage.openFailed")}: ${errorMessage(error)}`); }
  };
  return { chooseFolder, chooseKoharuExecutable, openStoragePath };
}

async function installConfiguredKoharu(state: SettingsState, t: Translate) {
  const processState = await installAndStartKoharuHost();
  if (!processState.executablePath) throw new Error(t("app.koharuRecovery.downloadMissingPath"));
  const saved = await writeSettings({ koharuExecutablePath: processState.executablePath, koharuAutoStart: true });
  state.setSettings((current) => current ? { ...current, koharuExecutablePath: processState.executablePath || "",
    koharuAutoStart: true, updatedAt: saved.updatedAt } : saved);
  state.setSavedSettings(saved);
  return processState;
}

async function stopConfiguredKoharu() {
  const results = await Promise.allSettled([stopKoharuHost(), stopKoharuRuntime()]);
  if (results.some((result) => result.status === "fulfilled")) return results;
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  throw rejected?.reason instanceof Error ? rejected.reason : new Error(String(rejected?.reason || ""));
}

function useKoharuActions(state: SettingsState, refresh: () => Promise<void>, t: Translate) {
  const runKoharuAction = async (action: KoharuAction, runner: () => Promise<unknown>) => {
    state.setKoharuAction(action);
    state.setStatus(t(`settings.koharu.status.${action}ing`));
    try { await runner(); await refresh(); state.setStatus(t(`settings.koharu.status.${action}ed`)); }
    catch (error) { state.setStatus(`${t(`settings.koharu.status.${action}Failed`)}: ${errorMessage(error)}`); }
    finally { state.setKoharuAction(null); }
  };
  const startConfigured = () => state.settings?.koharuExecutablePath.trim()
    ? startKoharuHost(state.settings.koharuExecutablePath) : startKoharuRuntime();
  return { runKoharuAction, startConfigured,
    installConfigured: () => installConfiguredKoharu(state, t), stopConfigured: stopConfiguredKoharu,
    prepareConfigured: prepareKoharuRuntime };
}

function useAoActions(state: SettingsState, queryClient: ReturnType<typeof useQueryClient>, t: Translate) {
  const connectAO = async () => {
    if (!state.config?.agent?.baseUrl) return;
    state.setAoAction("connect");
    try {
      const result = await testAOConnection(state.config.agent.baseUrl, state.config.agent.apiKey || null);
      state.setStatus(t("settings.ao.connection.success", { url: result.baseUrl }));
      await queryClient.invalidateQueries({ queryKey: ["runtime-status"] });
    } catch (error) { state.setStatus(`${t("settings.ao.connection.failed")}: ${errorMessage(error)}`); }
    finally { state.setAoAction(null); }
  };
  const refreshAOModels = async () => {
    if (!state.config?.agent?.baseUrl) return;
    state.setAoAction("refresh");
    try {
      const catalog = await getAOProviderCatalog(state.config.agent.baseUrl, state.config.agent.apiKey || null);
      state.setAoModels(catalog.models);
      state.setStatus(t("settings.ao.models.loaded", { count: catalog.models.length }));
    } catch (error) { state.setStatus(`${t("settings.ao.models.failed")}: ${errorMessage(error)}`); }
    finally { state.setAoAction(null); }
  };
  return { connectAO, refreshAOModels };
}

export function useSettingsModel() {
  const t = useLanguageStore((current) => current.t);
  const setLocale = useLanguageStore((current) => current.setLocale);
  const queryClient = useQueryClient();
  const state = useSettingsState(t);
  const queries = useSettingsQueries();
  const isDirty = settingsAreDirty(state);
  useSettingsBootstrap(state, setLocale, t);
  useConfigQuerySync(state, queries, isDirty);
  const updates = createSettingsUpdates(state);
  const refresh = () => refreshSettings(queryClient, state);
  const persistence = usePersistenceActions(state, refresh, setLocale, t);
  const desktop = useDesktopActions(state, updates, t);
  const koharu = useKoharuActions(state, refresh, t);
  const ao = useAoActions(state, queryClient, t);
  return { ...state, ...queries, ...updates, ...persistence, ...desktop, ...koharu, ...ao,
    t, isDirty };
}

export type SettingsModel = ReturnType<typeof useSettingsModel>;
