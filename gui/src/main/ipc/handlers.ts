import { dialog, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { backendProcessService } from "../services/backend_process";
import { SettingsStore } from "../services/settings_store";
import { shellPaths } from "../services/shell_paths";
import { IPC_CHANNELS } from "./channels";
import { closeKoharuEditorWindow, openKoharuEditorWindow } from "../windows/koharu_editor_window";

const settingsStore = new SettingsStore();

function validateSinglePath(targetPath: string, mode: "exists" | "writable") {
  if (!targetPath.trim()) {
    return {
      ok: false,
      exists: false,
      writable: false,
      reason: "Path is empty.",
    };
  }

  const exists = fs.existsSync(targetPath);
  let writable = false;

  if (exists) {
    try {
      fs.accessSync(targetPath, fs.constants.R_OK);
      writable = mode === "writable" ? true : writable;
      if (mode === "writable") {
        fs.accessSync(targetPath, fs.constants.W_OK);
      }
      writable = mode === "writable";
    } catch {
      writable = false;
    }
  } else {
    try {
      const parentDir = path.dirname(targetPath);
      fs.accessSync(parentDir, fs.constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
  }

  if (!exists && mode === "exists") {
    return {
      ok: false,
      exists,
      writable,
      reason: "Path does not exist.",
    };
  }

  if (mode === "writable" && !writable) {
    return {
      ok: false,
      exists,
      writable,
      reason: exists ? "Path is not writable." : "Parent directory is not writable.",
    };
  }

  return {
    ok: true,
    exists,
    writable,
    reason: "",
  };
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_READ, () => settingsStore.read());
  ipcMain.handle(IPC_CHANNELS.SETTINGS_WRITE, (_event, settings) => settingsStore.write(settings));
  ipcMain.handle(IPC_CHANNELS.DESKTOP_INFO, () => ({
    shellPaths,
    settingsFilePath: settingsStore.getFilePath(),
    backendProcess: backendProcessService.getState(),
  }));
  ipcMain.handle(IPC_CHANNELS.OPEN_PATH, async (_event, targetPath: string) => {
    await shell.openPath(targetPath);
    return { ok: true };
  });
  ipcMain.handle(
    IPC_CHANNELS.PICK_DIRECTORY,
    async (_event, options?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        title: options?.title || "Select directory",
        defaultPath: options?.defaultPath || undefined,
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, path: null };
      }
      return { canceled: false, path: result.filePaths[0] };
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.PICK_DIRECTORIES,
    async (_event, options?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        title: options?.title || "Select directories",
        defaultPath: options?.defaultPath || undefined,
        properties: ["openDirectory", "createDirectory", "multiSelections"],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, paths: [] };
      }
      return { canceled: false, paths: result.filePaths };
    }
  );
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
      }
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
      return {
        confirmed: result.response === 0,
      };
    }
  );
  ipcMain.handle(IPC_CHANNELS.READ_JSON_FILE, async (_event, targetPath: string) => {
    const raw = fs.readFileSync(targetPath, "utf-8");
    return {
      path: targetPath,
      data: JSON.parse(raw),
    };
  });
  ipcMain.handle(IPC_CHANNELS.WRITE_JSON_FILE, async (_event, targetPath: string, data: unknown) => {
    fs.writeFileSync(targetPath, JSON.stringify(data, null, 2), "utf-8");
    return {
      ok: true,
      path: targetPath,
    };
  });
  ipcMain.handle(IPC_CHANNELS.DELETE_PATH, async (_event, targetPath: string) => {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return {
      ok: true,
      path: targetPath,
    };
  });
  ipcMain.handle(
    IPC_CHANNELS.OPEN_KOHARU_EDITOR,
    (_event, payload: { url: string; sessionId: string }) => openKoharuEditorWindow(payload)
  );
  ipcMain.handle(
    IPC_CHANNELS.CLOSE_KOHARU_EDITOR,
    (_event, sessionId?: string) => closeKoharuEditorWindow(sessionId)
  );
  ipcMain.handle(
    IPC_CHANNELS.VALIDATE_PATHS,
    (
      _event,
      payload: {
        sourceFolder: string;
        outputFolder: string;
        referenceFolder: string;
        sourceRequired?: boolean;
      }
    ) => ({
      sourceFolder:
        payload.sourceRequired === false && !payload.sourceFolder.trim()
          ? {
              ok: true,
              exists: false,
              writable: false,
              reason: "",
            }
          : validateSinglePath(payload.sourceFolder, "exists"),
      outputFolder: validateSinglePath(payload.outputFolder, "writable"),
      referenceFolder: payload.referenceFolder.trim()
        ? validateSinglePath(payload.referenceFolder, "exists")
        : {
            ok: true,
            exists: false,
            writable: false,
            reason: "",
          },
    })
  );
}
