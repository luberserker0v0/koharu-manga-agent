import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { shellPaths } from "./shell_paths";

export type GuiSettings = {
  schemaVersion: 1;
  updatedAt: string;
  locale: "zh-TW" | "en-US";
  sourceFolder: string;
  outputFolder: string;
  referenceFolder: string;
  lastPickedSourceFolder: string;
  lastSelectedPage: string;
  lastSelectedJobId: string | null;
  lastSelectedMangaId: string | null;
  agent: {
    provider: "opencode";
    runtimeMode: "managed" | "external";
    baseUrl: string;
    commandDir: string;
    moduleName: string;
    exportName: string;
    timeoutMs: number;
  };
  quality: {
    enabled: boolean;
    modelId: string;
    serverUrl: string;
  };
  translation: {
    modelId: string;
    serverUrl: string;
    providerId: string;
  };
  koharu: {
    baseUrl: string;
  };
  engines: Record<string, string>;
};

const SETTINGS_FILE_NAME = "gui-settings.json";

function deepMerge<T extends Record<string, any>>(base: T, override: Partial<T> | null | undefined): T {
  if (!override || typeof override !== "object") {
    return { ...base };
  }

  const result: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], value as Record<string, any>);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

function createDefaultSettings(): GuiSettings {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    locale: "zh-TW",
    sourceFolder: "",
    outputFolder: shellPaths.downloads,
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
      moduleName: "@opencode-ai/sdk/client",
      exportName: "createOpencodeClient",
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
      baseUrl: "http://127.0.0.1:4000",
    },
    engines: {},
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
      return deepMerge(createDefaultSettings(), JSON.parse(raw));
    } catch {
      return createDefaultSettings();
    }
  }

  write(settings: Partial<GuiSettings>): GuiSettings {
    const nextSettings = deepMerge(this.read(), {
      ...settings,
      updatedAt: new Date().toISOString(),
    });

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(nextSettings, null, 2), "utf-8");
    return nextSettings;
  }
}
