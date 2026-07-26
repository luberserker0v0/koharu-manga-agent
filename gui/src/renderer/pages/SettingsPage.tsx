import { useQuery } from "@tanstack/react-query";
import { ChangeEvent, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  getBackendConfig,
  getKoharuEngineCatalog,
  getKoharuRuntimePaths,
  getRuntimeStatus,
  prepareKoharuRuntime,
  startKoharuRuntime,
  stopKoharuRuntime,
  type BackendConfig,
  type KoharuEngineCatalog,
  type KoharuEngineOption,
  type RuntimeStatus,
} from "../api/runtime";
import {
  getDesktopInfo,
  pickDirectory,
  readSettings,
  validatePaths,
  writeSettings,
} from "../services/desktop_api";
import { useLanguageStore } from "../stores/language_store";
import type { DesktopInfo, GuiSettings, PathValidationSummary } from "../types/settings";

const ENGINE_KEYS = [
  "detect",
  "fontDetect",
  "segment",
  "bubbleSegment",
  "ocr",
  "translate",
  "clean",
  "render",
] as const;

type EngineKey = (typeof ENGINE_KEYS)[number];

const ENGINE_CATALOG_KEYS: Record<EngineKey, (keyof KoharuEngineCatalog)[]> = {
  detect: ["detectors"],
  fontDetect: ["fontDetectors", "detectors"],
  segment: ["segmenters", "detectors"],
  bubbleSegment: ["bubbleSegmenters", "detectors"],
  ocr: ["ocr"],
  translate: ["translators"],
  clean: ["inpainters"],
  render: ["renderers"],
};

function engineOptionsFor(
  catalog: KoharuEngineCatalog | null | undefined,
  engineKey: EngineKey
): KoharuEngineOption[] {
  const options = new Map<string, KoharuEngineOption>();
  for (const catalogKey of ENGINE_CATALOG_KEYS[engineKey]) {
    for (const option of catalog?.[catalogKey] || []) {
      if (option?.id && !options.has(option.id)) {
        options.set(option.id, option);
      }
    }
  }
  return Array.from(options.values());
}

function formatEngineOption(option: KoharuEngineOption): string {
  return option.name && option.name !== option.id ? `${option.name} (${option.id})` : option.id;
}

function updateEngine(settings: GuiSettings, key: string, value: string): GuiSettings {
  return {
    ...settings,
    engines: {
      ...settings.engines,
      [key]: value,
    },
  };
}

function SettingsSection({
  title,
  description,
  defaultOpen = false,
  children,
}: {
  title: string;
  description: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="settings-section" open={defaultOpen}>
      <summary>
        <div>
          <strong>{title}</strong>
          <div className="muted-text">{description}</div>
        </div>
      </summary>
      <div className="settings-section-body">{children}</div>
    </details>
  );
}

