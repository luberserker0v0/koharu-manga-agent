import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ArtifactDownloadRequest, ArtifactDownloadResult } from "../../shared/artifact_download";

function artifactUrl(baseUrl: string, request: ArtifactDownloadRequest) {
  const jobId = encodeURIComponent(request.jobId);
  return `${baseUrl.replace(/\/+$/, "")}/api/v1/jobs/${jobId}/artifacts/${request.artifactId}/content`;
}

async function responseError(response: Response) {
  const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
  return new Error(body?.error || body?.message || `Artifact download failed: ${response.status}`);
}

function responseFileName(response: Response, fallback: string) {
  const disposition = response.headers.get("content-disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  const decoded = encoded ? decodeURIComponent(encoded) : plain || fallback;
  return path.basename(decoded).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}

function availablePath(directory: string, fileName: string) {
  const parsed = path.parse(fileName);
  let candidate = path.join(directory, fileName);
  for (let index = 1; fs.existsSync(candidate); index += 1) {
    candidate = path.join(directory, `${parsed.name} (${index})${parsed.ext}`);
  }
  return candidate;
}

export async function downloadJobArtifact(
  request: ArtifactDownloadRequest,
  baseUrl: string,
  directory: string,
): Promise<ArtifactDownloadResult> {
  const response = await fetch(artifactUrl(baseUrl, request));
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new Error("Artifact download returned an empty body.");
  fs.mkdirSync(directory, { recursive: true });
  const fileName = responseFileName(response, `artifact-${request.artifactId}`);
  const destination = availablePath(directory, fileName);
  await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(destination));
  return { path: destination, fileName: path.basename(destination), size: fs.statSync(destination).size };
}
