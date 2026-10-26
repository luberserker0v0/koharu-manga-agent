import { Component, ErrorInfo, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ROUTES } from "./routes";
import { getBackendReadiness, getRuntimeStatus } from "../api/runtime";
import { translateLiteral } from "../i18n/messages";
import { JobListPage } from "../pages/JobListPage";
import { JobsPage } from "../pages/JobsPage";
import { MangaManagementPage } from "../pages/MangaManagementPage";
import { PostEditPage } from "../pages/PostEditPage";
import { ReferencePage } from "../pages/ReferencePage";
import { SettingsPage } from "../pages/SettingsPage";
import { KoharuRecoveryDialog } from "../features/runtime/components/KoharuRecoveryDialog";
import {
  getDesktopInfo,
  installAndStartKoharuHost,
  pickFile,
  readSettings,
  startKoharuHost,
  writeSettings,
} from "../services/desktop_api";
import { useLanguageStore } from "../stores/language_store";
import { useUiStore } from "../stores/ui_store";
import type { GuiSettings } from "../types/settings";
import { useExportDelivery, type ExportDeliveryNotice } from "../features/jobs/hooks/useExportDelivery";

function renderPage(routeKey: string) {
  switch (routeKey) {
    case "settings":
      return <SettingsPage />;
    case "job-list":
      return <JobListPage />;
    case "manga":
      return <MangaManagementPage />;
    case "reference":
      return <ReferencePage />;
    case "post-edit":
      return <PostEditPage />;
    case "job":
    default:
      return <JobsPage />;
  }
}

type RendererErrorBoundaryState = { error: Error | null };

function applyLiteralTranslations(root: HTMLElement, locale: "zh-TW" | "en-US") {
  const blockedTags = new Set(["SCRIPT", "STYLE", "CODE", "PRE", "TEXTAREA"]);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    const parent = current.parentElement;
    if (parent && !blockedTags.has(parent.tagName)) {
      const raw = current.textContent ?? "";
      const trimmed = raw.trim();
      if (trimmed) {
        const translated = translateLiteral(locale, trimmed);
        if (translated !== trimmed) {
          current.textContent = raw.replace(trimmed, translated);
        }
      }
    }
    current = walker.nextNode();
  }

  root.querySelectorAll<HTMLElement>("[placeholder],[title]").forEach((element) => {
    const placeholder = element.getAttribute("placeholder");
    if (placeholder) {
      element.setAttribute("placeholder", translateLiteral(locale, placeholder));
    }
    const title = element.getAttribute("title");
    if (title) {
      element.setAttribute("title", translateLiteral(locale, title));
    }
  });
}

class RendererErrorBoundary extends Component<
  { children: ReactNode; errorTitle: string; errorDescription: string },
  RendererErrorBoundaryState
> {
  state: RendererErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RendererErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Renderer crashed:", error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return (
        <section className="page">
          <article className="card">
            <h1>{this.props.errorTitle}</h1>
            <p className="error-text">{this.state.error.message}</p>
            <p className="muted-text">{this.props.errorDescription}</p>
            <pre>{this.state.error.stack}</pre>
          </article>
        </section>
      );
    }
    return this.props.children;
  }
}

function useAppSettings(setLocale: (locale: any) => void, markHydrated: () => void) {
  const [settings, setSettings] = useState<GuiSettings | null>(null);
  useEffect(() => {
    markHydrated();
    readSettings()
      .then((loadedSettings) => {
        setSettings(loadedSettings);
        setLocale(loadedSettings.locale || "zh-TW");
      })
      .catch(() => {});
  }, [markHydrated, setLocale]);
  return { settings, setSettings };
}

function useAppQueries() {
  const runtimeQuery = useQuery({
    queryKey: ["runtime-status"],
    queryFn: getRuntimeStatus,
  });
  const desktopInfoQuery = useQuery({
    queryKey: ["desktop-info"],
    queryFn: getDesktopInfo,
    refetchInterval: 10_000,
    retry: false,
  });
  const readinessQuery = useQuery({
    queryKey: ["backend-readiness"],
    queryFn: getBackendReadiness,
    refetchInterval: 10_000,
    retry: false,
  });
  return { runtimeQuery, desktopInfoQuery, readinessQuery };
}

