import type { ReactNode } from "react";
import type { BackendConfig, KoharuEngineCatalog, KoharuEngineOption } from "../../api/runtime";
import { BackendConnectionSettings } from "./components/BackendConnectionSettings";
import { KoharuHostRuntimeSettings } from "./components/KoharuHostRuntimeSettings";
import { MaintenanceCleanup } from "./components/MaintenanceCleanup";
import { StorageLocations } from "./components/StorageLocations";
import { TIMEOUT_KEYS, type SettingsModel, type TimeoutKey, type Translate, useSettingsModel } from "./useSettingsModel";

const ENGINE_KEYS = ["detect", "fontDetect", "segment", "bubbleSegment", "ocr", "translate", "clean", "render"] as const;
type EngineKey = (typeof ENGINE_KEYS)[number];
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
  return <details className="settings-section" open={defaultOpen}>
    <summary><div><strong>{title}</strong><div className="muted-text">{description}</div></div></summary>
    <div className="settings-section-body">{children}</div>
  </details>;
}

function SettingsCard({ children }: { children: ReactNode }) {
  return <article className="card">{children}</article>;
}

function StatusBadge({ label, value, tone }: {
  label: string; value: string; tone: "good" | "warn" | "bad" | "neutral";
}) {
  return <div className={`status-badge status-${tone}`}><strong>{label}</strong><span>{value}</span></div>;
}

function RuntimeCard({ model }: { model: SettingsModel }) {
  const runtime = model.runtimeQuery.data;
  const unavailable = model.t("settings.runtime.unavailable");
  const agentReady = ["running", "ready", "available"].includes(runtime?.agent.status || "");
  return <SettingsCard>
    <h2>{model.t("settings.runtime.title")}</h2>
    {model.runtimeQuery.isLoading ? <p>{model.t("settings.runtime.loading")}</p> : null}
    {model.runtimeQuery.isError ? <p>{model.t("settings.runtime.loadFailed")}</p> : null}
    {runtime ? <div className="badge-grid">
      <StatusBadge label={model.t("settings.runtime.backend")}
        value={`${model.t(`settings.runtime.backendMode.${runtime.backend.deploymentMode || "standalone"}`)} - ${runtime.backend.host}:${runtime.backend.port}`} tone="good" />
      <StatusBadge label={model.t("settings.runtime.koharu")}
        value={`${runtime.koharu.status} - ${runtime.koharu.baseUrl || model.config?.api?.baseUrl || unavailable}`}
        tone={runtime.koharu.status === "running" ? "good" : "warn"} />
      <StatusBadge label={model.t("settings.ao.runtimeLabel")}
        value={`${runtime.agent.status} - ${runtime.agent.baseUrl || model.config?.agent?.baseUrl || unavailable}`}
        tone={agentReady ? "good" : "warn"} />
    </div> : null}
  </SettingsCard>;
}

function BackendCard({ model }: { model: SettingsModel }) {
  if (!model.settings) return null;
  return <SettingsCard><Section title={model.t("settings.backend.title")} description={model.t("settings.backend.description")}>
    <BackendConnectionSettings baseUrl={model.settings.backendBaseUrl} desktopInfo={model.desktopInfo}
      onBaseUrlChange={(value) => model.updateLocal("backendBaseUrl", value)} t={model.t} />
  </Section></SettingsCard>;
}

function FolderField({ model, field }: { model: SettingsModel; field: "outputFolder" | "referenceFolder" }) {
  if (!model.settings) return null;
  const name = field === "outputFolder" ? "output" : "reference";
  const titleKey = field === "outputFolder" ? "settings.folders.browseOutput" : "settings.folders.browseReference";
  return <label className="field">
    <span>{model.t(`settings.folders.${name}.label`)}</span>
    <small className="muted-text">{model.t(`settings.folders.${name}.help`)}</small>
    <div className="field-with-button">
      <input value={model.settings[field]} onChange={(event) => model.updateLocal(field, event.currentTarget.value)} />
      <button className="secondary-button" type="button"
        onClick={() => void model.chooseFolder(field, titleKey)}>{model.t("settings.folders.browse")}</button>
    </div>
  </label>;
}

function PreferencesCard({ model }: { model: SettingsModel }) {
  if (!model.settings) return null;
  return <SettingsCard><Section title={model.t("settings.preferences.title")} description={model.t("settings.preferences.description")}>
    <div className="form-grid"><label className="field"><span>{model.t("settings.language.label")}</span>
      <select value={model.settings.locale} onChange={(event) => model.updateLocal("locale", event.currentTarget.value)}>
        <option value="zh-TW">{model.t("settings.language.option.zhTW")}</option>
        <option value="en-US">{model.t("settings.language.option.enUS")}</option>
      </select></label>
      <FolderField model={model} field="outputFolder" /><FolderField model={model} field="referenceFolder" />
    </div>
    {model.desktopInfo ? <small className="muted-text">{model.desktopInfo.settingsFilePath}</small> : null}
  </Section></SettingsCard>;
}