function applyBackendDefaults(
  localSettings: GuiSettings,
  backendConfig: BackendConfig | null,
  runtimeStatus: RuntimeStatus | null
): GuiSettings {
  const runtime = backendConfig?.agent?.opencode?.runtime;
  const runtimeMode = runtime?.mode || localSettings.agent.runtimeMode || "managed";
  const backendBaseUrl = backendConfig?.api?.baseUrl || runtimeStatus?.koharu.baseUrl || "";
  const localKoharuBaseUrl = localSettings.koharu.baseUrl || "";
  const shouldUseBackendKoharuBaseUrl =
    !localKoharuBaseUrl ||
    localKoharuBaseUrl === "http://127.0.0.1:4001" ||
    localKoharuBaseUrl === "http://127.0.0.1:4310";
  const qualityEnabled =
    typeof backendConfig?.workflow?.qualityCheck?.enabled === "boolean"
      ? backendConfig.workflow.qualityCheck.enabled
      : localSettings.quality.enabled;

  return {
    ...localSettings,
    agent: {
      ...localSettings.agent,
      provider: "opencode",
      runtimeMode,
      baseUrl: localSettings.agent.baseUrl || runtime?.baseUrl || "",
      commandDir: localSettings.agent.commandDir || runtime?.commandDir || "",
      moduleName:
        localSettings.agent.moduleName ||
        backendConfig?.agent?.opencode?.moduleName ||
        "@opencode-ai/sdk/client",
      exportName:
        localSettings.agent.exportName ||
        backendConfig?.agent?.opencode?.exportName ||
        "createOpencodeClient",
      timeoutMs:
        localSettings.agent.timeoutMs ||
        runtime?.timeoutMs ||
        10000,
    },
    quality: {
      ...localSettings.quality,
      enabled: qualityEnabled,
      modelId:
        localSettings.quality.modelId ||
        backendConfig?.quality?.modelId ||
        runtimeStatus?.quality.modelId ||
        "",
      serverUrl:
        localSettings.quality.serverUrl ||
        backendConfig?.quality?.serverUrl ||
        runtimeStatus?.quality.serverUrl ||
        "",
    },
    translation: {
      ...localSettings.translation,
      modelId:
        localSettings.translation.modelId ||
        backendConfig?.translation?.modelId ||
        runtimeStatus?.translation.modelId ||
        backendConfig?.llm?.defaultModel ||
        runtimeStatus?.translation.defaultModel ||
        "",
      serverUrl:
        localSettings.translation.serverUrl ||
        backendConfig?.translation?.serverUrl ||
        runtimeStatus?.translation.serverUrl ||
        "",
      providerId:
        localSettings.translation.providerId ||
        backendConfig?.translation?.providerId ||
        runtimeStatus?.translation.providerId ||
        backendConfig?.llm?.defaultProvider ||
        runtimeStatus?.translation.defaultProvider ||
        "",
    },
    koharu: {
      ...localSettings.koharu,
      baseUrl: shouldUseBackendKoharuBaseUrl ? backendBaseUrl || "http://127.0.0.1:4000" : localKoharuBaseUrl,
    },
    engines: {
      ...(backendConfig?.engines || {}),
      ...(localSettings.engines || {}),
    },
  };
}

function buildResetSettings(
  current: GuiSettings,
  desktopInfo: DesktopInfo | null,
  backendConfig: BackendConfig | null,
  runtimeStatus: RuntimeStatus | null
): GuiSettings {
  return applyBackendDefaults(
    {
      ...current,
      locale: "zh-TW",
      sourceFolder: "",
      outputFolder: desktopInfo?.shellPaths.downloads ?? current.outputFolder,
      referenceFolder: "",
      lastPickedSourceFolder: "",
      lastSelectedPage: "job",
      lastSelectedJobId: null,
      lastSelectedMangaId: null,
      agent: {
        provider: "opencode",
        runtimeMode: "managed",
        baseUrl: "",
        commandDir: "",
        moduleName: "",
        exportName: "",
        timeoutMs: 10000,
      },
      quality: {
        enabled: true,
        modelId: "",
        serverUrl: "",
      },
      translation: {
        modelId: "",
        serverUrl: "",
        providerId: "",
      },
      koharu: {
        baseUrl: "",
      },
      engines: {},
    },
    backendConfig,
    runtimeStatus
  );
}

