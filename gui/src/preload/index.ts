import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../main/ipc/channels";

const desktopApi = {
  readSettings: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_READ),
  writeSettings: (settings: unknown) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_WRITE, settings),
  getDesktopInfo: () => ipcRenderer.invoke(IPC_CHANNELS.DESKTOP_INFO),
  openPath: (targetPath: string) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_PATH, targetPath),
  pickDirectory: (options?: { title?: string; defaultPath?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PICK_DIRECTORY, options),
  pickDirectories: (options?: { title?: string; defaultPath?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PICK_DIRECTORIES, options),
  confirmDialog: (options?: {
    title?: string;
    message?: string;
    detail?: string;
    confirmLabel?: string;
    cancelLabel?: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.CONFIRM_DIALOG, options),
  readJsonFile: (targetPath: string) => ipcRenderer.invoke(IPC_CHANNELS.READ_JSON_FILE, targetPath),
  writeJsonFile: (targetPath: string, data: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.WRITE_JSON_FILE, targetPath, data),
  deletePath: (targetPath: string) => ipcRenderer.invoke(IPC_CHANNELS.DELETE_PATH, targetPath),
  validatePaths: (payload: {
    sourceFolder: string;
    outputFolder: string;
    referenceFolder: string;
    sourceRequired?: boolean;
  }) => ipcRenderer.invoke(IPC_CHANNELS.VALIDATE_PATHS, payload),
  openKoharuEditor: (payload: { url: string; sessionId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_KOHARU_EDITOR, payload),
  closeKoharuEditor: (sessionId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CLOSE_KOHARU_EDITOR, sessionId),
  onKoharuEditorClosed: (callback: (payload: { sessionId: string | null }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { sessionId: string | null }) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.KOHARU_EDITOR_CLOSED, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.KOHARU_EDITOR_CLOSED, listener);
    };
  },
};

contextBridge.exposeInMainWorld("desktopApi", desktopApi);

export type DesktopApi = typeof desktopApi;
