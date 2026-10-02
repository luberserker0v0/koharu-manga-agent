import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { shellPaths } from "./shell_paths";

export type GuiSettings = {
  schemaVersion: 4;
  updatedAt: string;
  locale: "zh-TW" | "en-US";
  backendBaseUrl: string;
  koharuExecutablePath: string;
  koharuAutoStart: boolean;
  sourceFolder: string;
  outputFolder: string;
  referenceFolder: string;
  lastPickedSourceFolder: string;
  lastSelectedPage: string;
  lastSelectedJobId: string | null;
  lastSelectedMangaId: string | null;
};

const SETTINGS_FILE_NAME = "gui-settings.json";

function createDefaultSettings(): GuiSettings {
  return {
    schemaVersion: 4,
    updatedAt: new Date().toISOString(),
    locale: "zh-TW",
    backendBaseUrl: "http://127.0.0.1:4001",
    koharuExecutablePath: "",
    koharuAutoStart: false,
    sourceFolder: "",
    outputFolder: shellPaths.downloads,
    referenceFolder: "",
    lastPickedSourceFolder: "",
    lastSelectedPage: "job",
    lastSelectedJobId: null,
    lastSelectedMangaId: null,
  };
}

function normalizeBackendBaseUrl(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fallback;
    return value.trim().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

function normalizeSettings(value: Partial<GuiSettings> | null | undefined): GuiSettings {
  const defaults = createDefaultSettings();
  if (!value || typeof value !== "object") return defaults;
  return {
    schemaVersion: 4,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : defaults.updatedAt,
    locale: value.locale === "en-US" ? "en-US" : "zh-TW",
    backendBaseUrl: normalizeBackendBaseUrl(value.backendBaseUrl, defaults.backendBaseUrl),
    koharuExecutablePath: typeof value.koharuExecutablePath === "string" ? value.koharuExecutablePath : "",
    koharuAutoStart: value.koharuAutoStart === true,
    sourceFolder: typeof value.sourceFolder === "string" ? value.sourceFolder : defaults.sourceFolder,
    outputFolder: typeof value.outputFolder === "string" ? value.outputFolder : defaults.outputFolder,
    referenceFolder: typeof value.referenceFolder === "string" ? value.referenceFolder : defaults.referenceFolder,
    lastPickedSourceFolder: typeof value.lastPickedSourceFolder === "string" ? value.lastPickedSourceFolder : defaults.lastPickedSourceFolder,
    lastSelectedPage: typeof value.lastSelectedPage === "string" ? value.lastSelectedPage : defaults.lastSelectedPage,
    lastSelectedJobId: typeof value.lastSelectedJobId === "string" ? value.lastSelectedJobId : null,
    lastSelectedMangaId: typeof value.lastSelectedMangaId === "string" ? value.lastSelectedMangaId : null,
  };
}

export class SettingsStore {
  private readonly filePath: string;

  constructor() {
    this.filePath = path.join(app.getPath("userData"), SETTINGS_FILE_NAME);
  }

  getFilePath(): string {
    return this.filePath;
  }

  read(): GuiSettings {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      return normalizeSettings(JSON.parse(raw));
    } catch {
      return createDefaultSettings();
    }
  }

  initialize(): GuiSettings {
    const settings = this.read();
    if (!fs.existsSync(this.filePath)) return this.write(settings);
    try {
      const persisted = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as { schemaVersion?: number };
      if (persisted.schemaVersion !== 4) return this.write(settings);
    } catch {
      // Preserve an unreadable file for diagnosis instead of overwriting it automatically.
    }
    return settings;
  }

  write(settings: Partial<GuiSettings>): GuiSettings {
    const nextSettings = normalizeSettings({
      ...this.read(),
      ...settings,
      updatedAt: new Date().toISOString(),
    });

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(nextSettings, null, 2), "utf-8");
    return nextSettings;
  }
}