type RecoveryState = {
  recoveryBusy: boolean;
  setRecoveryBusy: (value: boolean) => void;
  recoveryDownloading: boolean;
  setRecoveryDownloading: (value: boolean) => void;
  recoveryDismissed: boolean;
  setRecoveryDismissed: (value: boolean) => void;
  recoveryError: string;
  setRecoveryError: (value: string) => void;
};

function useRecoveryState(): RecoveryState {
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryDownloading, setRecoveryDownloading] = useState(false);
  const [recoveryDismissed, setRecoveryDismissed] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  return {
    recoveryBusy,
    setRecoveryBusy,
    recoveryDownloading,
    setRecoveryDownloading,
    recoveryDismissed,
    setRecoveryDismissed,
    recoveryError,
    setRecoveryError,
  };
}

function useRefreshRuntimeState(
  desktopInfoQuery: ReturnType<typeof useAppQueries>["desktopInfoQuery"],
  readinessQuery: ReturnType<typeof useAppQueries>["readinessQuery"],
  runtimeQuery: ReturnType<typeof useAppQueries>["runtimeQuery"],
) {
  return async () => {
    await Promise.allSettled([desktopInfoQuery.refetch(), readinessQuery.refetch(), runtimeQuery.refetch()]);
  };
}

function useStartConfiguredExecutable(
  settings: GuiSettings | null,
  setSettings: (value: GuiSettings | null) => void,
  recovery: RecoveryState,
  refreshRuntimeState: () => Promise<void>,
) {
  return async (executablePath: string, persist: boolean) => {
    recovery.setRecoveryBusy(true);
    recovery.setRecoveryError("");
    try {
      if (persist && settings) {
        const saved = await writeSettings({
          ...settings,
          koharuExecutablePath: executablePath,
          koharuAutoStart: true,
        });
        setSettings(saved);
      }
      await startKoharuHost(executablePath);
      await refreshRuntimeState();
    } catch (error) {
      recovery.setRecoveryError(error instanceof Error ? error.message : String(error));
      await refreshRuntimeState();
    } finally {
      recovery.setRecoveryBusy(false);
    }
  };
}

function useChooseAndStartKoharu(
  t: ReturnType<typeof useLanguageStore.getState>["t"],
  settings: GuiSettings | null,
  startConfiguredExecutable: (executablePath: string, persist: boolean) => Promise<void>,
  setRecoveryError: (value: string) => void,
) {
  return async () => {
    try {
      const result = await pickFile({
        title: t("app.koharuRecovery.fileDialogTitle"),
        defaultPath: settings?.koharuExecutablePath || undefined,
        extensions: ["exe"],
      });
      if (!result.canceled && result.path) {
        await startConfiguredExecutable(result.path, true);
      }
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : String(error));
    }
  };
}

function useDownloadAndStartKoharu(
  settings: GuiSettings | null,
  setSettings: (value: GuiSettings | null) => void,
  recovery: RecoveryState,
  refreshRuntimeState: () => Promise<void>,
  t: ReturnType<typeof useLanguageStore.getState>["t"],
) {
  return async () => {
    recovery.setRecoveryBusy(true);
    recovery.setRecoveryDownloading(true);
    recovery.setRecoveryError("");
    try {
      const processState = await installAndStartKoharuHost();
      if (!processState.executablePath) {
        throw new Error(t("app.koharuRecovery.downloadMissingPath"));
      }
      await saveKoharuSettings(settings, processState.executablePath, setSettings);
      await refreshRuntimeState();
    } catch (error) {
      recovery.setRecoveryError(error instanceof Error ? error.message : String(error));
      await refreshRuntimeState();
    } finally {
      recovery.setRecoveryDownloading(false);
      recovery.setRecoveryBusy(false);
    }
  };
}

async function saveKoharuSettings(
  settings: GuiSettings | null,
  executablePath: string,
  setSettings: (value: GuiSettings | null) => void,
) {
  const saved = await writeSettings({
    ...(settings || {}),
    koharuExecutablePath: executablePath,
    koharuAutoStart: true,
  });
  setSettings(saved);
}

