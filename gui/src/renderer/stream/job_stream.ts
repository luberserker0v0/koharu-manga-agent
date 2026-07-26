type StreamCallback = (event: {
  type: string;
  payload: unknown;
  createdAt?: string;
  job?: unknown;
  kind?: "job" | "system" | "snapshot";
  jobs?: unknown;
}) => void;

type StreamHandlers =
  | StreamCallback
  | {
      onEvent: StreamCallback;
      onOpen?: () => void;
      onError?: () => void;
    };

type JobsStreamEvent = {
  kind?: "job" | "system" | "snapshot";
  type: string;
  payload?: unknown;
  job?: unknown;
  jobs?: unknown;
  createdAt?: string;
};

const DEFAULT_BASE_URL = "http://127.0.0.1:4001";

function normalizeStreamPayload(
  rawType: string,
  data: string
): {
  type: string;
  payload: unknown;
  createdAt?: string;
  job?: unknown;
  kind?: "job" | "system" | "snapshot";
  jobs?: unknown;
} {
  const parsed = JSON.parse(data) as Record<string, unknown>;
  if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
    return {
      type: parsed.type,
      payload: parsed.payload,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      job: parsed.job,
      kind:
        parsed.kind === "job" || parsed.kind === "system" || parsed.kind === "snapshot"
          ? parsed.kind
          : undefined,
      jobs: parsed.jobs,
    };
  }

  return {
    type: rawType === "message" ? "message" : rawType,
    payload: parsed,
    createdAt: new Date().toISOString(),
  };
}

export function subscribeToJobStream(jobId: string, handlers: StreamHandlers): () => void {
  const eventSource = new EventSource(`${DEFAULT_BASE_URL}/jobs/${jobId}/stream?eventMode=message`);
  const onEvent = typeof handlers === "function" ? handlers : handlers.onEvent;
  const onOpen = typeof handlers === "function" ? undefined : handlers.onOpen;
  const onError = typeof handlers === "function" ? undefined : handlers.onError;

  const handleMessage = (event: MessageEvent<string>) => {
    onEvent(normalizeStreamPayload(event.type, event.data));
  };

  eventSource.onopen = () => {
    onOpen?.();
  };

  eventSource.onerror = () => {
    onError?.();
  };

  eventSource.onmessage = handleMessage;
  return () => {
    eventSource.close();
  };
}

export function subscribeToJobsStream(handlers: {
  onEvent: (event: JobsStreamEvent) => void;
  onOpen?: () => void;
  onError?: () => void;
}): () => void {
  const eventSource = new EventSource(`${DEFAULT_BASE_URL}/jobs/stream?eventMode=message`);

  const handleMessage = (event: MessageEvent<string>) => {
    handlers.onEvent(normalizeStreamPayload(event.type, event.data) as JobsStreamEvent);
  };

  eventSource.onopen = () => {
    handlers.onOpen?.();
  };

  eventSource.onerror = () => {
    handlers.onError?.();
  };

  eventSource.onmessage = handleMessage;
  return () => {
    eventSource.close();
  };
}