function StorageCard({ model }: { model: SettingsModel }) {
  if (!model.settings) return null;
  return <SettingsCard><Section title={model.t("settings.storage.title")} description={model.t("settings.storage.description")}>
    <StorageLocations backend={model.pathsQuery.data?.backend} desktopInfo={model.desktopInfo}
      koharu={model.pathsQuery.data?.koharu} onOpen={model.openStoragePath} settings={model.settings} t={model.t} />
  </Section></SettingsCard>;
}

function selectTranslationProvider(model: SettingsModel, providerId: string) {
  const provider = model.translationCatalogQuery.data?.providers.find((entry) => entry.providerId === providerId);
  model.setConfig((current) => current ? { ...current, translation: { ...current.translation,
    defaultTarget: { providerId, modelId: provider?.models[0]?.modelId || "" } } } : current);
}

function TranslationProviderField({ model }: { model: SettingsModel }) {
  const current = model.config?.translation?.defaultTarget?.providerId || "";
  const providers = model.translationCatalogQuery.data?.providers || [];
  return <label className="field"><span>{model.t("settings.koharu.translationProvider.label")}</span>
    <select value={current} onChange={(event) => selectTranslationProvider(model, event.currentTarget.value)}>
      {current && !providers.some((entry) => entry.providerId === current) ? <option value={current}>{current}</option> : null}
      {providers.map((provider) => <option key={provider.providerId} value={provider.providerId}
        disabled={provider.status !== "ready"}>{provider.name}</option>)}
    </select>
  </label>;
}

function TranslationModelField({ model }: { model: SettingsModel }) {
  const current = model.config?.translation?.defaultTarget?.modelId || "";
  const providerId = model.config?.translation?.defaultTarget?.providerId;
  const models = model.translationCatalogQuery.data?.providers.find((entry) => entry.providerId === providerId)?.models || [];
  return <label className="field"><span>{model.t("settings.koharu.translationModel.label")}</span>
    <small className="muted-text">{model.t("settings.koharu.translationModel.help")}</small>
    <select value={current} onChange={(event) => model.updateTranslationTarget("modelId", event.currentTarget.value)}>
      {current && !models.some((entry) => entry.modelId === current) ? <option value={current}>{current}</option> : null}
      {models.map((entry) => <option key={entry.modelId} value={entry.modelId}>{entry.name}</option>)}
    </select>
  </label>;
}

function EngineField({ model, engine }: { model: SettingsModel; engine: EngineKey }) {
  const current = model.config?.engines?.[engine] || "";
  const options = engineOptionsFor(model.catalogQuery.data?.engines, engine);
  return <label className="field"><span>{engine}</span>
    <small className="muted-text">{model.t("settings.koharu.engineHelp", { engine })}</small>
    <select value={current} onChange={(event) => model.updateEngine(engine, event.currentTarget.value)}>
      <option value="">{model.t("settings.koharu.engineSelect.placeholder")}</option>
      {current && !options.some((option) => option.id === current) ? <option value={current}>
        {model.t("settings.koharu.engineUnavailable", { engine: current })}</option> : null}
      {options.map((option) => <option key={option.id} value={option.id}>
        {option.name && option.name !== option.id ? `${option.name} (${option.id})` : option.id}</option>)}
    </select>
  </label>;
}

function KoharuFields({ model }: { model: SettingsModel }) {
  return <div className="form-grid">
    <label className="field"><span>{model.t("settings.koharu.baseUrl.label")}</span>
      <input value={model.config?.api?.baseUrl || ""}
        onChange={(event) => model.updateApi(event.currentTarget.value)} /></label>
    <TranslationProviderField model={model} />
    <TranslationModelField model={model} />
    {ENGINE_KEYS.map((engine) => <EngineField model={model} engine={engine} key={engine} />)}
  </div>;
}

function KoharuActionButton({ action, active, primary, run, t }: {
  action: "install" | "start" | "prepare" | "stop"; active: SettingsModel["koharuAction"];
  primary?: boolean; run: () => void; t: Translate;
}) {
  return <button className={primary ? "primary-button" : "secondary-button"} disabled={Boolean(active)}
    type="button" onClick={run}>{t(active === action ? `settings.koharu.${action}ing` : `settings.koharu.${action}`)}</button>;
}