function shouldAutoRecover(
  status: string | undefined,
  unavailable: boolean,
  attempted: boolean,
  busy: boolean,
  settings: GuiSettings | null,
) {
  return (
    unavailable &&
    !attempted &&
    !busy &&
    Boolean(settings?.koharuAutoStart) &&
    Boolean(settings?.koharuExecutablePath.trim()) &&
    status !== "checking"
  );
}

function useAutoRecoveryEffect(
  desktopInfoQuery: ReturnType<typeof useAppQueries>["desktopInfoQuery"],
  koharuUnavailable: boolean,
  recovery: RecoveryState,
  settings: GuiSettings | null,
  startConfiguredExecutable: (executablePath: string, persist: boolean) => Promise<void>,
) {
  const autoRecoveryAttempted = useRef(false);
  useEffect(() => {
    if (!koharuUnavailable) {
      autoRecoveryAttempted.current = false;
      recovery.setRecoveryDismissed(false);
      recovery.setRecoveryError("");
      return;
    }
    const status = desktopInfoQuery.data?.koharuProcess.status;
    if (!shouldAutoRecover(status, koharuUnavailable, autoRecoveryAttempted.current, recovery.recoveryBusy, settings))
      return;
    autoRecoveryAttempted.current = true;
    void startConfiguredExecutable(settings?.koharuExecutablePath || "", false);
  }, [
    desktopInfoQuery.data?.koharuProcess.status,
    koharuUnavailable,
    recovery.recoveryBusy,
    settings,
    startConfiguredExecutable,
    recovery,
  ]);
}

function useStatusSummary(
  runtimeQuery: ReturnType<typeof useAppQueries>["runtimeQuery"],
  t: ReturnType<typeof useLanguageStore.getState>["t"],
) {
  return useMemo(() => {
    if (runtimeQuery.isLoading) return t("status.loadingRuntime");
    if (runtimeQuery.isError) return t("status.runtimeUnavailable");
    if (!runtimeQuery.data) return t("status.runtimeUnavailable");
    return t("status.backendAgent", {
      backend: runtimeQuery.data.backend.status,
      koharu: runtimeQuery.data.koharu.status,
      agent: runtimeQuery.data.agent.status,
    });
  }, [runtimeQuery.data, runtimeQuery.isError, runtimeQuery.isLoading, t]);
}

