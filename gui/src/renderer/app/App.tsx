import { Component, ErrorInfo, ReactNode, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ROUTES } from "./routes";
import { getRuntimeStatus } from "../api/runtime";
import { translateLiteral } from "../i18n/messages";
import { JobListPage } from "../pages/JobListPage";
import { JobsPage } from "../pages/JobsPage";
import { MangaManagementPage } from "../pages/MangaManagementPage";
import { PostEditPage } from "../pages/PostEditPage";
import { ReferencePage } from "../pages/ReferencePage";
import { SettingsPage } from "../pages/SettingsPage";
import { readSettings } from "../services/desktop_api";
import { useLanguageStore } from "../stores/language_store";
import { useUiStore } from "../stores/ui_store";

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
  const runtimeQuery = useQuery({
    queryKey: ["runtime-status"],
    queryFn: getRuntimeStatus
  });

  useEffect(() => {
    markHydrated();
    readSettings()
      .then((settings) => {
        setLocale(settings.locale || "zh-TW");
      })
      .catch(() => {});
  }, [markHydrated, setLocale]);

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
    <div className={selectedPage === "job-list" ? "app-shell job-list-shell" : "app-shell"}>
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
          <RendererErrorBoundary
            errorTitle={t("app.error.title")}
            errorDescription={t("app.error.description")}
          >
            {renderPage(selectedPage)}
          </RendererErrorBoundary>
        </main>
      </div>
    </div>
  );
}
