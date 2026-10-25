import { useState } from "react";
import {
  executeMaintenanceCleanup,
  previewMaintenanceCleanup,
  type BackendConfig,
  type MaintenanceCleanupResult,
  type MaintenanceCleanupTarget,
} from "../../../api/runtime";

const TARGETS: MaintenanceCleanupTarget[] = ["logs", "translated", "workspaces", "postedit"];
const RETENTION_FIELDS = [
  ["logRetentionDays", 14],
  ["logMaxFiles", 200],
  ["translatedRetentionDays", 30],
  ["workspaceRetentionDays", 30],
  ["postEditRetentionDays", 30],
] as const;
type Translate = (key: string, params?: Record<string, string | number>) => string;

function MaintenanceNumberField(props: {
  field: string;
  value: number;
  min: number;
  step?: number;
  t: Translate;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      <span>{props.t(`settings.maintenance.${props.field}`)}</span>
      <input
        min={props.min}
        step={props.step}
        type="number"
        value={props.value}
        onChange={(event) => props.onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}

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

function MaintenanceDefaultsFields({
  config,
  t,
  updateDefaults,
}: {
  config: BackendConfig;
  t: (key: string, params?: Record<string, string | number>) => string;
  updateDefaults: (key: string, value: number) => void;
}) {
  return (
    <>
      {RETENTION_FIELDS.map(([field, fallback]) => (
        <MaintenanceNumberField
          key={field}
          field={field}
          value={config.defaults?.[field] ?? fallback}
          min={0}
          t={t}
          onChange={(value) => updateDefaults(field, value)}
        />
      ))}
    </>
  );
}

function MaintenanceOptions({
  config,
  t,
  updateCleanup,
}: {
  config: BackendConfig;
  t: (key: string, params?: Record<string, string | number>) => string;
  updateCleanup: (patch: Record<string, boolean | number>) => void;
}) {
  return (
    <>
      <label className="checkbox-field">
        <input
          checked={config.cleanup?.enabled !== false}
          type="checkbox"
          onChange={(event) => updateCleanup({ enabled: event.currentTarget.checked })}
        />
        <span>{t("settings.maintenance.autoEnabled")}</span>
      </label>
      <MaintenanceNumberField
        field="intervalMs"
        min={60000}
        step={60000}
        value={config.cleanup?.intervalMs ?? 3600000}
        t={t}
        onChange={(intervalMs) => updateCleanup({ intervalMs })}
      />
    </>
  );
}

function MaintenanceButtons({
  running,
  t,
  onPreview,
  onExecute,
}: {
  running: "preview" | "execute" | null;
  t: (key: string, params?: Record<string, string | number>) => string;
  onPreview: () => void;
  onExecute: () => void;
}) {
  return (
    <div className="button-row">
      <button className="secondary-button" disabled={running !== null} type="button" onClick={onPreview}>
        {t(running === "preview" ? "settings.maintenance.previewing" : "settings.maintenance.preview")}
      </button>
      <button className="secondary-button" disabled={running !== null} type="button" onClick={onExecute}>
        {t(running === "execute" ? "settings.maintenance.executing" : "settings.maintenance.execute")}
      </button>
    </div>
  );
}

function MaintenancePreview({
  preview,
  t,
}: {
  preview: MaintenanceCleanupResult;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  return (
    <div className="summary-grid">
      {TARGETS.map((target) => {
        const entry = preview.results[target];
        if (!entry) return null;
        return (
          <div key={target}>
            <strong>{t(`settings.maintenance.target.${target}`)}</strong>
            <span>
              {t("settings.maintenance.summary", {
                deleted: entry.deleted,
                freed: formatBytes(entry.freedBytes),
              })}
            </span>
          </div>
        );
      })}
    </div>
  );
}

async function runMaintenancePreview(setters: {
  setPreview: (value: MaintenanceCleanupResult | null) => void;
  setRunning: (value: "preview" | "execute" | null) => void;
  setError: (value: string | null) => void;
  setNotice: (value: string | null) => void;
}) {
  setters.setRunning("preview");
  setters.setError(null);
  setters.setNotice(null);
  try {
    setters.setPreview(await previewMaintenanceCleanup("all"));
  } catch (cause) {
    setters.setError(cause instanceof Error ? cause.message : String(cause));
  } finally {
    setters.setRunning(null);
  }
}

async function runMaintenanceExecute(
  t: (key: string, params?: Record<string, string | number>) => string,
  setters: {
    setPreview: (value: MaintenanceCleanupResult | null) => void;
    setRunning: (value: "preview" | "execute" | null) => void;
    setError: (value: string | null) => void;
    setNotice: (value: string | null) => void;
  },
) {
  if (!window.confirm(t("settings.maintenance.confirm"))) return;
  setters.setRunning("execute");
  setters.setError(null);
  setters.setNotice(null);
  try {
    const result = await executeMaintenanceCleanup({
      targets: ["all"],
      dryRun: false,
    });
    setters.setPreview(result);
    setters.setNotice(t("settings.maintenance.executed"));
  } catch (cause) {
    setters.setError(cause instanceof Error ? cause.message : String(cause));
  } finally {
    setters.setRunning(null);
  }
}

type MaintenanceCleanupProps = {
  config: BackendConfig;
  onConfigChange: (patch: BackendConfig) => void;
  t: Translate;
};

function useMaintenanceState() {
  const [preview, setPreview] = useState<MaintenanceCleanupResult | null>(null);
  const [running, setRunning] = useState<"preview" | "execute" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  return { preview, running, error, notice, setters: { setPreview, setRunning, setError, setNotice } };
}

export function MaintenanceCleanup({ config, onConfigChange, t }: MaintenanceCleanupProps) {
  const state = useMaintenanceState();
  const updateDefaults = (key: string, value: number) => {
    onConfigChange({ defaults: { ...config.defaults, [key]: value } });
  };
  const updateCleanup = (patch: Record<string, boolean | number>) => {
    onConfigChange({ cleanup: { ...config.cleanup, ...patch } });
  };
  return (
    <div className="form-grid">
      <MaintenanceDefaultsFields config={config} t={t} updateDefaults={updateDefaults} />
      <MaintenanceOptions config={config} t={t} updateCleanup={updateCleanup} />
      <MaintenanceButtons
        onExecute={() => void runMaintenanceExecute(t, state.setters)}
        onPreview={() => void runMaintenancePreview(state.setters)}
        running={state.running}
        t={t}
      />
      {state.error && <p className="muted-text">{state.error}</p>}
      {state.notice && <p className="muted-text">{state.notice}</p>}
      {state.preview && <MaintenancePreview preview={state.preview} t={t} />}
    </div>
  );
}
