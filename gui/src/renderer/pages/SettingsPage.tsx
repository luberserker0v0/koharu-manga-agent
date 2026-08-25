import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import {
  getAOProviderCatalog, getBackendConfig, getKoharuEngineCatalog, getKoharuRuntimePaths, getRuntimeStatus,
  prepareKoharuRuntime, resetBackendConfig, startKoharuRuntime, stopKoharuRuntime,
  testAOConnection, updateBackendConfig, type AOModelOption, type BackendConfig, type KoharuEngineCatalog,
  type KoharuEngineOption, type RuntimeStatus,
} from "../api/runtime";
import { getDesktopInfo, pickDirectory, readSettings, validatePaths, writeSettings } from "../services/desktop_api";
import { useLanguageStore } from "../stores/language_store";
import type { DesktopInfo, GuiSettings, PathValidationSummary } from "../types/settings";

const ENGINE_KEYS = ["detect", "fontDetect", "segment", "bubbleSegment", "ocr", "translate", "clean", "render"] as const;
const TIMEOUT_KEYS = ["startTimeoutMs", "readyPollIntervalMs", "readyTimeoutMs", "messageTimeoutMs", "modelSilenceTimeoutMs"] as const;
type EngineKey = typeof ENGINE_KEYS[number];
type TimeoutKey = typeof TIMEOUT_KEYS[number];
const ENGINE_CATALOG_KEYS: Record<EngineKey, (keyof KoharuEngineCatalog)[]> = {
  detect: ["detectors"], fontDetect: ["fontDetectors", "detectors"],
  segment: ["segmenters", "detectors"], bubbleSegment: ["bubbleSegmenters", "detectors"],
  ocr: ["ocr"], translate: ["translators"], clean: ["inpainters"], render: ["renderers"],
};

function engineOptionsFor(catalog: KoharuEngineCatalog | undefined, key: EngineKey): KoharuEngineOption[] {
  const options = new Map<string, KoharuEngineOption>();
  for (const catalogKey of ENGINE_CATALOG_KEYS[key]) {
    for (const option of catalog?.[catalogKey] || []) {
      if (option?.id && !options.has(option.id)) options.set(option.id, option);
    }
  }
  return [...options.values()];
}

function Section({ title, description, children, defaultOpen = true }: {
  title: string; description: string; children: ReactNode; defaultOpen?: boolean;
}) {
  return (
    <details className="settings-section" open={defaultOpen}>
      <summary><div><strong>{title}</strong><div className="muted-text">{description}</div></div></summary>
      <div className="settings-section-body">{children}</div>
    </details>
  );
}

function buildConfigPatch(config: BackendConfig): BackendConfig {
  return {
    api: { baseUrl: config.api?.baseUrl || "" },
    llm: { defaultModel: config.llm?.defaultModel || "", defaultProvider: config.llm?.defaultProvider || "" },
    workflow: { qualityCheck: { enabled: config.workflow?.qualityCheck?.enabled !== false } },
    agent: {
      baseUrl: config.agent?.baseUrl || "", model: config.agent?.model || "",
      apiKey: config.agent?.apiKey || null, agentName: config.agent?.agentName || null,
      ...Object.fromEntries(TIMEOUT_KEYS.filter((key) => config.agent?.[key] != null).map((key) => [key, config.agent?.[key]])),
    },
    engines: Object.fromEntries(Object.entries(config.engines || {}).filter(([, value]) => Boolean(value))),
  };
}