export function SettingsPage() {
  const t = useLanguageStore((state) => state.t);
  const setLocale = useLanguageStore((state) => state.setLocale);
  const [settings, setSettings] = useState<GuiSettings | null>(null);
  const [savedSettings, setSavedSettings] = useState<GuiSettings | null>(null);
  const [desktopInfo, setDesktopInfo] = useState<DesktopInfo | null>(null);
  const [pathValidation, setPathValidation] = useState<PathValidationSummary | null>(null);
  const [status, setStatus] = useState(t("settings.status.loading"));
  const [koharuAction, setKoharuAction] = useState<"start" | "prepare" | "stop" | null>(null);

  const runtimeQuery = useQuery({
    queryKey: ["runtime-status"],
    queryFn: getRuntimeStatus,
    refetchInterval: 10000,
    retry: false,
  });
  const configQuery = useQuery({
    queryKey: ["backend-config"],
    queryFn: getBackendConfig,
    refetchInterval: 10000,
    retry: false,
  });
  const engineCatalogQuery = useQuery({
    queryKey: ["koharu-engine-catalog"],
    queryFn: getKoharuEngineCatalog,
    refetchInterval: 30000,
    retry: false,
  });
  const koharuPathsQuery = useQuery({
    queryKey: ["koharu-runtime-paths"],
    queryFn: getKoharuRuntimePaths,
    refetchInterval: 30000,
    retry: false,
  });

  useEffect(() => {
    setStatus(t("settings.status.loading"));
  }, [t]);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const [localSettings, nextDesktopInfo, runtimeResult, configResult] = await Promise.allSettled([
          readSettings(),
          getDesktopInfo(),
          getRuntimeStatus(),
          getBackendConfig(),
        ]);
        if (!active) {
          return;
        }
        if (localSettings.status !== "fulfilled" || nextDesktopInfo.status !== "fulfilled") {
          throw new Error("Failed to load local desktop settings.");
        }

        const runtimeStatus = runtimeResult.status === "fulfilled" ? runtimeResult.value : null;
        const backendConfig = configResult.status === "fulfilled" ? configResult.value : null;
        const effectiveSettings = applyBackendDefaults(localSettings.value, backendConfig, runtimeStatus);
        setSettings(effectiveSettings);
        setSavedSettings(effectiveSettings);
        setLocale(effectiveSettings.locale || "zh-TW");
        setDesktopInfo(nextDesktopInfo.value);
        setStatus(t("settings.status.loaded"));

        const result = await validatePaths({
          sourceFolder: "",
          outputFolder: effectiveSettings.outputFolder,
          referenceFolder: effectiveSettings.referenceFolder,
          sourceRequired: false,
        });
        if (!active) {
          return;
        }
        setPathValidation(result);
      } catch {
        if (!active) {
          return;
        }
        setStatus(t("settings.status.loadFailed"));
      }
    };

    void load();

    return () => {
      active = false;
    };
  }, [setLocale, t]);

  const isDirty = useMemo(() => {
    if (!settings || !savedSettings) {
      return false;
    }
    return JSON.stringify(settings) !== JSON.stringify(savedSettings);
  }, [savedSettings, settings]);

  useEffect(() => {
    if (!settings || !savedSettings || isDirty) {
      return;
    }
    if (!configQuery.data && !runtimeQuery.data) {
      return;
    }
    const nextEffective = applyBackendDefaults(settings, configQuery.data ?? null, runtimeQuery.data ?? null);
    const nextSerialized = JSON.stringify(nextEffective);
    if (nextSerialized !== JSON.stringify(savedSettings)) {
      setSettings(nextEffective);
      setSavedSettings(nextEffective);
    }
  }, [configQuery.data, isDirty, runtimeQuery.data, savedSettings, settings]);

  const refreshValidation = async (nextSettings: GuiSettings) => {
    const validation = await validatePaths({
      sourceFolder: "",
      outputFolder: nextSettings.outputFolder,
      referenceFolder: nextSettings.referenceFolder,
      sourceRequired: false,
    });
    setPathValidation(validation);
  };

  const handleChange =
    (apply: (settings: GuiSettings, value: string | boolean) => GuiSettings) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const target = event.target as HTMLInputElement | HTMLSelectElement | null;
      const value =
        target instanceof HTMLInputElement && target.type === "checkbox"
          ? Boolean(target.checked)
          : String(target?.value ?? "");
      setSettings((current) => {
        if (!current) {
          return current;
        }
        const nextSettings = apply(current, value);
        void refreshValidation(nextSettings);
        return nextSettings;
      });
    };

  const handleSave = async () => {
    if (!settings) {
      return;
    }
    try {
      const validation = await validatePaths({
        sourceFolder: "",
        outputFolder: settings.outputFolder,
        referenceFolder: settings.referenceFolder,
        sourceRequired: false,
      });
      setPathValidation(validation);
      if (!validation.outputFolder.ok || !validation.referenceFolder.ok) {
        setStatus(t("settings.status.validationFailed"));
        return;
      }
      const saved = await writeSettings(settings);
      const effectiveSaved = applyBackendDefaults(saved, configQuery.data ?? null, runtimeQuery.data ?? null);
      setSettings(effectiveSaved);
      setSavedSettings(effectiveSaved);
      setLocale(effectiveSaved.locale);
      setStatus(t("settings.status.saved"));
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `${t("settings.status.saveFailed")}: ${error.message}`
          : t("settings.status.saveFailed")
      );
    }
  };

  const resetToDefaults = async () => {
    if (!settings) {
      return;
    }
    try {
      const defaults = buildResetSettings(
        settings,
        desktopInfo,
        configQuery.data ?? null,
        runtimeQuery.data ?? null
      );
      const saved = await writeSettings(defaults);
      setSettings(saved);
      setSavedSettings(saved);
      setLocale(saved.locale);
      await refreshValidation(saved);
      setStatus(t("settings.status.resetSaved"));
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `${t("settings.status.resetFailed")}: ${error.message}`
          : t("settings.status.resetFailed")
      );
    }
  };

  const pickFolderFor =
    (key: "outputFolder" | "referenceFolder", titleKey: string) => async () => {
      const currentValue = settings?.[key] || "";
      try {
        const result = await pickDirectory({
          title: t(titleKey),
          defaultPath: currentValue || desktopInfo?.shellPaths.documents,
        });
        if (result.canceled || !result.path) {
          return;
        }
        setSettings((current) => {
          if (!current) {
            return current;
          }
          const nextSettings = {
            ...current,
            [key]: result.path,
          };
          void refreshValidation(nextSettings);
          return nextSettings;
        });
      } catch (error) {
        setStatus(
          error instanceof Error
            ? `${t("settings.status.pickFolderFailed")}: ${error.message}`
            : t("settings.status.pickFolderFailed")
        );
      }
    };

  const statusBadge = (label: string, value: string, tone: "good" | "warn" | "bad" | "neutral") => (
    <div className={`status-badge status-${tone}`}>
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );

  const koharuStatusTone = (runtimeStatus: RuntimeStatus["koharu"] | null | undefined) => {
    if (!runtimeStatus) return "neutral";
    if (runtimeStatus.status === "running") return "good";
    if (runtimeStatus.status === "failed") return "bad";
    if (runtimeStatus.status === "installed") return "warn";
    return "neutral";
  };

  const runKoharuAction = async (
    action: "start" | "prepare" | "stop",
    runner: () => Promise<{ koharu: RuntimeStatus["koharu"] }>
  ) => {
    setKoharuAction(action);
    setStatus(t(`settings.koharu.status.${action}ing`));
    try {
      await runner();
      await runtimeQuery.refetch();
      await configQuery.refetch();
      await koharuPathsQuery.refetch();
      await engineCatalogQuery.refetch();
      setStatus(t(`settings.koharu.status.${action}ed`));
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `${t(`settings.koharu.status.${action}Failed`)}: ${error.message}`
          : t(`settings.koharu.status.${action}Failed`)
      );
    } finally {
      setKoharuAction(null);
    }
  };

  return (
    <section className="page">
      <h1>{t("settings.title")}</h1>
      <div className="status-line">
        <p>{status}</p>
        <span className={isDirty ? "pill pill-warn" : "pill pill-neutral"}>
          {isDirty ? t("settings.state.unsaved") : t("settings.state.saved")}
        </span>
      </div>
      <article className="card">
        <h2>{t("settings.scope.title")}</h2>
        <ul className="plain-list">
          <li>{t("settings.scope.item.newJobs")}</li>
          <li>{t("settings.scope.item.runningJobs")}</li>
          <li>{t("settings.scope.item.reload")}</li>
          <li>{t("settings.scope.item.localFile")}</li>
        </ul>
      </article>
      <div className="card-stack">
        <article className="card">
          <h2>{t("settings.runtime.title")}</h2>
          {runtimeQuery.isLoading && <p>{t("settings.runtime.loading")}</p>}
          {runtimeQuery.isError && <p>{t("settings.runtime.loadFailed")}</p>}
          {runtimeQuery.data && (
            <div className="badge-grid">
              {statusBadge(t("settings.runtime.backend"), runtimeQuery.data.backend.status, "good")}
              {statusBadge(
                t("settings.runtime.koharu"),
                `${runtimeQuery.data.koharu.status} · ${runtimeQuery.data.koharu.baseUrl ?? "n/a"}`,
                koharuStatusTone(runtimeQuery.data.koharu)
              )}
              {statusBadge(t("settings.runtime.agent"), runtimeQuery.data.agent.provider ?? "n/a", "neutral")}
              {statusBadge(
                t("settings.runtime.translationDefault"),
                runtimeQuery.data.translation.defaultModel ?? "n/a",
                "neutral"
              )}
            </div>
          )}
        </article>

        <article className="card">
          <h2>{t("settings.localFile.title")}</h2>
          <p>{desktopInfo?.settingsFilePath ?? t("settings.status.loading")}</p>
          <p className="muted-text">{t("settings.localFile.description")}</p>
        </article>

        <article className="card">
          <h2>{t("settings.systemFields.title")}</h2>
          <ul className="plain-list">
            <li>{t("settings.systemFields.item.provider")}</li>
            <li>{t("settings.systemFields.item.sdk")}</li>
            <li>{t("settings.systemFields.item.restore")}</li>
          </ul>
        </article>

        {pathValidation && (
          <article className="card">
            <h2>{t("settings.validation.title")}</h2>
            <div className="badge-grid">
              {statusBadge(
                t("settings.validation.output"),
                pathValidation.outputFolder.ok ? t("settings.validation.ok") : pathValidation.outputFolder.reason,
                pathValidation.outputFolder.ok ? "good" : "bad"
              )}
              {statusBadge(
                t("settings.validation.reference"),
                pathValidation.referenceFolder.ok ? t("settings.validation.ok") : pathValidation.referenceFolder.reason,
                pathValidation.referenceFolder.ok ? "good" : "warn"
              )}
            </div>
          </article>
        )}

        {settings && (
          <article className="card">
            <h2>{t("settings.editable.title")}</h2>
            <SettingsSection
              title={t("settings.language.title")}
              description={t("settings.language.description")}
            >
              <div className="form-grid">
                <label>
                  <span>{t("settings.language.label")}</span>
                  <small className="muted-text">{t("settings.language.help")}</small>
                  <select
                    value={settings.locale}
                    onChange={handleChange((current, value) => ({
                      ...current,
                      locale: value as GuiSettings["locale"],
                    }))}
                  >
                    <option value="zh-TW">{t("settings.language.option.zhTW")}</option>
                    <option value="en-US">{t("settings.language.option.enUS")}</option>
                  </select>
                </label>
              </div>
            </SettingsSection>

            <SettingsSection
              title={t("settings.folders.title")}
              description={t("settings.folders.description")}
              defaultOpen
            >
              <div className="form-grid">
                <label>
                  <span>{t("settings.folders.output.label")}</span>
                  <small className="muted-text">{t("settings.folders.output.help")}</small>
                  <div className="field-with-action">
                    <input
                      value={settings.outputFolder}
                      onChange={handleChange((current, value) => ({
                        ...current,
                        outputFolder: String(value),
                      }))}
                    />
                    <button
                      className="secondary-button"
                      onClick={pickFolderFor("outputFolder", "settings.folders.browseOutput")}
                      type="button"
                    >
                      {t("settings.folders.browse")}
                    </button>
                  </div>
                </label>
                <label>
                  <span>{t("settings.folders.reference.label")}</span>
                  <small className="muted-text">{t("settings.folders.reference.help")}</small>
                  <div className="field-with-action">
                    <input
                      value={settings.referenceFolder}
                      onChange={handleChange((current, value) => ({
                        ...current,
                        referenceFolder: String(value),
                      }))}
                    />
                    <button
                      className="secondary-button"
                      onClick={pickFolderFor("referenceFolder", "settings.folders.browseReference")}
                      type="button"
                    >
                      {t("settings.folders.browse")}
                    </button>
                  </div>
                </label>
              </div>
            </SettingsSection>

            <SettingsSection
              title={t("settings.agent.title")}
              description={t("settings.agent.description")}
            >
              <div className="form-grid">
                <label>
                  <span>{t("settings.agent.runtimeMode.label")}</span>
                  <small className="muted-text">{t("settings.agent.runtimeMode.help")}</small>
                  <select
                    value={settings.agent.runtimeMode}
                    onChange={handleChange((current, value) => ({
                      ...current,
                      agent: {
                        ...current.agent,
                        runtimeMode: value as "managed" | "external",
                      },
                    }))}
                  >
                    <option value="managed">{t("settings.agent.runtimeMode.managed")}</option>
                    <option value="external">{t("settings.agent.runtimeMode.external")}</option>
                  </select>
                </label>
                <label>
                  <span>{t("settings.agent.baseUrl.label")}</span>
                  <small className="muted-text">{t("settings.agent.baseUrl.help")}</small>
                  <input
                    value={settings.agent.baseUrl}
                    onChange={handleChange((current, value) => ({
                      ...current,
                      agent: { ...current.agent, baseUrl: String(value) },
                    }))}
                  />
                </label>
                <label>
                  <span>{t("settings.agent.commandDir.label")}</span>
                  <small className="muted-text">{t("settings.agent.commandDir.help")}</small>
                  <input
                    value={settings.agent.commandDir}
                    onChange={handleChange((current, value) => ({
                      ...current,
                      agent: { ...current.agent, commandDir: String(value) },
                    }))}
                  />
                </label>
                <label>
                  <span>{t("settings.agent.timeout.label")}</span>
                  <small className="muted-text">{t("settings.agent.timeout.help")}</small>
                  <input
                    type="number"
                    value={settings.agent.timeoutMs}
                    onChange={handleChange((current, value) => ({
                      ...current,
                      agent: { ...current.agent, timeoutMs: Number(value) || 0 },
                    }))}
                  />
                </label>
              </div>
            </SettingsSection>

            <SettingsSection
              title={t("settings.llm.title")}
              description={t("settings.llm.description")}
            >
              <div className="form-grid">
                <label className="checkbox-row">
                  <input
                    checked={settings.quality.enabled}
                    type="checkbox"
                    onChange={handleChange((current, value) => ({
                      ...current,
                      quality: { ...current.quality, enabled: Boolean(value) },
                    }))}
                  />
                  <span>{t("settings.llm.enableQuality")}</span>
                </label>
                <label>
                  <span>{t("settings.llm.qualityModel.label")}</span>
                  <small className="muted-text">{t("settings.llm.qualityModel.help")}</small>
                  <input
                    value={settings.quality.modelId}
                    onChange={handleChange((current, value) => ({
                      ...current,
                      quality: { ...current.quality, modelId: String(value) },
                    }))}
                  />
                </label>
                <label>
                  <span>{t("settings.llm.qualityServer.label")}</span>
                  <small className="muted-text">{t("settings.llm.qualityServer.help")}</small>
                  <input
                    value={settings.quality.serverUrl}
                    onChange={handleChange((current, value) => ({
                      ...current,
                      quality: { ...current.quality, serverUrl: String(value) },
                    }))}
                  />
                </label>
                <label>
                  <span>{t("settings.llm.translationModel.label")}</span>
                  <small className="muted-text">{t("settings.llm.translationModel.help")}</small>
                  <input
                    value={settings.translation.modelId}
                    onChange={handleChange((current, value) => ({
                      ...current,
                      translation: { ...current.translation, modelId: String(value) },
                    }))}
                  />
                </label>
                <label>
                  <span>{t("settings.llm.translationServer.label")}</span>
                  <small className="muted-text">{t("settings.llm.translationServer.help")}</small>
                  <input
                    value={settings.translation.serverUrl}
                    onChange={handleChange((current, value) => ({
                      ...current,
                      translation: { ...current.translation, serverUrl: String(value) },
                    }))}
                  />
                </label>
                <label>
                  <span>{t("settings.llm.translationProvider.label")}</span>
                  <small className="muted-text">{t("settings.llm.translationProvider.help")}</small>
                  <input
                    value={settings.translation.providerId}
                    onChange={handleChange((current, value) => ({
                      ...current,
                      translation: { ...current.translation, providerId: String(value) },
                    }))}
                  />
                </label>
              </div>
            </SettingsSection>

            <SettingsSection
              title={t("settings.koharu.title")}
              description={t("settings.koharu.description")}
            >
              <div className="form-grid">
                {runtimeQuery.data?.koharu && (
                  <div className="badge-grid full-span">
                    {statusBadge(
                      t("settings.koharu.runtimeStatus"),
                      runtimeQuery.data.koharu.status,
                      koharuStatusTone(runtimeQuery.data.koharu)
                    )}
                    {statusBadge(
                      t("settings.koharu.runtimeMode"),
                      runtimeQuery.data.koharu.mode || "n/a",
                      "neutral"
                    )}
                    {statusBadge(
                      t("settings.koharu.runtimeVersion"),
                      runtimeQuery.data.koharu.version || "n/a",
                      "neutral"
                    )}
                    {statusBadge(
                      t("settings.koharu.runtimePid"),
                      runtimeQuery.data.koharu.managedPid ? String(runtimeQuery.data.koharu.managedPid) : "n/a",
                      "neutral"
                    )}
                    {runtimeQuery.data.koharu.lastError &&
                      statusBadge(
                        t("settings.koharu.runtimeError"),
                        runtimeQuery.data.koharu.lastError,
                        "bad"
                      )}
                  </div>
                )}
                <div className="button-row full-span">
                  <button
                    className="secondary-button"
                    disabled={koharuAction !== null}
                    onClick={() => void runKoharuAction("start", startKoharuRuntime)}
                    type="button"
                  >
                    {koharuAction === "start"
                      ? t("settings.koharu.starting")
                      : t("settings.koharu.start")}
                  </button>
                  <button
                    className="secondary-button"
                    disabled={koharuAction !== null}
                    onClick={() => void runKoharuAction("prepare", prepareKoharuRuntime)}
                    type="button"
                  >
                    {koharuAction === "prepare"
                      ? t("settings.koharu.preparing")
                      : t("settings.koharu.prepare")}
                  </button>
                  <button
                    className="secondary-button"
                    disabled={koharuAction !== null}
                    onClick={() => void runKoharuAction("stop", stopKoharuRuntime)}
                    type="button"
                  >
                    {koharuAction === "stop"
                      ? t("settings.koharu.stopping")
                      : t("settings.koharu.stop")}
                  </button>
                </div>
                <div className="path-list full-span">
                  <div>
                    <strong>{t("settings.koharu.paths.title")}</strong>
                    <small className="muted-text">{t("settings.koharu.paths.help")}</small>
                  </div>
                  {koharuPathsQuery.isLoading && (
                    <div className="muted-text">{t("settings.koharu.paths.loading")}</div>
                  )}
                  {koharuPathsQuery.isError && (
                    <div className="muted-text">{t("settings.koharu.paths.failed")}</div>
                  )}
                  {koharuPathsQuery.data?.koharu &&
                    [
                      ["dataRoot", koharuPathsQuery.data.koharu.dataRoot],
                      ["projectsRoot", koharuPathsQuery.data.koharu.projectsRoot],
                      ["modelsRoot", koharuPathsQuery.data.koharu.modelsRoot],
                      ["runtimeRoot", koharuPathsQuery.data.koharu.runtimeRoot],
                      ["configPath", koharuPathsQuery.data.koharu.configPath],
                      ["executablePath", koharuPathsQuery.data.koharu.executablePath],
                    ].map(([key, value]) => (
                      <div className="path-row" key={key}>
                        <span>{t(`settings.koharu.paths.${key}`)}</span>
                        <code>{value || t("settings.koharu.paths.unknown")}</code>
                      </div>
                    ))}
                  {koharuPathsQuery.data?.koharu.projectApiError && (
                    <div className="muted-text">
                      {t("settings.koharu.paths.projectApiError", {
                        error: koharuPathsQuery.data.koharu.projectApiError,
                      })}
                    </div>
                  )}
                </div>
                <label>
                  <span>{t("settings.koharu.baseUrl.label")}</span>
                  <small className="muted-text">{t("settings.koharu.baseUrl.help")}</small>
                  <div className="field-with-action">
                    <input
                      value={settings.koharu.baseUrl}
                      onChange={handleChange((current, value) => ({
                        ...current,
                        koharu: { ...current.koharu, baseUrl: String(value) },
                      }))}
                    />
                    <button
                      className="secondary-button"
                      onClick={() =>
                        setSettings((current) =>
                          current
                            ? {
                                ...current,
                                koharu: {
                                  ...current.koharu,
                                  baseUrl:
                                    runtimeQuery.data?.koharu.baseUrl ||
                                    configQuery.data?.api?.baseUrl ||
                                    "http://127.0.0.1:4000",
                                },
                              }
                            : current
                        )
                      }
                      type="button"
                    >
                      {t("settings.koharu.useRuntimeUrl")}
                    </button>
                  </div>
                </label>
                <div className="full-span">
                  <small className="muted-text">
                    {engineCatalogQuery.isLoading && t("settings.koharu.engineCatalog.loading")}
                    {engineCatalogQuery.isError && t("settings.koharu.engineCatalog.failed")}
                  </small>
                </div>
                {ENGINE_KEYS.map((engineKey) => {
                  const options = engineOptionsFor(engineCatalogQuery.data?.engines, engineKey);
                  const currentValue = settings.engines[engineKey] ?? "";
                  const currentMissing = Boolean(
                    currentValue && options.length > 0 && !options.some((option) => option.id === currentValue)
                  );
                  return (
                    <label key={engineKey}>
                      <span>{engineKey}</span>
                      <small className="muted-text">
                        {t("settings.koharu.engineHelp", { engine: engineKey })}
                      </small>
                      <select
                        value={currentValue}
                        onChange={handleChange((current, value) =>
                          updateEngine(current, engineKey, String(value))
                        )}
                      >
                        <option value="">{t("settings.koharu.engineSelect.placeholder")}</option>
                        {currentMissing && (
                          <option value={currentValue}>
                            {t("settings.koharu.engineUnavailable", { engine: currentValue })}
                          </option>
                        )}
                        {options.map((option) => (
                          <option key={option.id} value={option.id}>
                            {formatEngineOption(option)}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
              </div>
            </SettingsSection>
          </article>
        )}
      </div>
      <div className="button-row">
        <button className="primary-button" onClick={handleSave} type="button">
          {t("settings.button.save")}
        </button>
        <button className="secondary-button" onClick={resetToDefaults} type="button">
          {t("settings.button.reset")}
        </button>
      </div>
    </section>
  );
}
