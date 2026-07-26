import type { DesktopApi } from "../../preload";
import type { DesktopInfo, GuiSettings, PathValidationSummary } from "../types/settings";

declare global {
  interface Window {
    desktopApi?: DesktopApi;
  }
}

function unavailableError() {
  return new Error("Desktop API bridge is unavailable.");
}

function getDesktopApi(): DesktopApi | null {
  return typeof window !== "undefined" && window.desktopApi ? window.desktopApi : null;
}

export function readSettings(): Promise<GuiSettings> {
  const api = getDesktopApi();
  return api ? api.readSettings() : Promise.reject(unavailableError());
}

export function writeSettings(settings: Partial<GuiSettings>): Promise<GuiSettings> {
  const api = getDesktopApi();
  return api ? api.writeSettings(settings) : Promise.reject(unavailableError());
}

export function getDesktopInfo(): Promise<DesktopInfo> {
  const api = getDesktopApi();
  return api ? api.getDesktopInfo() : Promise.reject(unavailableError());
}

export function openDesktopPath(targetPath: string) {
  const api = getDesktopApi();
  return api ? api.openPath(targetPath) : Promise.reject(unavailableError());
}

export function pickDirectory(options?: {
  title?: string;
  defaultPath?: string;
}): Promise<{ canceled: boolean; path: string | null }> {
  const api = getDesktopApi();
  return api ? api.pickDirectory(options) : Promise.reject(unavailableError());
}

export function pickDirectories(options?: {
  title?: string;
  defaultPath?: string;
}): Promise<{ canceled: boolean; paths: string[] }> {
  const api = getDesktopApi();
  return api ? api.pickDirectories(options) : Promise.reject(unavailableError());
}

export function confirmDialog(options?: {
  title?: string;
  message?: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}): Promise<{ confirmed: boolean }> {
  const api = getDesktopApi();
  return api ? api.confirmDialog(options) : Promise.reject(unavailableError());
}

export function readJsonFile(targetPath: string): Promise<{ path: string; data: unknown }> {
  const api = getDesktopApi();
  return api ? api.readJsonFile(targetPath) : Promise.reject(unavailableError());
}

export function writeJsonFile(targetPath: string, data: unknown): Promise<{ ok: boolean; path: string }> {
  const api = getDesktopApi();
  return api ? api.writeJsonFile(targetPath, data) : Promise.reject(unavailableError());
}

export function deleteDesktopPath(targetPath: string): Promise<{ ok: boolean; path: string }> {
  const api = getDesktopApi();
  return api ? api.deletePath(targetPath) : Promise.reject(unavailableError());
}

export function validatePaths(payload: {
  sourceFolder: string;
  outputFolder: string;
  referenceFolder: string;
  sourceRequired?: boolean;
}): Promise<PathValidationSummary> {
  const api = getDesktopApi();
  return api ? api.validatePaths(payload) : Promise.reject(unavailableError());
}

export function openKoharuEditor(payload: { url: string; sessionId: string }) {
  const api = getDesktopApi();
  return api ? api.openKoharuEditor(payload) : Promise.reject(unavailableError());
}

export function closeKoharuEditor(sessionId?: string) {
  const api = getDesktopApi();
  return api ? api.closeKoharuEditor(sessionId) : Promise.reject(unavailableError());
}

export function onKoharuEditorClosed(callback: (payload: { sessionId: string | null }) => void) {
  const api = getDesktopApi();
  return api ? api.onKoharuEditorClosed(callback) : () => undefined;
}