export function SettingsPage() {
  const t = useLanguageStore((state) => state.t);
  const setLocale = useLanguageStore((state) => state.setLocale);
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState<GuiSettings | null>(null);
  const [savedSettings, setSavedSettings] = useState<GuiSettings | null>(null);
  const [config, setConfig] = useState<BackendConfig | null>(null);
  const [savedConfig, setSavedConfig] = useState<BackendConfig | null>(null);
  const [desktopInfo, setDesktopInfo] = useState<DesktopInfo | null>(null);
  const [pathValidation, setPathValidation] = useState<PathValidationSummary | null>(null);
  const [status, setStatus] = useState(t("settings.status.loading"));
  const [koharuAction, setKoharuAction] = useState<"start" | "prepare" | "stop" | null>(null);
  const [aoModels, setAoModels] = useState<AOModelOption[]>([]);
  const [aoAction, setAoAction] = useState<"connect" | "refresh" | null>(null);
  const [saving, setSaving] = useState(false);

  const runtimeQuery = useQuery({ queryKey: ["runtime-status"], queryFn: getRuntimeStatus, retry: false });
  const configQuery = useQuery({ queryKey: ["backend-config"], queryFn: getBackendConfig, retry: false });
  const catalogQuery = useQuery({ queryKey: ["koharu-engine-catalog"], queryFn: getKoharuEngineCatalog, retry: false });
  const pathsQuery = useQuery({ queryKey: ["koharu-runtime-paths"], queryFn: getKoharuRuntimePaths, retry: false });

  useEffect(() => {
    let active = true;
    Promise.allSettled([readSettings(), getDesktopInfo(), getBackendConfig()]).then(async (results) => {
      if (!active) return;
      const [local, desktop, backend] = results;
      if (local.status !== "fulfilled" || desktop.status !== "fulfilled") {
        setStatus(t("settings.status.loadFailed"));
        return;
      }
      setSettings(local.value);
      setSavedSettings(local.value);
      setDesktopInfo(desktop.value);
      setLocale(local.value.locale);
      if (backend.status === "fulfilled") {
        setConfig(backend.value);
        setSavedConfig(backend.value);
        setStatus(t("settings.status.loaded"));
      } else {
        setStatus(`${t("settings.status.loadFailed")}: ${backend.reason instanceof Error ? backend.reason.message : String(backend.reason)}`);
      }
      try {
        const validation = await validatePaths({ sourceFolder: "", outputFolder: local.value.outputFolder, referenceFolder: local.value.referenceFolder, sourceRequired: false });
        if (active) setPathValidation(validation);
      } catch { /* Folder validation is independent from loading persisted settings. */ }
    });
    return () => { active = false; };
  }, [setLocale, t]);

  const isDirty = Boolean(
    settings && savedSettings && JSON.stringify(settings) !== JSON.stringify(savedSettings)
    || config && savedConfig && JSON.stringify(buildConfigPatch(config)) !== JSON.stringify(buildConfigPatch(savedConfig))
  );

  useEffect(() => {
    if (configQuery.data && !isDirty) {
      setConfig(configQuery.data);
      setSavedConfig(configQuery.data);
    }
  }, [configQuery.data, isDirty]);

  const updateLocal = (key: "locale" | "outputFolder" | "referenceFolder", value: string) => {
    setSettings((current) => current ? { ...current, [key]: value } as GuiSettings : current);
  };
  const updateApi = (baseUrl: string) => setConfig((current) => current ? { ...current, api: { ...current.api, baseUrl } } : current);
  const updateLlm = (key: "defaultModel" | "defaultProvider", value: string) =>
    setConfig((current) => current ? { ...current, llm: { ...current.llm, [key]: value } } : current);
  const updateAgent = (key: "baseUrl" | "model" | "apiKey" | "agentName" | TimeoutKey, value: string | number) =>
    setConfig((current) => current ? { ...current, agent: { ...current.agent, [key]: value } } : current);

  const refresh = async () => {
    await Promise.allSettled([
      queryClient.invalidateQueries({ queryKey: ["backend-config"] }),
      queryClient.invalidateQueries({ queryKey: ["runtime-status"] }),
      queryClient.invalidateQueries({ queryKey: ["koharu-engine-catalog"] }),
      queryClient.invalidateQueries({ queryKey: ["koharu-runtime-paths"] }),
    ]);
  };

  const handleSave = async () => {
    if (!settings || !config) return;
    setSaving(true);
    try {
      const validation = await validatePaths({ sourceFolder: "", outputFolder: settings.outputFolder, referenceFolder: settings.referenceFolder, sourceRequired: false });
      setPathValidation(validation);
      if (!validation.outputFolder.ok || !validation.referenceFolder.ok) {
        setStatus(t("settings.status.validationFailed"));
        return;
      }
      const effective = await updateBackendConfig(buildConfigPatch(config));
      setConfig(effective);
      setSavedConfig(effective);
      const local = await writeSettings(settings);
      setSettings(local);
      setSavedSettings(local);
      setLocale(local.locale);
      await refresh();
      setStatus(t("settings.status.saved"));
    } catch (error) {
      setStatus(`${t("settings.status.saveFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setSaving(false); }
  };

  const handleReset = async () => {
    if (!settings || !window.confirm(t("settings.reset.confirm"))) return;
    setSaving(true);
    try {
      const effective = await resetBackendConfig();
      setConfig(effective);
      setSavedConfig(effective);
      const local = await writeSettings({ ...settings, locale: "zh-TW", sourceFolder: "", outputFolder: desktopInfo?.shellPaths.downloads || settings.outputFolder, referenceFolder: "", lastPickedSourceFolder: "" });
      setSettings(local);
      setSavedSettings(local);
      setLocale(local.locale);
      const validation = await validatePaths({ sourceFolder: "", outputFolder: local.outputFolder, referenceFolder: local.referenceFolder, sourceRequired: false });
      setPathValidation(validation);
      await refresh();
      setStatus(t("settings.status.resetSaved"));
    } catch (error) {
      setStatus(`${t("settings.status.resetFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setSaving(false); }
  };

  const chooseFolder = async (key: "outputFolder" | "referenceFolder", titleKey: string) => {
    try {
      const result = await pickDirectory({ title: t(titleKey), defaultPath: settings?.[key] || desktopInfo?.shellPaths.documents });
      if (!result.canceled && result.path) updateLocal(key, result.path);
    } catch (error) {
      setStatus(`${t("settings.status.pickFolderFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const runKoharuAction = async (action: "start" | "prepare" | "stop", runner: () => Promise<{ koharu: RuntimeStatus["koharu"] }>) => {
    setKoharuAction(action);
    setStatus(t(`settings.koharu.status.${action}ing`));
    try {
      await runner();
      await refresh();
      setStatus(t(`settings.koharu.status.${action}ed`));
    } catch (error) {
      setStatus(`${t(`settings.koharu.status.${action}Failed`)}: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setKoharuAction(null); }
  };

  const connectAO = async () => {
    if (!config?.agent?.baseUrl) return;
    setAoAction("connect");
    try {
      const result = await testAOConnection(config.agent.baseUrl, config.agent.apiKey || null);
      setStatus(t("settings.ao.connection.success", { url: result.baseUrl }));
      await queryClient.invalidateQueries({ queryKey: ["runtime-status"] });
    } catch (error) {
      setStatus(`${t("settings.ao.connection.failed")}: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setAoAction(null); }
  };

  const refreshAOModels = async () => {
    if (!config?.agent?.baseUrl) return;
    setAoAction("refresh");
    try {
      const catalog = await getAOProviderCatalog(config.agent.baseUrl, config.agent.apiKey || null);
      setAoModels(catalog.models);
      setStatus(t("settings.ao.models.loaded", { count: catalog.models.length }));
    } catch (error) {
      setStatus(`${t("settings.ao.models.failed")}: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setAoAction(null); }
  };

  const badge = (label: string, value: string, tone: "good" | "warn" | "bad" | "neutral") =>
    <div className={`status-badge status-${tone}`}><strong>{label}</strong><span>{value}</span></div>;
  const runtime = runtimeQuery.data;

  return (
    <section className="page">
      <h1>{t("settings.title")}</h1>
      <div className="status-line"><p>{status}</p><span className={isDirty ? "pill pill-warn" : "pill pill-neutral"}>{t(isDirty ? "settings.state.unsaved" : "settings.state.saved")}</span></div>
      <div className="card-stack">
        <article className="card">
          <h2>{t("settings.runtime.title")}</h2>
          {runtimeQuery.isLoading && <p>{t("settings.runtime.loading")}</p>}
          {runtimeQuery.isError && <p>{t("settings.runtime.loadFailed")}</p>}
          {runtime && <div className="badge-grid">
            {badge(t("settings.runtime.backend"), `${runtime.backend.status} - ${runtime.backend.host}:${runtime.backend.port}`, "good")}
            {badge(t("settings.runtime.koharu"), `${runtime.koharu.status} - ${runtime.koharu.baseUrl || config?.api?.baseUrl || t("settings.runtime.unavailable")}`, runtime.koharu.status === "running" ? "good" : "warn")}
            {badge(t("settings.ao.runtimeLabel"), `${runtime.agent.status} - ${runtime.agent.baseUrl || config?.agent?.baseUrl || t("settings.runtime.unavailable")}`, runtime.agent.status === "running" || runtime.agent.status === "ready" || runtime.agent.status === "available" ? "good" : "warn")}
          </div>}
        </article>

        {settings && <article className="card">
          <Section title={t("settings.preferences.title")} description={t("settings.preferences.description")}>
            <div className="form-grid">
              <label className="field"><span>{t("settings.language.label")}</span>
                <select value={settings.locale} onChange={(event) => updateLocal("locale", event.currentTarget.value)}>
                  <option value="zh-TW">{t("settings.language.option.zhTW")}</option><option value="en-US">{t("settings.language.option.enUS")}</option>
                </select>
              </label>
              {(["outputFolder", "referenceFolder"] as const).map((key) => {
                const name = key === "outputFolder" ? "output" : "reference";
                return <label className="field" key={key}><span>{t(`settings.folders.${name}.label`)}</span><small className="muted-text">{t(`settings.folders.${name}.help`)}</small>
                  <div className="field-with-button"><input value={settings[key]} onChange={(event) => updateLocal(key, event.currentTarget.value)} /><button className="secondary-button" type="button" onClick={() => void chooseFolder(key, key === "outputFolder" ? "settings.folders.browseOutput" : "settings.folders.browseReference")}>{t("settings.folders.browse")}</button></div>
                </label>;
              })}
            </div>
            {desktopInfo && <small className="muted-text">{desktopInfo.settingsFilePath}</small>}
          </Section>
        </article>}

        {config && <article className="card">
          <Section title={t("settings.koharu.translationTitle")} description={t("settings.koharu.translationDescription")}>
            <div className="form-grid">
              <label className="field"><span>{t("settings.koharu.baseUrl.label")}</span><input value={config.api?.baseUrl || ""} onChange={(event) => updateApi(event.currentTarget.value)} /></label>
              <label className="field"><span>{t("settings.koharu.translationModel.label")}</span><small className="muted-text">{t("settings.koharu.translationModel.help")}</small><input value={config.llm?.defaultModel || ""} onChange={(event) => updateLlm("defaultModel", event.currentTarget.value)} /></label>
              <label className="field"><span>{t("settings.koharu.translationProvider.label")}</span><input value={config.llm?.defaultProvider || ""} onChange={(event) => updateLlm("defaultProvider", event.currentTarget.value)} /></label>
              {ENGINE_KEYS.map((key) => {
                const current = config.engines?.[key] || "";
                const options = engineOptionsFor(catalogQuery.data?.engines, key);
                return <label className="field" key={key}><span>{key}</span><small className="muted-text">{t("settings.koharu.engineHelp", { engine: key })}</small>
                  <select value={current} onChange={(event) => { const value = event.currentTarget.value; setConfig((previous) => previous ? { ...previous, engines: { ...previous.engines, [key]: value } } : previous); }}>
                    <option value="">{t("settings.koharu.engineSelect.placeholder")}</option>
                    {current && !options.some((option) => option.id === current) && <option value={current}>{t("settings.koharu.engineUnavailable", { engine: current })}</option>}
                    {options.map((option) => <option key={option.id} value={option.id}>{option.name && option.name !== option.id ? `${option.name} (${option.id})` : option.id}</option>)}
                  </select>
                </label>;
              })}
            </div>
            {catalogQuery.isError && <p className="muted-text">{t("settings.koharu.engineCatalog.failed")}</p>}
            <div className="button-row">
              <button className="secondary-button" disabled={Boolean(koharuAction)} type="button" onClick={() => void runKoharuAction("start", startKoharuRuntime)}>{t(koharuAction === "start" ? "settings.koharu.starting" : "settings.koharu.start")}</button>
              <button className="secondary-button" disabled={Boolean(koharuAction)} type="button" onClick={() => void runKoharuAction("prepare", prepareKoharuRuntime)}>{t(koharuAction === "prepare" ? "settings.koharu.preparing" : "settings.koharu.prepare")}</button>
              <button className="secondary-button" disabled={Boolean(koharuAction)} type="button" onClick={() => void runKoharuAction("stop", stopKoharuRuntime)}>{t(koharuAction === "stop" ? "settings.koharu.stopping" : "settings.koharu.stop")}</button>
            </div>
            <details><summary>{t("settings.koharu.diagnostics.title")}</summary><div className="summary-grid">
              <div><strong>{t("settings.koharu.runtimeVersion")}</strong><span>{runtime?.koharu.version || t("settings.koharu.paths.unknown")}</span></div>
              <div><strong>{t("settings.koharu.runtimePid")}</strong><span>{runtime?.koharu.managedPid || t("settings.koharu.paths.unknown")}</span></div>
              {(["dataRoot", "projectsRoot", "modelsRoot", "runtimeRoot", "configPath", "executablePath"] as const).map((key) => <div key={key}><strong>{t(`settings.koharu.paths.${key}`)}</strong><code>{pathsQuery.data?.koharu[key] || t("settings.koharu.paths.unknown")}</code></div>)}
              {runtime?.koharu.lastError && <div><strong>{t("settings.koharu.runtimeError")}</strong><span>{runtime.koharu.lastError}</span></div>}
            </div></details>
          </Section>
        </article>}

        {config && <article className="card">
          <Section title={t("settings.ao.title")} description={t("settings.ao.description")}>
            <div className="form-grid">
              <label className="field"><span>{t("settings.ao.baseUrl.label")}</span><div className="field-with-button"><input value={config.agent?.baseUrl || ""} onChange={(event) => updateAgent("baseUrl", event.currentTarget.value)} /><button className="secondary-button" disabled={Boolean(aoAction) || !config.agent?.baseUrl} type="button" onClick={() => void connectAO()}>{t(aoAction === "connect" ? "settings.ao.connection.connecting" : "settings.ao.connection.connect")}</button></div></label>
              <label className="field"><span>{t("settings.ao.model.label")}</span><small className="muted-text">{t("settings.ao.model.help")}</small><div className="field-with-button"><select value={config.agent?.model || ""} onChange={(event) => updateAgent("model", event.currentTarget.value)}><option value="">{t("settings.ao.models.placeholder")}</option>{config.agent?.model && !aoModels.some((model) => model.id === config.agent?.model) && <option value={config.agent.model}>{config.agent.model}</option>}{aoModels.map((model) => <option key={model.id} value={model.id}>{`${model.providerName} / ${model.name}`}</option>)}</select><button className="secondary-button" disabled={Boolean(aoAction) || !config.agent?.baseUrl} type="button" onClick={() => void refreshAOModels()}>{t(aoAction === "refresh" ? "settings.ao.models.refreshing" : "settings.ao.models.refresh")}</button></div></label>
              <label className="field"><span>{t("settings.ao.apiKey.label")}</span><input type="password" value={config.agent?.apiKey || ""} onChange={(event) => updateAgent("apiKey", event.currentTarget.value)} /></label>
              <label className="checkbox-field"><input checked={config.workflow?.qualityCheck?.enabled !== false} type="checkbox" onChange={(event) => { const enabled = event.currentTarget.checked; setConfig((previous) => previous ? { ...previous, workflow: { ...previous.workflow, qualityCheck: { enabled } } } : previous); }} /><span>{t("settings.ao.qualityEnabled")}</span></label>
            </div>
            <details><summary>{t("settings.ao.advanced.title")}</summary><div className="form-grid">
              <label className="field"><span>{t("settings.ao.agentName.label")}</span><input value={config.agent?.agentName || ""} onChange={(event) => updateAgent("agentName", event.currentTarget.value)} /></label>
              {TIMEOUT_KEYS.map((key) => <label className="field" key={key}><span>{t(`settings.ao.timeout.${key}`)}</span><input min={1} type="number" value={config.agent?.[key] || ""} onChange={(event) => updateAgent(key, Number(event.currentTarget.value))} /></label>)}
            </div></details>
          </Section>
        </article>}

        {pathValidation && <article className="card"><h2>{t("settings.validation.title")}</h2><div className="badge-grid">
          {badge(t("settings.validation.output"), pathValidation.outputFolder.ok ? t("settings.validation.ok") : pathValidation.outputFolder.reason, pathValidation.outputFolder.ok ? "good" : "bad")}
          {badge(t("settings.validation.reference"), pathValidation.referenceFolder.ok ? t("settings.validation.ok") : pathValidation.referenceFolder.reason, pathValidation.referenceFolder.ok ? "good" : "warn")}
        </div></article>}

        <article className="card"><h2>{t("settings.actions.title")}</h2><p className="muted-text">{t("settings.scope.item.newJobs")}</p>
          <div className="button-row"><button className="primary-button" disabled={!settings || !config || saving} type="button" onClick={() => void handleSave()}>{t("settings.button.save")}</button><button className="secondary-button" disabled={!settings || saving} type="button" onClick={() => void handleReset()}>{t("settings.button.reset")}</button></div>
        </article>
      </div>
    </section>
  );
}
