type Translate = (key: string, params?: Record<string, string | number>) => string;

type Props = {
  busy: boolean;
  configuredPath: string;
  downloading: boolean;
  error: string;
  onChooseAndStart: () => void;
  onDownloadAndStart: () => void;
  onDismissForManualStart: () => void;
  onOpenSettings: () => void;
  onRetry: () => void;
  t: Translate;
};

export function KoharuRecoveryDialog({
  busy,
  configuredPath,
  downloading,
  error,
  onChooseAndStart,
  onDownloadAndStart,
  onDismissForManualStart,
  onOpenSettings,
  onRetry,
  t,
}: Props) {
  return (
    <div className="runtime-dialog-backdrop">
      <section aria-labelledby="koharu-recovery-title" aria-modal="true" className="runtime-dialog" role="dialog">
        <div className="runtime-dialog-heading">
          <div>
            <span className="eyebrow">{t("app.koharuRecovery.eyebrow")}</span>
            <h2 id="koharu-recovery-title">{t("app.koharuRecovery.title")}</h2>
          </div>
          <span className="pill pill-warn">{t("app.koharuRecovery.blocked")}</span>
        </div>
        <p>{t("app.koharuRecovery.description")}</p>

        {configuredPath && (
          <div className="runtime-dialog-path">
            <strong>{t("app.koharuRecovery.configuredPath")}</strong>
            <code>{configuredPath}</code>
          </div>
        )}

        {error && <p className="error-text" role="status">{error}</p>}
        {busy && <p className="muted-text" role="status">
          {t(downloading ? "app.koharuRecovery.downloading" : "app.koharuRecovery.starting")}
        </p>}

        <div className="runtime-dialog-options">
          <article>
            <h3>{t("app.koharuRecovery.managed.title")}</h3>
            <p className="muted-text">{t("app.koharuRecovery.managed.description")}</p>
            <div className="button-row">
              <button className="primary-button" disabled={busy} type="button" onClick={onDownloadAndStart}>
                {t("app.koharuRecovery.downloadAndStart")}
              </button>
              <button className="secondary-button" disabled={busy} type="button" onClick={onChooseAndStart}>
                {t("app.koharuRecovery.chooseAndStart")}
              </button>
              {configuredPath && (
                <button className="secondary-button" disabled={busy} type="button" onClick={onRetry}>
                  {t("app.koharuRecovery.retry")}
                </button>
              )}
            </div>
          </article>
          <article>
            <h3>{t("app.koharuRecovery.manual.title")}</h3>
            <p className="muted-text">{t("app.koharuRecovery.manual.description")}</p>
            <code className="runtime-dialog-command">koharu.exe --headless --host 0.0.0.0 --port 4000</code>
            <button className="secondary-button" disabled={busy} type="button" onClick={onDismissForManualStart}>
              {t("app.koharuRecovery.manual.action")}
            </button>
          </article>
        </div>

        <button className="secondary-button" disabled={busy} type="button" onClick={onOpenSettings}>
          {t("app.koharuRecovery.openSettings")}
        </button>
      </section>
    </div>
  );
}
