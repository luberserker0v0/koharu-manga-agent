const DEFAULT_BASE_URL = "http://127.0.0.1:4001";
const DEFAULT_TIMEOUT_MS = 4000;

type ApiFetchInit = RequestInit & {
  timeoutMs?: number;
};

export function buildApiUrl(pathname: string) {
  return `${DEFAULT_BASE_URL}${pathname}`;
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
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}
