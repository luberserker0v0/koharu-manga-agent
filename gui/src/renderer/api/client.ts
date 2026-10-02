const DEFAULT_BASE_URL = "http://127.0.0.1:4001";
const DEFAULT_TIMEOUT_MS = 4000;
let activeBaseUrl = DEFAULT_BASE_URL;

type ApiFetchInit = RequestInit & {
  timeoutMs?: number;
};

export function buildApiUrl(pathname: string) {
  return `${activeBaseUrl}${pathname}`;
}

export function setApiBaseUrl(baseUrl: string) {
  activeBaseUrl = baseUrl.trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
}

export async function apiFetch<T>(pathname: string, init?: ApiFetchInit): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const { timeoutMs: _timeoutMs, ...requestInit } = init || {};

  let response: Response;
  try {
    response = await fetch(buildApiUrl(pathname), {
      ...requestInit,
      signal: requestInit.signal ?? controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(requestInit.headers || {}),
      },
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${pathname}`);
    }
    throw error;
  }

  clearTimeout(timeoutId);

  if (!response.ok) {
    const details = await response.json().catch(() => null) as { error?: string; message?: string } | null;
    throw new Error(details?.error || details?.message || `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}
