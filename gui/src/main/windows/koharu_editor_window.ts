import { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../ipc/channels";
import { getMainWindow } from "./main_window";

let editorWindow: BrowserWindow | null = null;
let activeSessionId: string | null = null;

function reuseEditor(sessionId: string) {
  if (!editorWindow || editorWindow.isDestroyed()) return null;
  if (activeSessionId !== sessionId) throw new Error("Another Koharu editor session is already open.");
  editorWindow.focus();
  return { opened: true, reused: true };
}

function createEditorWindow() {
  return new BrowserWindow({
    parent: getMainWindow() || undefined,
    width: 1500,
    height: 1000,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: "persist:koharu-editor",
    },
  });
}

function restrictNavigation(window: BrowserWindow, allowedOrigin: string) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin !== allowedOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
}

function registerWindowLifecycle(window: BrowserWindow) {
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    const sessionId = activeSessionId;
    editorWindow = null;
    activeSessionId = null;
    getMainWindow()?.webContents.send(IPC_CHANNELS.KOHARU_EDITOR_CLOSED, {
      sessionId,
    });
  });
}

export async function openKoharuEditorWindow(payload: { url: string; sessionId: string }) {
  const target = new URL(payload.url);
  if (!/^https?:$/.test(target.protocol)) {
    throw new Error("Koharu editor URL must use HTTP or HTTPS.");
  }
  const reused = reuseEditor(payload.sessionId);
  if (reused) return reused;

  activeSessionId = payload.sessionId;
  editorWindow = createEditorWindow();
  restrictNavigation(editorWindow, target.origin);
  registerWindowLifecycle(editorWindow);
  try {
    await editorWindow.loadURL(target.toString());
  } catch (error) {
    if (editorWindow && !editorWindow.isDestroyed()) editorWindow.destroy();
    throw error;
  }
  return { opened: true, reused: false };
}

export function closeKoharuEditorWindow(sessionId?: string) {
  if (!editorWindow || editorWindow.isDestroyed()) return { closed: false };
  if (sessionId && activeSessionId !== sessionId) return { closed: false };
  editorWindow.close();
  return { closed: true };
}