function useLiteralTranslationEffect(
  locale: string,
  selectedPage: string,
  t: ReturnType<typeof useLanguageStore.getState>["t"],
) {
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t("app.brand");
    const root = document.getElementById("root");
    if (!root) return;
    const frameId = window.requestAnimationFrame(() => {
      applyLiteralTranslations(root, locale as "zh-TW" | "en-US");
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [locale, selectedPage, t]);
}

type AppLayoutProps = {
  selectedPage: string;
  setSelectedPage: (page: any) => void;
  t: ReturnType<typeof useLanguageStore.getState>["t"];
  statusSummary: string;
  koharuUnavailable: boolean;
  koharuFailureDetail: string;
  settings: GuiSettings | null;
  recovery: RecoveryState;
  desktopInfoQuery: ReturnType<typeof useAppQueries>["desktopInfoQuery"];
  readinessQuery: ReturnType<typeof useAppQueries>["readinessQuery"];
  chooseAndStartKoharu: () => Promise<void>;
  downloadAndStartKoharu: () => Promise<void>;
  startConfiguredExecutable: (executablePath: string, persist: boolean) => Promise<void>;
  exportDeliveryNotice: ExportDeliveryNotice | null;
  dismissExportDelivery: () => void;
};

function ExportDeliveryAlert(props: Pick<AppLayoutProps, "exportDeliveryNotice" | "dismissExportDelivery" | "t">) {
  const notice = props.exportDeliveryNotice;
  if (!notice) return null;
  const success = notice.tone === "success";
  return (
    <div className="service-alert" role={success ? "status" : "alert"}>
      <div><strong>{props.t(success ? "app.exportDelivery.completed" : "app.exportDelivery.failed")}</strong>
        <span>{props.t(success ? "app.exportDelivery.saved" : "app.exportDelivery.failedDetail",
          { fileName: notice.fileName, detail: notice.detail })}</span></div>
      <button className="secondary-button" type="button" onClick={props.dismissExportDelivery}>
        {props.t("app.exportDelivery.dismiss")}
      </button>
    </div>
  );
}

function AppServiceAlert({
  koharuFailureDetail,
  t,
  setSelectedPage,
}: {
  koharuFailureDetail: string;
  t: ReturnType<typeof useLanguageStore.getState>["t"];
  setSelectedPage: (page: string) => void;
}) {
  return (
    <div className="service-alert" role="alert">
      <div>
        <strong>{t("app.koharuWarning.title")}</strong>
        <span>
          {koharuFailureDetail
            ? t("app.koharuWarning.failed", { detail: koharuFailureDetail })
            : t("app.koharuWarning.unavailable")}
        </span>
      </div>
      <button className="secondary-button" type="button" onClick={() => setSelectedPage("settings")}>
        {t("app.koharuWarning.openSettings")}
      </button>
    </div>
  );
}

function AppRecoveryDialog(props: {
  koharuUnavailable: boolean;
  settings: GuiSettings | null;
  recovery: RecoveryState;
  koharuFailureDetail: string;
  t: ReturnType<typeof useLanguageStore.getState>["t"];
  setSelectedPage: (page: string) => void;
  chooseAndStartKoharu: () => Promise<void>;
  downloadAndStartKoharu: () => Promise<void>;
  startConfiguredExecutable: (executablePath: string, persist: boolean) => Promise<void>;
}) {
  if (!props.koharuUnavailable || !props.settings || props.recovery.recoveryDismissed) return null;
  return (
    <KoharuRecoveryDialog
      busy={props.recovery.recoveryBusy}
      configuredPath={props.settings.koharuExecutablePath}
      downloading={props.recovery.recoveryDownloading}
      error={props.recovery.recoveryBusy ? "" : props.recovery.recoveryError || props.koharuFailureDetail}
      onChooseAndStart={() => void props.chooseAndStartKoharu()}
      onDownloadAndStart={() => void props.downloadAndStartKoharu()}
      onDismissForManualStart={() => props.recovery.setRecoveryDismissed(true)}
      onOpenSettings={() => {
        props.recovery.setRecoveryDismissed(true);
        props.setSelectedPage("settings");
      }}
      onRetry={() => void props.startConfiguredExecutable(props.settings!.koharuExecutablePath, false)}
      t={props.t}
    />
  );
}

function AppLayout(props: AppLayoutProps) {
  return (
    <div className={appShellClass(props.selectedPage)}>
      <header className="top-status-bar">
        <div className="brand">{props.t("app.brand")}</div>
        <div className="status-summary">{props.statusSummary}</div>
      </header>
      <div className="app-body">
        <AppNavigation {...props} />
        <AppMain {...props} />
      </div>
      <AppRecoveryDialog {...props} />
    </div>
  );
}

function appShellClass(page: string) {
  const suffix =
    page === "job-list"
      ? "job-list-shell"
      : page === "post-edit"
        ? "post-edit-shell"
        : page === "reference"
          ? "reference-shell"
          : "";
  return `app-shell${suffix ? ` ${suffix}` : ""}`;
}

function AppNavigation(props: AppLayoutProps) {
  return (
    <aside className="left-navigation">
      {ROUTES.map((route) => (
        <button
          key={route.key}
          className={route.key === props.selectedPage ? "nav-button active" : "nav-button"}
          onClick={() => props.setSelectedPage(route.key)}
          title={props.t(route.labelKey)}
          type="button"
        >
          {props.t(route.labelKey)}
        </button>
      ))}
    </aside>
  );
}

function AppMain(props: AppLayoutProps) {
  const showAlert =
    props.koharuUnavailable && (props.readinessQuery.data || props.desktopInfoQuery.data?.koharuProcess);
  return (
    <main className="main-content">
      <ExportDeliveryAlert {...props} />
      {showAlert && (
        <AppServiceAlert
          koharuFailureDetail={props.koharuFailureDetail}
          t={props.t}
          setSelectedPage={props.setSelectedPage}
        />
      )}
      <RendererErrorBoundary
        errorTitle={props.t("app.error.title")}
        errorDescription={props.t("app.error.description")}
      >
        {renderPage(props.selectedPage)}
      </RendererErrorBoundary>
    </main>
  );
}

function useAppStores() {
  const selectedPage = useUiStore((state) => state.selectedPage);
  const setSelectedPage = useUiStore((state) => state.setSelectedPage);
  const markHydrated = useUiStore((state) => state.markHydrated);
  const setLocale = useLanguageStore((state) => state.setLocale);
  const t = useLanguageStore((state) => state.t);
  const locale = useLanguageStore((state) => state.locale);
  return { selectedPage, setSelectedPage, markHydrated, setLocale, t, locale };
}

function useKoharuRecoveryActions(
  settings: GuiSettings | null,
  setSettings: (value: GuiSettings | null) => void,
  queries: ReturnType<typeof useAppQueries>,
  recovery: RecoveryState,
  t: ReturnType<typeof useLanguageStore.getState>["t"],
) {
  const refresh = useRefreshRuntimeState(queries.desktopInfoQuery, queries.readinessQuery, queries.runtimeQuery);
  const start = useStartConfiguredExecutable(settings, setSettings, recovery, refresh);
  const choose = useChooseAndStartKoharu(t, settings, start, recovery.setRecoveryError);
  const download = useDownloadAndStartKoharu(settings, setSettings, recovery, refresh, t);
  return { startConfiguredExecutable: start, chooseAndStartKoharu: choose, downloadAndStartKoharu: download };
}

function resolveKoharuState(queries: ReturnType<typeof useAppQueries>) {
  const { readinessQuery, desktopInfoQuery } = queries;
  const unavailable = readinessQuery.data
    ? !readinessQuery.data.capabilities.koharuJobs
    : desktopInfoQuery.data?.koharuProcess.status !== "running";
  const detail =
    readinessQuery.data?.blockers.find((item) => item.service === "koharu")?.message ||
    desktopInfoQuery.data?.koharuProcess.note ||
    "";
  return { unavailable, detail };
}

type AppViewProps = {
  stores: ReturnType<typeof useAppStores>;
  settings: GuiSettings | null;
  queries: ReturnType<typeof useAppQueries>;
  recovery: RecoveryState;
  actions: ReturnType<typeof useKoharuRecoveryActions>;
  koharu: ReturnType<typeof resolveKoharuState>;
  statusSummary: string;
  exportDelivery: ReturnType<typeof useExportDelivery>;
};

function AppView(props: AppViewProps) {
  return (
    <AppLayout
      selectedPage={props.stores.selectedPage}
      setSelectedPage={props.stores.setSelectedPage}
      t={props.stores.t}
      statusSummary={props.statusSummary}
      exportDeliveryNotice={props.exportDelivery.notice}
      dismissExportDelivery={props.exportDelivery.dismiss}
      koharuUnavailable={props.koharu.unavailable}
      koharuFailureDetail={props.koharu.detail}
      settings={props.settings}
      recovery={props.recovery}
      desktopInfoQuery={props.queries.desktopInfoQuery}
      readinessQuery={props.queries.readinessQuery}
      {...props.actions}
    />
  );
}

export function App() {
  const stores = useAppStores();
  const { settings, setSettings } = useAppSettings(stores.setLocale, stores.markHydrated);
  const queries = useAppQueries();
  const recovery = useRecoveryState();
  const actions = useKoharuRecoveryActions(settings, setSettings, queries, recovery, stores.t);
  const koharu = resolveKoharuState(queries);
  const exportDelivery = useExportDelivery();
  useAutoRecoveryEffect(
    queries.desktopInfoQuery,
    koharu.unavailable,
    recovery,
    settings,
    actions.startConfiguredExecutable,
  );
  const statusSummary = useStatusSummary(queries.runtimeQuery, stores.t);
  useLiteralTranslationEffect(stores.locale, stores.selectedPage, stores.t);
  return <AppView {...{ stores, settings, queries, recovery, actions, koharu, statusSummary, exportDelivery }} />;
}
