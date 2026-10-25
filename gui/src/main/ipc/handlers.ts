import { dialog, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { backendProcessService } from "../services/backend_process";
import { SettingsStore } from "../services/settings_store";
import { shellPaths } from "../services/shell_paths";
import { IPC_CHANNELS } from "./channels";
import { closeKoharuEditorWindow, openKoharuEditorWindow } from "../windows/koharu_editor_window";
import { koharuHostProcessService } from "../services/koharu_host_process";

function emptyPathResult() {
  return {
    ok: false,
    exists: false,
    writable: false,
    reason: "Path is empty.",
  };
}

function existsPath(targetPath: string) {
  return fs.existsSync(targetPath);
}

function writableExistingPath(targetPath: string, mode: "exists" | "writable") {
  try {
    fs.accessSync(targetPath, fs.constants.R_OK);
    if (mode === "writable") {
      fs.accessSync(targetPath, fs.constants.W_OK);
    }
    return mode === "writable";
  } catch {
    return false;
  }
}

function writableMissingPath(targetPath: string) {
  try {
    fs.accessSync(path.dirname(targetPath), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function missingPathResult(exists: boolean, writable: boolean) {
  return { ok: false, exists, writable, reason: "Path does not exist." };
}

function unwritablePathResult(exists: boolean, writable: boolean) {
  return {
    ok: false,
    exists,
    writable,
    reason: exists ? "Path is not writable." : "Parent directory is not writable.",
  };
}

function validPathResult(exists: boolean, writable: boolean) {
  return { ok: true, exists, writable, reason: "" };
}

function validateSinglePath(targetPath: string, mode: "exists" | "writable") {
  if (!targetPath.trim()) return emptyPathResult();
  const exists = existsPath(targetPath);
  const writable = exists
    ? mode === "writable"
      ? writableExistingPath(targetPath, mode)
      : false
    : writableMissingPath(targetPath);
  if (!exists && mode === "exists") return missingPathResult(exists, writable);
  if (mode === "writable" && !writable) return unwritablePathResult(exists, writable);
  return validPathResult(exists, writable);
}

function registerSettingsHandlers(settingsStore: SettingsStore) {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_READ, () => settingsStore.read());
  ipcMain.handle(IPC_CHANNELS.SETTINGS_WRITE, (_event, settings) => settingsStore.write(settings));
}

function registerDesktopHandlers(settingsStore: SettingsStore) {
  ipcMain.handle(IPC_CHANNELS.DESKTOP_INFO, async () => ({
    shellPaths,
    settingsFilePath: settingsStore.getFilePath(),
    backendProcess: backendProcessService.getState(),
    koharuProcess: await koharuHostProcessService.inspect(),
  }));
}

function registerOpenPathHandler() {
  ipcMain.handle(IPC_CHANNELS.OPEN_PATH, async (_event, targetPath: string) => {
    const error = await shell.openPath(targetPath);
    return { ok: !error, error: error || null };
  });
}

function registerPickFileHandler() {
  ipcMain.handle(
    IPC_CHANNELS.PICK_FILE,
    async (_event, options?: { title?: string; defaultPath?: string; extensions?: string[] }) => {
      const result = await dialog.showOpenDialog({
        title: options?.title || "Select file",
        defaultPath: options?.defaultPath || undefined,
        filters: options?.extensions?.length ? [{ name: "Executable", extensions: options.extensions }] : undefined,
        properties: ["openFile"],
      });
      if (result.canceled || result.filePaths.length === 0) return { canceled: true, path: null };
      return { canceled: false, path: result.filePaths[0] };
    },
  );
}

function registerPickDirectoryHandler() {
  ipcMain.handle(IPC_CHANNELS.PICK_DIRECTORY, async (_event, options?: { title?: string; defaultPath?: string }) => {
    const result = await dialog.showOpenDialog({
      title: options?.title || "Select directory",
      defaultPath: options?.defaultPath || undefined,
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, path: null };
    }
    return { canceled: false, path: result.filePaths[0] };
  });
}

function registerKoharuHostHandlers() {
  ipcMain.handle(IPC_CHANNELS.KOHARU_HOST_STATUS, () => koharuHostProcessService.inspect());
  ipcMain.handle(IPC_CHANNELS.KOHARU_HOST_INSTALL_START, () => koharuHostProcessService.installAndStart());
  ipcMain.handle(IPC_CHANNELS.KOHARU_HOST_START, (_event, executablePath: string) =>
    koharuHostProcessService.start(executablePath),
  );
  ipcMain.handle(IPC_CHANNELS.KOHARU_HOST_STOP, () => koharuHostProcessService.stopManaged());
}

function registerPickDirectoriesHandler() {
  ipcMain.handle(IPC_CHANNELS.PICK_DIRECTORIES, async (_event, options?: { title?: string; defaultPath?: string }) => {
    const result = await dialog.showOpenDialog({
      title: options?.title || "Select directories",
      defaultPath: options?.defaultPath || undefined,
      properties: ["openDirectory", "createDirectory", "multiSelections"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, paths: [] };
    }
    return { canceled: false, paths: result.filePaths };
  });
}

function registerConfirmDialogHandler() {
  ipcMain.handle(
    IPC_CHANNELS.CONFIRM_DIALOG,
    async (
      _event,
      options?: {
        title?: string;
        message?: string;
        detail?: string;
        confirmLabel?: string;
        cancelLabel?: string;
      },
    ) => {
      const result = await dialog.showMessageBox({
        type: "warning",
        buttons: [options?.confirmLabel || "Confirm", options?.cancelLabel || "Cancel"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: options?.title || "Confirm",
        message: options?.message || "Are you sure?",
        detail: options?.detail || "",
      });
      return { confirmed: result.response === 0 };
    },
  );
}

function registerJsonFileHandlers() {
  ipcMain.handle(IPC_CHANNELS.READ_JSON_FILE, async (_event, targetPath: string) => {
    const raw = fs.readFileSync(targetPath, "utf-8");
    return { path: targetPath, data: JSON.parse(raw) };
  });
  ipcMain.handle(IPC_CHANNELS.WRITE_JSON_FILE, async (_event, targetPath: string, data: unknown) => {
    fs.writeFileSync(targetPath, JSON.stringify(data, null, 2), "utf-8");
    return { ok: true, path: targetPath };
  });
  ipcMain.handle(IPC_CHANNELS.DELETE_PATH, async (_event, targetPath: string) => {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return { ok: true, path: targetPath };
  });
}

function registerEditorHandlers() {
  ipcMain.handle(IPC_CHANNELS.OPEN_KOHARU_EDITOR, (_event, payload: { url: string; sessionId: string }) =>
    openKoharuEditorWindow(payload),
  );
  ipcMain.handle(IPC_CHANNELS.CLOSE_KOHARU_EDITOR, (_event, sessionId?: string) => closeKoharuEditorWindow(sessionId));
}

function registerValidatePathsHandler() {
  ipcMain.handle(
    IPC_CHANNELS.VALIDATE_PATHS,
    (
      _event,
      payload: {
        sourceFolder: string;
        outputFolder: string;
        referenceFolder: string;
        sourceRequired?: boolean;
      },
    ) => ({
      sourceFolder:
        payload.sourceRequired === false && !payload.sourceFolder.trim()
          ? { ok: true, exists: false, writable: false, reason: "" }
          : validateSinglePath(payload.sourceFolder, "exists"),
      outputFolder: validateSinglePath(payload.outputFolder, "writable"),
      referenceFolder: payload.referenceFolder.trim()
        ? validateSinglePath(payload.referenceFolder, "exists")
        : { ok: true, exists: false, writable: false, reason: "" },
    }),
  );
}

export function registerIpcHandlers(settingsStore: SettingsStore): void {
  registerSettingsHandlers(settingsStore);
  registerDesktopHandlers(settingsStore);
  registerOpenPathHandler();
  registerPickFileHandler();
  registerPickDirectoryHandler();
  registerKoharuHostHandlers();
  registerPickDirectoriesHandler();
  registerConfirmDialogHandler();
  registerJsonFileHandlers();
  registerEditorHandlers();
  registerValidatePathsHandler();
}
