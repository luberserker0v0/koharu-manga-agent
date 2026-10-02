import { Component, ErrorInfo, ReactNode, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
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
  getDesktopInfo, installAndStartKoharuHost, pickFile, readSettings, startKoharuHost, writeSettings,
} from "../services/desktop_api";
import { useLanguageStore } from "../stores/language_store";
import { useUiStore } from "../stores/ui_store";
import type { GuiSettings } from "../types/settings";

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

type RendererErrorBoundaryState = {
  error: Error | null;
};

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
  {
    children: ReactNode;
    errorTitle: string;
    errorDescription: string;
  },
  RendererErrorBoundaryState
> {
  state: RendererErrorBoundaryState = {
    error: null,
  };

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

export function App() {
  const markHydrated = useUiStore((state) => state.markHydrated);
  const selectedPage = useUiStore((state) => state.selectedPage);
  const setSelectedPage = useUiStore((state) => state.setSelectedPage);
  const setLocale = useLanguageStore((state) => state.setLocale);
  const t = useLanguageStore((state) => state.t);
  const locale = useLanguageStore((state) => state.locale);
  const [settings, setSettings] = useState<GuiSettings | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryDownloading, setRecoveryDownloading] = useState(false);
  const [recoveryDismissed, setRecoveryDismissed] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const autoRecoveryAttempted = useRef(false);
  const runtimeQuery = useQuery({
    queryKey: ["runtime-status"],
    queryFn: getRuntimeStatus
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
  const koharuUnavailable = readinessQuery.data
    ? !readinessQuery.data.capabilities.koharuJobs
    : desktopInfoQuery.data?.koharuProcess.status !== "running";
  const koharuFailureDetail = readinessQuery.data?.blockers.find((item) => item.service === "koharu")?.message
    || desktopInfoQuery.data?.koharuProcess.note
    || "";

  useEffect(() => {
    markHydrated();
    readSettings()
      .then((settings) => {
        setSettings(settings);
        setLocale(settings.locale || "zh-TW");
      })
      .catch(() => {});
  }, [markHydrated, setLocale]);

  const refreshRuntimeState = async () => {
    await Promise.allSettled([
      desktopInfoQuery.refetch(),
      readinessQuery.refetch(),
      runtimeQuery.refetch(),
    ]);
  };

  const startConfiguredExecutable = async (executablePath: string, persist: boolean) => {
    setRecoveryBusy(true);
    setRecoveryError("");
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
      setRecoveryError(error instanceof Error ? error.message : String(error));
      await refreshRuntimeState();
    } finally {
      setRecoveryBusy(false);
    }
  };

  const chooseAndStartKoharu = async () => {
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

  const downloadAndStartKoharu = async () => {
    setRecoveryBusy(true);
    setRecoveryDownloading(true);
    setRecoveryError("");
    try {
      const processState = await installAndStartKoharuHost();
      if (!processState.executablePath) {
        throw new Error(t("app.koharuRecovery.downloadMissingPath"));
      }
      const saved = await writeSettings({
        ...(settings || {}),
        koharuExecutablePath: processState.executablePath,
        koharuAutoStart: true,
      });
      setSettings(saved);
      await refreshRuntimeState();
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : String(error));
      await refreshRuntimeState();
    } finally {
      setRecoveryDownloading(false);
      setRecoveryBusy(false);
    }
  };

  useEffect(() => {
    if (!koharuUnavailable) {
      autoRecoveryAttempted.current = false;
      setRecoveryDismissed(false);
      setRecoveryError("");
      return;
    }
    if (
      autoRecoveryAttempted.current ||
      recoveryBusy ||
      !settings?.koharuAutoStart ||
      !settings.koharuExecutablePath.trim() ||
      desktopInfoQuery.data?.koharuProcess.status === "checking"
    ) {
      return;
    }
    autoRecoveryAttempted.current = true;
    void startConfiguredExecutable(settings.koharuExecutablePath, false);
  }, [desktopInfoQuery.data?.koharuProcess.status, koharuUnavailable, recoveryBusy, settings]);

  const statusSummary = useMemo(() => {
    if (runtimeQuery.isLoading) {
      return t("status.loadingRuntime");
    }
    if (runtimeQuery.isError) {
      return t("status.runtimeUnavailable");
    }
    if (!runtimeQuery.data) {
      return t("status.runtimeUnavailable");
    }
    return t("status.backendAgent", {
      backend: runtimeQuery.data.backend.status,
      koharu: runtimeQuery.data.koharu.status,
      agent: runtimeQuery.data.agent.status,
    });
  }, [runtimeQuery.data, runtimeQuery.isError, runtimeQuery.isLoading, t]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t("app.brand");

    const root = document.getElementById("root");
    if (!root) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      applyLiteralTranslations(root, locale);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [locale, selectedPage, t]);

  return (
    <div className={selectedPage === "job-list" ? "app-shell job-list-shell" : selectedPage === "post-edit" ? "app-shell post-edit-shell" : selectedPage === "reference" ? "app-shell reference-shell" : "app-shell"}>
      <header className="top-status-bar">
        <div className="brand">{t("app.brand")}</div>
        <div className="status-summary">{statusSummary}</div>
      </header>
      <div className="app-body">
        <aside className="left-navigation">
          {ROUTES.map((route) => (
            <button
              key={route.key}
              className={route.key === selectedPage ? "nav-button active" : "nav-button"}
              onClick={() => setSelectedPage(route.key)}
              title={t(route.labelKey)}
              type="button"
            >
              {t(route.labelKey)}
            </button>
          ))}
        </aside>
        <main className="main-content">
          {koharuUnavailable && (readinessQuery.data || desktopInfoQuery.data?.koharuProcess) && (
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
          )}
          <RendererErrorBoundary
            errorTitle={t("app.error.title")}
            errorDescription={t("app.error.description")}
          >
            {renderPage(selectedPage)}
          </RendererErrorBoundary>
        </main>
      </div>
      {koharuUnavailable && settings && !recoveryDismissed && (
        <KoharuRecoveryDialog
          busy={recoveryBusy}
          configuredPath={settings.koharuExecutablePath}
          downloading={recoveryDownloading}
          error={recoveryBusy ? "" : recoveryError || koharuFailureDetail}
          onChooseAndStart={() => void chooseAndStartKoharu()}
          onDownloadAndStart={() => void downloadAndStartKoharu()}
          onDismissForManualStart={() => setRecoveryDismissed(true)}
          onOpenSettings={() => {
            setRecoveryDismissed(true);
            setSelectedPage("settings");
          }}
          onRetry={() => void startConfiguredExecutable(settings.koharuExecutablePath, false)}
          t={t}
        />
      )}
    </div>
  );
}
