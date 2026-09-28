# REST Translation Workflow

This is the supported end-to-end client flow for the browser extension and other local API clients. The client communicates only with the backend. It never calls Koharu or AO directly.

```text
Client -> Backend REST/SSE -> host Koharu HTTP API
                           -> host AO HTTP API when required by the mode
```

The examples use `http://127.0.0.1:4001/api/v1`. Add `Authorization: Bearer <token>` to every API request except `/health` when `server.authToken` is configured.

## Ready Check

1. Call `GET /health` to confirm that the HTTP process is alive.
2. Call `GET /api/v1/runtime/status` to inspect dependencies.
3. Require `backend.status === "ready"` and `koharu.status === "running"` before submitting any Translation Job.
4. Also require `agent.status === "ready"` for `reference_style`, `local_style` with Quality enabled, and `learning_style`. Quick mode does not use AO.

Backend readiness does not imply Koharu or AO readiness. An offline external service is reported independently.

## Complete Request Sequence

### 1. Create an upload session

```http
POST /api/v1/uploads
Content-Type: application/json

{"kind":"source"}
```

Retain the returned `uploadId`.

### 2. Upload every source image

Upload raw image bytes. URL-encode the original filename.

```http
PUT /api/v1/uploads/{uploadId}/files/{encodedFileName}
Content-Type: image/png

<raw bytes>
```

The backend accepts the configured per-file and file-count limits. Upload requests can be parallelized, but the client must wait for every request to succeed before completing the session.

### 3. Complete the upload

```http
POST /api/v1/uploads/{uploadId}/complete
```

A completed session is immutable. Create another session to replace its contents.

### 4. Run source preflight

```http
POST /api/v1/source-preflight
Content-Type: application/json

{"uploadId":"..."}
```

Keep the returned `preflightId`. Inspect the accepted/rejected image summary before creating a job. If user-directed ordering is needed, submit the ordered image IDs to:

```http
POST /api/v1/source-preflight/{preflightId}/reorder
Content-Type: application/json

{"orderedImageIds":["..."]}
```

### 5. Create a Translation Job

The minimal browser-safe Quick payload is:

```http
POST /api/v1/jobs/translation
Content-Type: application/json

{
  "translationMode":"quick",
  "targetLanguage":"zh-TW",
  "qualityCheck":false,
  "exportFormat":"rendered",
  "mangaId":"my_manga",
  "translatorId":"quick_output",
  "chapterId":"ch_001",
  "sourcePreflightId":"..."
}
```

The backend owns the export location and generates it beneath its configured `paths.translated` root. Browser clients must not send `outputDir` or depend on a backend filesystem path. A trusted desktop deployment may still supply the optional legacy override while that GUI integration remains supported.

The response is `202 Accepted` with the queued Job. Keep its `id`. A `202` response means accepted, not completed.

Reference-backed modes have additional prerequisites:

- `reference_style` requires `referenceTranslatorId` and completed compatible Reference assets.
- `local_style` consumes and commits Local Knowledge, so it requires AO; Quality remains optional.
- `learning_style` requires `referenceTranslatorId`, a distinct learning-clone `translatorId`, compatible Reference assets, and AO.

### 6. Follow live progress

Use the selected-job SSE stream as the primary live channel:

```http
GET /api/v1/jobs/{jobId}/stream?eventMode=message
Accept: text/event-stream
```

With `eventMode=message`, every SSE message has a JSON envelope whose `type` identifies the backend event. Reconnect after a network interruption and reconcile with `GET /api/v1/jobs/{jobId}`. Polling is a fallback, not the primary UI update path.

Terminal lifecycle states are:

- `succeeded`
- `failed`
- `canceled`
- `blocked`

Do not treat `waiting_dependency`, `waiting_prerequisite`, or `waiting_koharu_review` as failures.

### 7. Read the authoritative result

```http
GET /api/v1/jobs/{jobId}
GET /api/v1/jobs/{jobId}/events
GET /api/v1/jobs/{jobId}/artifacts
```

The Job resource is the lifecycle source of truth. On failure, preserve its `error`, events, and artifacts. Do not automatically retry. Inspect the earliest failed atomic child Job when the response represents a parent workflow.

### 8. Download artifacts

For each artifact returned by the artifact list:

```http
GET /api/v1/jobs/{jobId}/artifacts/{artifactId}/content
```

Only regular files beneath the backend data root are downloadable. A `409` means that the artifact is unavailable or outside that root; do not attempt to interpret its backend filesystem path from the client.

### 9. Display translated pages

The extension does not need to download and unpack the export ZIP. Ask the backend for its translated
image manifest:

```http
GET /api/v1/jobs/{jobId}/translated-images
```

Use each returned `contentUrl` for efficient binary preview/download. Use `encodedUrl` only when a
Base64 JSON value is specifically required. The backend extracts ZIP pages once and reuses the cache.

### 10. Upload retention

Do not delete the source upload immediately after Translation. Post-edit and re-export operations can still depend on the original source images referenced by the preflight record.

When the chapter no longer needs those operations, delete it explicitly:

```http
DELETE /api/v1/uploads/{uploadId}
```

## Executable CLI Workflow

The repository includes a zero-dependency Node client implementing the sequence above, including SSE progress, polling reconciliation, event retrieval, and artifact downloads:

```powershell
node scripts/rest_translation_workflow.mjs `
  --source .\original\chapter-001 `
  --manga-id my_manga `
  --translator-id quick_output `
  --chapter-id ch_001 `
  --target-language zh-TW
```

When Bearer authentication is enabled:

```powershell
$env:MANGA_BACKEND_TOKEN = "replace-with-local-token"
node scripts/rest_translation_workflow.mjs `
  --source .\original\chapter-001 `
  --manga-id my_manga `
  --translator-id quick_output `
  --chapter-id ch_001
```

The CLI exits with code `0` after a succeeded Job, `2` after a terminal non-success Job, and `1` for request, dependency, validation, or timeout failures. It retains the upload on all outcomes and prints its ID for later diagnosis or cleanup.

## Retry Policy

- `POST /api/v1/jobs/{jobId}/retry` creates a new Job with the previous payload.
- `POST /api/v1/jobs/{jobId}/resume` is valid only when the failed Job advertises `resumeMetadata.resumeAvailable === true`.
- Never retry a live Job or a terminal ordered Reference workflow without first checking its dependencies.
- A timeout in the client does not prove that the server-side Job stopped. Read the Job again before deciding what to do.

## Browser Extension Implementation Boundary

The extension should persist only backend identifiers and user-facing metadata:

- `uploadId`
- `preflightId`
- `jobId`
- manga, translator, and chapter bindings

It must not persist or depend on `/data/...` paths. Use SSE for progress and the artifact-content endpoint for downloads. Keep the Bearer token in extension-local protected storage and restrict backend CORS to the installed extension origin for non-development deployments.
