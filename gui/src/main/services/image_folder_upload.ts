import fs from "node:fs";
import path from "node:path";
import type { ImageFolderUploadRequest, ImageUploadResult } from "../../shared/image_upload";

const IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".avif", ".bmp",
  ".gif", ".tif", ".tiff", ".heic", ".heif",
]);

function endpoint(baseUrl: string, pathname: string) {
  return `${baseUrl.replace(/\/+$/, "")}${pathname}`;
}

async function responseJson<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>;
  const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
  throw new Error(body?.error || body?.message || `Upload request failed: ${response.status}`);
}

async function createUpload(baseUrl: string, kind: ImageFolderUploadRequest["kind"]) {
  const response = await fetch(endpoint(baseUrl, "/api/v1/uploads"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind }),
  });
  return responseJson<ImageUploadResult>(response);
}

function listImageFiles(sourceFolder: string) {
  const stat = fs.statSync(sourceFolder);
  if (!stat.isDirectory()) throw new Error(`Source path is not a directory: ${sourceFolder}`);
  const files = fs.readdirSync(sourceFolder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => ({ fileName: entry.name, filePath: path.join(sourceFolder, entry.name) }))
    .sort((left, right) => left.fileName.localeCompare(right.fileName, undefined, { numeric: true }));
  if (files.length === 0) throw new Error("The selected source folder contains no supported image files.");
  return files;
}

async function uploadFile(baseUrl: string, uploadId: string, file: ReturnType<typeof listImageFiles>[number]) {
  const content = await fs.promises.readFile(file.filePath);
  const response = await fetch(endpoint(baseUrl, `/api/v1/uploads/${uploadId}/files/${encodeURIComponent(file.fileName)}`), {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: content,
  });
  await responseJson(response);
}

async function completeUpload(baseUrl: string, uploadId: string) {
  const response = await fetch(endpoint(baseUrl, `/api/v1/uploads/${uploadId}/complete`), { method: "POST" });
  return responseJson<ImageUploadResult>(response);
}

async function discardUpload(baseUrl: string, uploadId: string) {
  await fetch(endpoint(baseUrl, `/api/v1/uploads/${uploadId}`), { method: "DELETE" }).catch(() => undefined);
}

export async function uploadImageFolder(
  request: ImageFolderUploadRequest,
  baseUrl: string,
): Promise<ImageUploadResult> {
  const files = listImageFiles(request.sourceFolder);
  const session = await createUpload(baseUrl, request.kind);
  try {
    for (const file of files) await uploadFile(baseUrl, session.uploadId, file);
    return await completeUpload(baseUrl, session.uploadId);
  } catch (error) {
    await discardUpload(baseUrl, session.uploadId);
    throw error;
  }
}
