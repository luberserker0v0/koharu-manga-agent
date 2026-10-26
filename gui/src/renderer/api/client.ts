const DEFAULT_BASE_URL = "http://127.0.0.1:4001";
const DEFAULT_TIMEOUT_MS = 4000;
let activeBaseUrl = DEFAULT_BASE_URL;

type ApiFetchInit = RequestInit & {
  timeoutMs?: number;
};

function versionedPath(pathname: string) {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return normalized === "/api/v1" || normalized.startsWith("/api/v1/")
    ? normalized
    : `/api/v1${normalized}`;
}

export function buildApiUrl(pathname: string) {
  return `${activeBaseUrl}${versionedPath(pathname)}`;
}

export function setApiBaseUrl(baseUrl: string) {
  activeBaseUrl = baseUrl.trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
}

async function request(pathname: string, init: RequestInit, signal: AbortSignal) {
  return fetch(buildApiUrl(pathname), {
    ...init,
    signal: init.signal ?? signal,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

async function responseJson<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>;
  const details = (await response.json().catch(() => null)) as {
    error?: string;
    message?: string;
  } | null;
  throw new Error(details?.error || details?.message || `Request failed: ${response.status}`);
}

export async function apiFetch<T>(pathname: string, init?: ApiFetchInit): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const { timeoutMs: _timeoutMs, ...requestInit } = init || {};

  let response: Response;
  try {
    response = await request(pathname, requestInit, controller.signal);
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${pathname}`);
    }
    throw error;
  }

  clearTimeout(timeoutId);

  return responseJson<T>(response);
}
