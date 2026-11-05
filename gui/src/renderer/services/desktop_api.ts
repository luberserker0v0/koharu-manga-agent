import type { DesktopApi } from "../../preload";
import type { DesktopInfo, GuiSettings, MangaProcessorHostState, PathValidationSummary } from "../types/settings";
import type { ImageFolderUploadRequest, ImageUploadResult } from "../../shared/image_upload";
import type { ArtifactDownloadRequest, ArtifactDownloadResult } from "../../shared/artifact_download";

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

export function openDesktopPath(targetPath: string): Promise<{ ok: boolean; error: string | null }> {
  const api = getDesktopApi();
  return api ? api.openPath(targetPath) : Promise.reject(unavailableError());
}

export function pickFile(options?: {
  title?: string;
  defaultPath?: string;
  extensions?: string[];
}): Promise<{ canceled: boolean; path: string | null }> {
  const api = getDesktopApi();
  return api ? api.pickFile(options) : Promise.reject(unavailableError());
}

export function getMangaProcessorHostStatus(): Promise<MangaProcessorHostState> {
  const api = getDesktopApi();
  return api ? api.getMangaProcessorHostStatus() : Promise.reject(unavailableError());
}

export function startMangaProcessorHost(executablePath: string): Promise<MangaProcessorHostState> {
  const api = getDesktopApi();
  return api ? api.startMangaProcessorHost(executablePath) : Promise.reject(unavailableError());
}

export function installAndStartMangaProcessorHost(): Promise<MangaProcessorHostState> {
  const api = getDesktopApi();
  return api ? api.installAndStartMangaProcessorHost() : Promise.reject(unavailableError());
}

export function stopMangaProcessorHost(): Promise<MangaProcessorHostState> {
  const api = getDesktopApi();
  return api ? api.stopMangaProcessorHost() : Promise.reject(unavailableError());
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

export function uploadImageFolder(request: ImageFolderUploadRequest): Promise<ImageUploadResult> {
  const api = getDesktopApi();
  return api ? api.uploadImageFolder(request) : Promise.reject(unavailableError());
}

export function downloadJobArtifact(request: ArtifactDownloadRequest): Promise<ArtifactDownloadResult> {
  const api = getDesktopApi();
  return api ? api.downloadJobArtifact(request) : Promise.reject(unavailableError());
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
