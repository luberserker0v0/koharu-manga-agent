import { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../ipc/channels";
import { getMainWindow } from "./main_window";

let editorWindow: BrowserWindow | null = null;
let activeSessionId: string | null = null;

export async function openKoharuEditorWindow(payload: { url: string; sessionId: string }) {
  const target = new URL(payload.url);
  if (!/^https?:$/.test(target.protocol)) {
    throw new Error("Koharu editor URL must use HTTP or HTTPS.");
  }
  if (editorWindow && !editorWindow.isDestroyed()) {
    if (activeSessionId !== payload.sessionId) {
      throw new Error("Another Koharu editor session is already open.");
    }
    editorWindow.focus();
    return { opened: true, reused: true };
  }

  activeSessionId = payload.sessionId;
  editorWindow = new BrowserWindow({
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
  const allowedOrigin = target.origin;
  editorWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  editorWindow.webContents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin !== allowedOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  editorWindow.once("ready-to-show", () => editorWindow?.show());
  editorWindow.on("closed", () => {
    const sessionId = activeSessionId;
    editorWindow = null;
    activeSessionId = null;
    getMainWindow()?.webContents.send(IPC_CHANNELS.KOHARU_EDITOR_CLOSED, { sessionId });
  });
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