function KoharuActions({ model }: { model: SettingsModel }) {
  const execute = (action: "install" | "start" | "prepare" | "stop", runner: () => Promise<unknown>) =>
    void model.runKoharuAction(action, runner);
  return <div className="button-row">
    <KoharuActionButton action="install" active={model.koharuAction} primary
      run={() => execute("install", model.installConfigured)} t={model.t} />
    <KoharuActionButton action="start" active={model.koharuAction}
      run={() => execute("start", model.startConfigured)} t={model.t} />
    {model.desktopInfo?.backendProcess.deploymentMode !== "docker" ? <KoharuActionButton action="prepare"
      active={model.koharuAction} run={() => execute("prepare", model.prepareConfigured)} t={model.t} /> : null}
    <KoharuActionButton action="stop" active={model.koharuAction}
      run={() => execute("stop", model.stopConfigured)} t={model.t} />
  </div>;
}

function DiagnosticValue({ label, value, code }: { label: string; value: ReactNode; code?: boolean }) {
  return <div><strong>{label}</strong>{code ? <code>{value}</code> : <span>{value}</span>}</div>;
}

function KoharuDiagnostics({ model }: { model: SettingsModel }) {
  const unknown = model.t("settings.koharu.paths.unknown");
  const keys = ["dataRoot", "projectsRoot", "modelsRoot", "runtimeRoot", "configPath", "executablePath"] as const;
  return <details><summary>{model.t("settings.koharu.diagnostics.title")}</summary><div className="summary-grid">
    <DiagnosticValue label={model.t("settings.koharu.runtimeVersion")} value={model.runtimeQuery.data?.koharu.version || unknown} />
    <DiagnosticValue label={model.t("settings.koharu.runtimePid")} value={model.runtimeQuery.data?.koharu.managedPid || unknown} />
    {keys.map((key) => <DiagnosticValue key={key} label={model.t(`settings.koharu.paths.${key}`)}
      value={model.pathsQuery.data?.koharu[key] || unknown} code />)}
    {model.runtimeQuery.data?.koharu.lastError ? <DiagnosticValue label={model.t("settings.koharu.runtimeError")}
      value={model.runtimeQuery.data.koharu.lastError} /> : null}
  </div></details>;
}

function KoharuCard({ model }: { model: SettingsModel }) {
  if (!model.config) return null;
  return <SettingsCard><Section title={model.t("settings.koharu.translationTitle")}
    description={model.t("settings.koharu.translationDescription")}>
    {model.settings ? <KoharuHostRuntimeSettings autoStart={model.settings.koharuAutoStart}
      executablePath={model.settings.koharuExecutablePath} process={model.desktopInfo?.koharuProcess || null}
      onAutoStartChange={model.updateAutoStart} onExecutablePathChange={(value) => model.updateLocal("koharuExecutablePath", value)}
      onBrowse={() => void model.chooseKoharuExecutable()} t={model.t} /> : null}
    <KoharuFields model={model} />
    {model.catalogQuery.isError ? <p className="muted-text">{model.t("settings.koharu.engineCatalog.failed")}</p> : null}
    <KoharuActions model={model} /><KoharuDiagnostics model={model} />
  </Section></SettingsCard>;
}

function AoConnectionField({ model }: { model: SettingsModel }) {
  return <label className="field"><span>{model.t("settings.ao.baseUrl.label")}</span><div className="field-with-button">
    <input value={model.config?.agent?.baseUrl || ""} onChange={(event) => model.updateAgent("baseUrl", event.currentTarget.value)} />
    <button className="secondary-button" disabled={Boolean(model.aoAction) || !model.config?.agent?.baseUrl}
      type="button" onClick={() => void model.connectAO()}>
      {model.t(model.aoAction === "connect" ? "settings.ao.connection.connecting" : "settings.ao.connection.connect")}
    </button>
  </div></label>;
}

function AoModelField({ model }: { model: SettingsModel }) {
  const current = model.config?.agent?.model || "";
  return <label className="field"><span>{model.t("settings.ao.model.label")}</span>
    <small className="muted-text">{model.t("settings.ao.model.help")}</small><div className="field-with-button">
      <select value={current} onChange={(event) => model.updateAgent("model", event.currentTarget.value)}>
        <option value="">{model.t("settings.ao.models.placeholder")}</option>
        {current && !model.aoModels.some((entry) => entry.id === current) ? <option value={current}>{current}</option> : null}
        {model.aoModels.map((entry) => <option key={entry.id} value={entry.id}>{`${entry.providerName} / ${entry.name}`}</option>)}
      </select>
      <button className="secondary-button" disabled={Boolean(model.aoAction) || !model.config?.agent?.baseUrl}
        type="button" onClick={() => void model.refreshAOModels()}>
        {model.t(model.aoAction === "refresh" ? "settings.ao.models.refreshing" : "settings.ao.models.refresh")}
      </button>
    </div>
  </label>;
}

