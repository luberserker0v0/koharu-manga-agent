import type { DesktopInfo } from "../../../types/settings";

type Translate = (key: string, params?: Record<string, string | number>) => string;

type BackendConnectionSettingsProps = {
  baseUrl: string;
  desktopInfo: DesktopInfo | null;
  onBaseUrlChange: (baseUrl: string) => void;
  t: Translate;
};

export function BackendConnectionSettings({
  baseUrl,
  desktopInfo,
  onBaseUrlChange,
  t,
}: BackendConnectionSettingsProps) {
  return (
    <>
      <div className="form-grid">
        <label className="field full-span">
          <span>{t("settings.backend.baseUrl.label")}</span>
          <small className="muted-text">{t("settings.backend.baseUrl.help")}</small>
          <input
            inputMode="url"
            value={baseUrl}
            onChange={(event) => onBaseUrlChange(event.currentTarget.value)}
          />
        </label>
      </div>
      {desktopInfo && (
        <p className="connection-caption">
          <strong>{t("settings.backend.activeAddress")}</strong>
          <code>{desktopInfo.backendProcess.baseUrl}</code>
          <span className="pill pill-neutral">
            {t(`settings.runtime.backendMode.${desktopInfo.backendProcess.deploymentMode || "unknown"}`)}
          </span>
        </p>
      )}
    </>
  );
}
