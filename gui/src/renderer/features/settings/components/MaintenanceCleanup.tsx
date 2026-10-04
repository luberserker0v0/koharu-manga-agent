import { useState } from "react";
import {
  executeMaintenanceCleanup, previewMaintenanceCleanup,
  type BackendConfig, type MaintenanceCleanupResult, type MaintenanceCleanupTarget,
} from "../../../api/runtime";

const TARGETS: MaintenanceCleanupTarget[] = ["logs", "translated", "workspaces", "postedit"];

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function MaintenanceCleanup({ config, onConfigChange, t }: {
  config: BackendConfig;
  onConfigChange: (patch: BackendConfig) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const [preview, setPreview] = useState<MaintenanceCleanupResult | null>(null);
  const [running, setRunning] = useState<"preview" | "execute" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const updateDefaults = (key: string, value: number) => {
    onConfigChange({ defaults: { ...config.defaults, [key]: value } });
  };
  const updateCleanup = (patch: Record<string, boolean | number>) => {
    onConfigChange({ cleanup: { ...config.cleanup, ...patch } });
  };

  const runPreview = async () => {
    setRunning("preview");
    setError(null);
    setNotice(null);
    try {
      setPreview(await previewMaintenanceCleanup("all"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(null);
    }
  };

  const runExecute = async () => {
    if (!window.confirm(t("settings.maintenance.confirm"))) return;
    setRunning("execute");
    setError(null);
    setNotice(null);
    try {
      const result = await executeMaintenanceCleanup({ targets: ["all"], dryRun: false });
      setPreview(result);
      setNotice(t("settings.maintenance.executed"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="form-grid">
      <label className="field"><span>{t("settings.maintenance.logRetentionDays")}</span>
        <input min={0} type="number" value={config.defaults?.logRetentionDays ?? 14}
          onChange={(event) => updateDefaults("logRetentionDays", Number(event.currentTarget.value))} />
      </label>
      <label className="field"><span>{t("settings.maintenance.logMaxFiles")}</span>
        <input min={0} type="number" value={config.defaults?.logMaxFiles ?? 200}
          onChange={(event) => updateDefaults("logMaxFiles", Number(event.currentTarget.value))} />
      </label>
      <label className="field"><span>{t("settings.maintenance.translatedRetentionDays")}</span>
        <input min={0} type="number" value={config.defaults?.translatedRetentionDays ?? 30}
          onChange={(event) => updateDefaults("translatedRetentionDays", Number(event.currentTarget.value))} />
      </label>
      <label className="field"><span>{t("settings.maintenance.workspaceRetentionDays")}</span>
        <input min={0} type="number" value={config.defaults?.workspaceRetentionDays ?? 30}
          onChange={(event) => updateDefaults("workspaceRetentionDays", Number(event.currentTarget.value))} />
      </label>
      <label className="field"><span>{t("settings.maintenance.postEditRetentionDays")}</span>
        <input min={0} type="number" value={config.defaults?.postEditRetentionDays ?? 30}
          onChange={(event) => updateDefaults("postEditRetentionDays", Number(event.currentTarget.value))} />
      </label>
      <label className="checkbox-field"><input checked={config.cleanup?.enabled !== false} type="checkbox"
        onChange={(event) => updateCleanup({ enabled: event.currentTarget.checked })} />
        <span>{t("settings.maintenance.autoEnabled")}</span>
      </label>
      <label className="field"><span>{t("settings.maintenance.intervalMs")}</span>
        <input min={60000} step={60000} type="number" value={config.cleanup?.intervalMs ?? 3600000}
          onChange={(event) => updateCleanup({ intervalMs: Number(event.currentTarget.value) })} />
      </label>
      <div className="button-row">
        <button className="secondary-button" disabled={running !== null} type="button" onClick={() => void runPreview()}>
          {t(running === "preview" ? "settings.maintenance.previewing" : "settings.maintenance.preview")}
        </button>
        <button className="secondary-button" disabled={running !== null} type="button" onClick={() => void runExecute()}>
          {t(running === "execute" ? "settings.maintenance.executing" : "settings.maintenance.execute")}
        </button>
      </div>
      {error && <p className="muted-text">{error}</p>}
      {notice && <p className="muted-text">{notice}</p>}
      {preview && <div className="summary-grid">
        {TARGETS.map((target) => {
          const entry = preview.results[target];
          if (!entry) return null;
          return <div key={target}>
            <strong>{t(`settings.maintenance.target.${target}`)}</strong>
            <span>{t("settings.maintenance.summary", { deleted: entry.deleted, freed: formatBytes(entry.freedBytes) })}</span>
          </div>;
        })}
      </div>}
    </div>
  );
}