function TimeoutField({ model, field }: { model: SettingsModel; field: TimeoutKey }) {
  return <label className="field"><span>{model.t(`settings.ao.timeout.${field}`)}</span>
    <input min={1} type="number" value={model.config?.agent?.[field] || ""}
      onChange={(event) => model.updateAgent(field, Number(event.currentTarget.value))} />
  </label>;
}

function AoAdvanced({ model }: { model: SettingsModel }) {
  return <details><summary>{model.t("settings.ao.advanced.title")}</summary><div className="form-grid">
    <label className="field"><span>{model.t("settings.ao.agentName.label")}</span>
      <input value={model.config?.agent?.agentName || ""}
        onChange={(event) => model.updateAgent("agentName", event.currentTarget.value)} /></label>
    {TIMEOUT_KEYS.map((field) => <TimeoutField model={model} field={field} key={field} />)}
  </div></details>;
}

function AoCard({ model }: { model: SettingsModel }) {
  if (!model.config) return null;
  return <SettingsCard><Section title={model.t("settings.ao.title")} description={model.t("settings.ao.description")}>
    <div className="form-grid"><AoConnectionField model={model} /><AoModelField model={model} />
      <label className="field"><span>{model.t("settings.ao.apiKey.label")}</span>
        <input type="password" value={model.config.agent?.apiKey || ""}
          onChange={(event) => model.updateAgent("apiKey", event.currentTarget.value)} /></label>
      <label className="checkbox-field"><input checked={model.config.workflow?.qualityCheck?.enabled !== false}
        type="checkbox" onChange={(event) => model.updateQualityEnabled(event.currentTarget.checked)} />
        <span>{model.t("settings.ao.qualityEnabled")}</span></label>
    </div><AoAdvanced model={model} />
  </Section></SettingsCard>;
}

function MaintenanceCard({ model }: { model: SettingsModel }) {
  if (!model.config) return null;
  return <SettingsCard><Section title={model.t("settings.maintenance.title")}
    description={model.t("settings.maintenance.description")}>
    <MaintenanceCleanup config={model.config} onConfigChange={model.updateMaintenance} t={model.t} />
  </Section></SettingsCard>;
}

function ValidationCard({ model }: { model: SettingsModel }) {
  if (!model.pathValidation) return null;
  const output = model.pathValidation.outputFolder;
  const reference = model.pathValidation.referenceFolder;
  return <SettingsCard><h2>{model.t("settings.validation.title")}</h2><div className="badge-grid">
    <StatusBadge label={model.t("settings.validation.output")}
      value={output.ok ? model.t("settings.validation.ok") : output.reason} tone={output.ok ? "good" : "bad"} />
    <StatusBadge label={model.t("settings.validation.reference")}
      value={reference.ok ? model.t("settings.validation.ok") : reference.reason} tone={reference.ok ? "good" : "warn"} />
  </div></SettingsCard>;
}

function SaveActionsCard({ model }: { model: SettingsModel }) {
  return <SettingsCard><h2>{model.t("settings.actions.title")}</h2>
    <p className="muted-text">{model.t("settings.scope.item.newJobs")}</p><div className="button-row">
      <button className="primary-button" disabled={!model.settings || !model.config || model.saving}
        type="button" onClick={() => void model.handleSave()}>{model.t("settings.button.save")}</button>
      <button className="secondary-button" disabled={!model.settings || model.saving}
        type="button" onClick={() => void model.handleReset()}>{model.t("settings.button.reset")}</button>
    </div>
  </SettingsCard>;
}

function SettingsView({ model }: { model: SettingsModel }) {
  return <section className="page"><h1>{model.t("settings.title")}</h1>
    <div className="status-line"><p>{model.status}</p>
      <span className={model.isDirty ? "pill pill-warn" : "pill pill-neutral"}>
        {model.t(model.isDirty ? "settings.state.unsaved" : "settings.state.saved")}</span></div>
    <div className="card-stack"><RuntimeCard model={model} /><BackendCard model={model} />
      <PreferencesCard model={model} /><StorageCard model={model} /><KoharuCard model={model} />
      <AoCard model={model} /><MaintenanceCard model={model} /><ValidationCard model={model} />
      <SaveActionsCard model={model} />
    </div>
  </section>;
}

export function SettingsContent() {
  const model = useSettingsModel();
  return <SettingsView model={model} />;
}
