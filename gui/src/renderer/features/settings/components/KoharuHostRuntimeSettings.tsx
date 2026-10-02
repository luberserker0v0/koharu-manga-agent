import type { KoharuHostProcessState } from "../../../types/settings";

type Translate = (key: string, params?: Record<string, string | number>) => string;

type Props = {
  autoStart: boolean;
  executablePath: string;
  process: KoharuHostProcessState | null;
  onAutoStartChange: (enabled: boolean) => void;
  onExecutablePathChange: (value: string) => void;
  onBrowse: () => void;
  t: Translate;
};

export function KoharuHostRuntimeSettings({
  autoStart,
  executablePath,
  process,
  onAutoStartChange,
  onExecutablePathChange,
  onBrowse,
  t,
}: Props) {
  const tone = process?.status === "running" ? "good" : process?.status === "failed" ? "bad" : "warn";
  return (
    <div className="form-grid">
      <label className="field full-span">
        <span>{t("settings.koharu.host.executable.label")}</span>
        <small className="muted-text">{t("settings.koharu.host.executable.help")}</small>
        <div className="field-with-button">
          <input
            value={executablePath}
            onChange={(event) => onExecutablePathChange(event.currentTarget.value)}
          />
          <button className="secondary-button" type="button" onClick={onBrowse}>
            {t("settings.koharu.host.executable.browse")}
          </button>
        </div>
      </label>
      <label className="checkbox-field full-span">
        <input
          checked={autoStart}
          type="checkbox"
          onChange={(event) => onAutoStartChange(event.currentTarget.checked)}
        />
        <span>{t("settings.koharu.host.autoStart.label")}</span>
      </label>
      <small className="muted-text full-span">{t("settings.koharu.host.autoStart.help")}</small>
      {process && (
        <div className={`status-badge status-${tone} full-span`}>
          <strong>{t("settings.koharu.host.status.label")}</strong>
          <span>
            {t(`settings.koharu.host.status.${process.status}`)} · {process.baseUrl}
            {process.pid ? ` · PID ${process.pid}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
