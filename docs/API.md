# MangaTranslationAgent API Notes

This document now covers two API layers:
- the local backend API exposed by `backend/server.js`
- the upstream Koharu HTTP API consumed by the backend

## Local Backend API

Browser clients should use the versioned `/api/v1` prefix. Existing unversioned routes remain available during the backend-client migration.

For the complete upload, preflight, Translation Job, SSE, artifact-download, and selective
retranslation lifecycle, see `docs/REST_WORKFLOW.md`. The executable reference client is
`scripts/rest_translation_workflow.mjs`. The versioned machine-readable contract for page revisions
is `docs/openapi.yaml`.

### Browser upload sessions

Create a source-chapter, Reference, or OCR-review upload session:

```http
POST /api/v1/uploads
Content-Type: application/json

{"kind":"source"}
```

Upload one image per request, using the original filename as the final path segment:

```http
PUT /api/v1/uploads/{uploadId}/files/{fileName}
Content-Type: image/png

<raw image bytes>
```

Complete and inspect the session before committing it:

```http
POST /api/v1/uploads/{uploadId}/complete
GET /api/v1/uploads/{uploadId}
DELETE /api/v1/uploads/{uploadId}
```

After completion, pass `uploadId` instead of `sourceFolder`:

```http
POST /api/v1/source-preflight
Content-Type: application/json

{"uploadId":"..."}
```

Reference uploads use `kind: "reference"` and the same `uploadId` field with `POST /api/v1/references/import`.
OCR crop uploads use `kind: "ocr_review"`; they are consumed only by the asynchronous OCR text-review
Job described below.
Source preflight and Reference import copy accepted images into backend-owned durable storage, then
release the consumed upload session. `DELETE` is only needed to abandon a session before submission.

### Download a job artifact

```http
GET /api/v1/jobs/{jobId}/artifacts/{artifactId}/content
```

Only regular files located beneath the configured backend data root can be downloaded.

### Read translated images

List the rendered pages for a completed Translation or Post-edit Export Job. ZIP exports are safely
extracted into a backend-owned cache; direct image exports use the same response contract:

```http
GET /api/v1/jobs/{jobId}/translated-images
```

For succeeded Translation Jobs, every entry also contains `sourceImageId`, `sourceOrderIndex`,
`revisionId`, `revisionNumber`, and `active`. This is the authoritative source-to-output mapping;
clients must not infer it from a ZIP entry name or output order. Each image entry contains stable
`encodedUrl` and `contentUrl` fields. Read one image as Base64 JSON:

```http
GET /api/v1/jobs/{jobId}/translated-images/{imageId}
```

The response includes `encoding: "base64"`, `mediaType`, `fileName`, `size`, and `data`. For previews,
Blob URLs, or downloads, stream the image directly instead:

```http
GET /api/v1/jobs/{jobId}/translated-images/{imageId}/content
```

The binary response uses the image media type and an inline `Content-Disposition`. Clients must start
from the list response and must not derive cache paths or inspect ZIP contents themselves.

### Selectively retranslate source pages

Create a new Translation Job for an ordered subset of the retained source preflight:

```http
POST /api/v1/jobs/{parentJobId}/retranslations
Content-Type: application/json

{
  "sourceImageIds": ["source-image-3", "source-image-7"],
  "translationTarget": {
    "providerId": "openai",
    "modelId": "gpt-5"
  },
  "targetLanguage": "zh-TW",
  "sourceLanguage": ["ja", "en"],
  "instructions": "Keep the character name Koharu untranslated."
}
```

`sourceImageIds` is required, non-empty, and unique. Every ID must belong to the exact retained
preflight used by the root Translation Job, and its backend-owned normalized image must still be
available. The backend restores chapter order even if the request sends IDs in another order.

The four other fields are optional overrides. Omitted settings inherit from the selected parent Job.
`sourceLanguage` accepts one BCP 47 tag or an ordered array. The first item is primary for Translation
Memory, Observation, and Quality; the complete ordered list selects a compatible OCR engine. Omission,
`null`, and an empty array use automatic OCR policy. Provider, model, target-language support, and BCP
47 language tags are validated before persistence.
`instructions` is supported for LLM targets and is preserved with revision metadata. Machine
Translation providers reject it with `422 unsupported_retranslation_instructions`; the backend never
pretends that an unsupported instruction was applied.

The response is `202 Accepted` with a normal queued Job. Its immutable `revision` member contains:

```json
{
  "rootJobId": "job-original",
  "parentJobId": "job-original",
  "reason": "selective_retranslation",
  "sourceImageIds": ["source-image-3", "source-image-7"]
}
```

Monitor the Job through the existing Job GET, SSE, events, diagnostics, child Job, and artifact APIs.
Only the selected source images are uploaded to Koharu and exported. A successful selective Job
atomically promotes those page revisions, rebuilds a complete chapter export, and replaces the active
chapter publication. The previous files and page revisions remain immutable internal recovery data.
Failed, blocked, or canceled Jobs never change the active chapter and are not retried automatically.

Missing source data returns `409` with either `source_preflight_unavailable` or
`source_image_unavailable`. These errors do not disclose filesystem
paths. Unknown or duplicated selections return `400`/`422` validation errors.

### Inspect text regions

Completed Translation Jobs created by the current backend retain an immutable text-region snapshot:

```http
GET /api/v1/jobs/{jobId}/text-regions
GET /api/v1/jobs/{jobId}/text-regions?sourceImageId={sourceImageId}
```

Each page is bound to its authoritative source-preflight `sourceImageId` and page `revisionId`.
Every region includes an opaque ID, reading order, exact OCR source text, translated text, rectangular
geometry, and a declared source-image-pixel coordinate space. OCR whitespace and line breaks are
returned unchanged. Optional confidence and source direction are present only when the manga processor supplied them.

The response never exposes upstream processor page/node handles or filesystem paths. Jobs created before region
snapshots were introduced return `409 text_region_snapshot_unavailable`. A snapshot without reliable
image dimensions returns `409 text_region_coordinate_space_unavailable` instead of coordinates that a
client would have to guess.

### Review OCR text regions with a vision model

The recommended browser workflow crops each existing OCR region locally, uploads those crops as raw
bytes, and creates one asynchronous Job for the batch. This ensures every LM Studio inference sees
exactly one crop and its current OCR text; neither the API nor the model receives OCR coordinates.

```http
POST /api/v1/uploads
Content-Type: application/json

{"kind":"ocr_review"}

PUT /api/v1/uploads/{uploadId}/files/ocr_001.png
Content-Type: image/png

<raw crop bytes>
```

Complete the upload, then queue the review:

```http
POST /api/v1/jobs/ocr-text-review
Content-Type: application/json

{
  "uploadId": "...",
  "sourceLanguages": ["en", "ja"],
  "items": [{
    "clientItemId": "region-1",
    "fileName": "ocr_001.png",
    "ocrText": "inter galac tic"
  }]
}
```

The response is `202 Accepted` with an `ocr_text_review` Job. Use the standard Job GET, SSE, events,
and cancellation APIs. Progress events use `ocr_text_review.progress` and contain `completed`, `total`,
`progress`, `clientItemId`, and the per-item status. The terminal result maps every suggestion back
through the caller-owned opaque `clientItemId`; the model never generates this ID. Individual failures
are preserved as result items and are not retried automatically. The caller reviews the suggestions
before applying them through the text-region correction workflow.

`contextBefore` and `contextAfter` remain optional compatibility fields. Clients performing isolated
OCR correction should omit them: adjacent OCR is untrusted input and can cause a vision model to echo
another region into `correctedText`. The browser extension sends only one crop and its matching
`ocrText` per item.

Each internal vision request uses one image crop, the corresponding `ocrText`, optional neighboring
text as context, and a bounded correction prompt. The model returns only corrected source text; the
backend wraps it as `{"correctedText":"..."}`. It cannot add, delete, move, resize, merge, or split
OCR regions.
OCR correction uses LM Studio's native `POST /api/v1/chat` image input and passes the configured native
`reasoning` value (normally `off`). It does not send the ineffective OpenAI-compatible
`reasoning_effort` field. The backend wraps the native assistant message as `correctedText` itself, so
the model spends its output budget on transcription instead of reasoning plus JSON-schema generation.

The older synchronous full-page endpoint remains available for existing GUI clients:

Request a tool-free LM Studio vision review for one retained source page:

```http
POST /api/v1/jobs/{jobId}/text-region-reviews
Content-Type: application/json

{
  "sourceImageId": "source-image-3",
  "baseRegionSetRevisionId": "region_set_..."
}
```

The backend loads the authoritative image and text-region snapshot; callers never send filesystem
paths or duplicate OCR input. The configured `translation.defaultTarget.modelId` must identify a
vision-capable model in `translation.lmStudio.baseUrl`. This bounded inference calls LM Studio
directly and does not create an AO conversation. It uses temperature `0` independently of the
translation generation temperature so repeated structured OCR reviews remain stable. Retained WebP
sources are converted to PNG in memory before inference for LM Studio compatibility. The model sees
the existing boxes as fixed visual context and returns only OCR text in the same order. LM Studio
structured output constrains the model to two fields internally:

```json
{
  "count": 2,
  "texts": ["corrected OCR text", "second corrected OCR text"]
}
```

The model cannot add, delete, move, resize, merge, or split OCR regions. The public response remains
`{ count, regions[] }`, but every returned `box` is copied from the authoritative snapshot; only
`regions[].text` comes from the model. A page without existing OCR regions returns an empty read-only
result without invoking LM Studio. Add or adjust boxes through the explicit manual correction API.
The review prompt explicitly requires visual glyph inspection followed by conservative semantic
correction using neighboring regions, reading order, dialogue flow, grammar, and sentence meaning.
It repairs layout-only word fragmentation while forbidding translation, paraphrasing, and invented
dialogue.

Review is read-only. After inspecting or editing the result, apply it with the same concurrency token:

```http
POST /api/v1/jobs/{jobId}/text-region-reviews/apply
Content-Type: application/json

{
  "sourceImageId": "source-image-3",
  "baseRegionSetRevisionId": "region_set_...",
  "count": 2,
  "regions": [
    {"box": [120, 240, 360, 96], "text": "corrected OCR text"},
    {"box": [620, 410, 180, 72], "text": "second corrected OCR text"}
  ]
}
```

The backend requires exactly one item per existing region and requires every box to remain identical
to the immutable snapshot. It converts changed strings into text-only update operations and queues the
existing text-region correction Job. Attempts to add, delete, move, or resize regions return
`422 text_region_review_shape_mismatch`. A stale region-set revision returns `409`; an unchanged review
returns `409 text_region_review_no_changes`. The model never generates internal IDs, geometry,
revision metadata, or Koharu operations.

### Create, update, or delete OCR text regions

Use the IDs and concurrency token returned by `text-regions`; never send upstream processor node IDs:

```http
POST /api/v1/jobs/{parentJobId}/text-region-corrections
Content-Type: application/json

{
  "pages": [{
    "sourceImageId": "source-image-3",
    "baseRegionSetRevisionId": "region_set_...",
    "operations": [
      {"type": "update", "regionId": "text_region_existing", "sourceText": "corrected OCR text"},
      {"type": "create", "clientOperationId": "create-1", "sourceText": "missing OCR text",
       "geometry": {"x": 120, "y": 240, "width": 360, "height": 96, "rotation": 0}},
      {"type": "delete", "regionId": "text_region_false_positive"}
    ]
  }]
}
```

`update` requires `sourceText` and/or `geometry`. `create` requires a unique `clientOperationId`, non-empty
`sourceText`, and bounded geometry. `delete` accepts only an existing opaque `regionId`. A page may
contain any mixture of the three operations, but conflicting operations for one existing region and
duplicate create IDs are rejected before a Job is queued. Existing clients may continue sending the
legacy `regions` array; the backend normalizes each entry to an `update` operation and does not maintain
a second execution path.

Coordinates use the page's declared `source_image_pixels` space and must remain inside its bounds.
Created regions are appended in request order, producing deterministic reading order. The backend owns
both the internal processor node ID and the resulting opaque region ID; `clientOperationId` is only a
correlation key. The successful Job's `result.textRegionOperations.created` maps it to the new
`regionId`.

The backend rejects stale `baseRegionSetRevisionId` values with `409 stale_region_set_revision`.
After the bootstrap detection/OCR pass, corrected pages are reconciled from the immutable source
text-region snapshot plus the submitted operations. Fresh OCR boxes are not treated as authoritative:
unchanged boxes retain their prior text and geometry, updates replace only their declared fields,
deletions stay deleted, and newly detected false positives are discarded before translation/rendering.
It validates the token both when accepting the request and before promotion. Final activation uses a
compare-and-swap over the complete active chapter, so a concurrent revision change cannot publish a
ZIP that disagrees with active page selections.

The response is `202 Accepted` with a queued Translation Job. The backend recreates only the selected
pages, runs detection and OCR, safely maps retained opaque regions, applies one atomic scene mutation
containing add/update/remove operations through the manga-processing port, then runs translate, clean,
render, snapshot, and export. The request is
retained in the Job payload as immutable audit data. A successful correction creates inactive page
revisions during finalization, then atomically promotes them, rebuilds the complete chapter export,
and replaces the active publication. If composition or publication fails, the prior active page
selection remains current. The GUI does not expose revision-history management.

To keep opaque-region mapping stable, text-region correction Jobs inherit the nearest non-correction
ancestor Job's actual detect, font-detect, segmentation, bubble-segmentation, and OCR engines from
`result.engines`. A chain of correction Jobs therefore cannot perpetuate an accidental engine change.
This also preserves the effective engine for legacy Jobs that predate `ocrLanguageResolution`; an omitted
`sourceLanguage` must not silently switch `manga-ocr` to a newer automatic default during correction.
If an inherited engine is no longer available, setup fails explicitly instead of substituting another
engine.

Optional `translationTarget`, `generationOptions`, `sourceLanguage`, `targetLanguage`, and `instructions`
overrides follow the same validation rules as selective retranslation. A mapping failure stops the Job
with `text_region_mapping_failed`; a created node missing from the final scene fails with
`created_text_region_unavailable`. The backend does not guess an upstream node or apply a partial patch.

### List and activate page revisions

Read the revision family from its root Job:

```http
GET /api/v1/jobs/{rootJobId}/page-revisions
```

The response contains the source preflight ID, every source page in chapter order, its immutable
revisions, producing Job and translation settings, optional instructions, content URLs, and the
current `activeRevisionId`. The initial successful Translation Job is active by default. A successful
selective retranslation or text-region correction becomes active automatically after the complete
chapter export and publication are ready.

The activation endpoint is retained for administrative recovery and API clients that explicitly
manage revisions; the normal GUI workflow does not call it. Atomically activate one or more revisions:

```http
POST /api/v1/jobs/{rootJobId}/page-revisions/activate
Content-Type: application/json

{
  "selections": [
    {
      "sourceImageId": "source-image-3",
      "revisionId": "page_revision_abc123"
    },
    {
      "sourceImageId": "source-image-7",
      "revisionId": "page_revision_def456"
    }
  ]
}
```

The operation validates every pair before opening its SQLite transaction, then changes every
selection or none. Repeating the same request is idempotent. A revision from another root or source
page returns `409 page_revision_mismatch`. Selecting an older revision performs a rollback without
deleting newer history.

### Base Convention
- Local/native host: `127.0.0.1`
- Docker publishing: `0.0.0.0`; local clients may still use `127.0.0.1`, while remote clients use
  the Docker host's IP or DNS name
- Default port: `4001`
- Content type: `application/json`
- Job event stream uses `text/event-stream`

AO-facing agent communication is documented separately:
- `docs/AGENT_INTEGRATION.md`

Current AO runtime config lives under the backend user config's `agent` section. The file is selected
by `MANGA_TRANSLATION_CONFIG_PATH`; without an override, the backend uses the OS user config directory.

Example runtime config:
```json
{
  "agent": {
    "baseUrl": "http://127.0.0.1:32768",
    "apiKey": null,
    "model": null,
    "agentName": null,
    "qualityAgentName": "quality-optimizer",
    "knowledgeAgentName": "knowledge-builder",
    "startTimeoutMs": 10000,
    "readyPollIntervalMs": 1000,
    "readyTimeoutMs": 30000,
    "messageTimeoutMs": 300000
  }
}
```

AO conversation rules:
- backend only talks to AO through HTTP API
- backend must call `POST /api/conversations/:id/start`
- backend must poll `GET /api/conversations/:id` until `ready=true`
- backend must not call `POST /api/conversations/:id/message` before ready

### Create translation job
```http
POST /jobs/translation
Content-Type: application/json
```

Request body:
```json
{
  "translationMode": "learning_style",
  "translationTarget": {
    "providerId": "deepl",
    "modelId": "mt"
  },
  "sourceLanguage": ["en", "ja"],
  "targetLanguage": "zh-TW",
  "baseUrl": "http://127.0.0.1:4000",
  "qualityCheck": true,
  "exportFormat": "rendered",
  "mangaId": "phantom_fantasy",
  "mangaLabel": "Phantom Fantasy",
  "translatorId": "translator_team_a_learning_clone",
  "referenceTranslatorId": "translator_team_a",
  "chapterId": "ch_001",
  "sourceChapterId": "source_ch_001",
  "glossaryMode": "canonical"
}
```

`translationMode` is required and must be `quick`, `reference_style`, `local_style`, or `learning_style`.
`translationMode` selects the workflow and is independent from `translationTarget`, which selects the
Koharu translation provider and model. If `translationTarget` is omitted, the backend uses
`translation.defaultTarget` from configuration. Clients must send only `providerId` and `modelId`;
the backend derives whether the target is a local LLM, hosted LLM, or machine-translation provider.
Generation settings are runtime configuration rather than Job payload fields. Configure
`translation.generationOptions.temperature` (`0`–`1`) and `reasoning` (`off`, `on`, `low`, `medium`,
or `high`) through `PATCH /config` before creating a Job. For the configured OpenAI-compatible LM
Studio target, the backend routes Koharu Chat Completions through its local proxy, converts them to
LM Studio Native Chat requests, and enforces both values on every inference call.
Image engines are selected through named `pipeline` profiles. By default, `quick` maps to `fast`
and uses `lama-manga` for `clean`; the other translation modes map to `quality` and use
`flux2-klein`. `pipeline.modeProfiles` changes the mapping and
`pipeline.profiles.<id>.engines` edits a profile. An explicitly configured engine that is absent
from the live Koharu catalog fails before project execution instead of falling back silently.
`sourceLanguage` accepts either one BCP 47 tag or an ordered array. The first language remains the
authoritative source language for Translation Memory, Observation, and Quality. The complete list is
used by the manga-processing adapter to select OCR. Koharu 0.61.2 does not expose OCR language hints,
so the backend records `hintsSupported: false` and `hintsApplied: false`; it never claims that a hint
was applied. An English or mixed-language request will not silently select Japanese-only `manga-ocr`.
If no compatible OCR engine is available, Job setup stops with
`unsupported_ocr_language_combination` before manga-processor project creation or pipeline execution.
The `ocr.language_resolution` Job event and `result.ocrLanguageResolution` use the same diagnostic
shape:

```json
{
  "requestedSourceLanguages": ["en", "ja"],
  "effectiveSourceLanguages": ["en", "ja"],
  "primarySourceLanguage": "en",
  "engineId": "paddle-ocr-vl-1.5",
  "selectionSource": "language_policy",
  "hintsSupported": false,
  "hintsApplied": false,
  "appliedLanguageHints": [],
  "warnings": ["Koharu does not expose OCR language hints; languages were used for engine selection only."]
}
```
Translation jobs also require `mangaId`, `translatorId`, and `chapterId`. These fields identify the
single output publication; chapter numbers do not need to be contiguous.
The backend generates the export directory beneath its configured `paths.translated` root using the
manga, translator, chapter, and Job identifiers. Clients must not send `outputDir`; exported files
are discovered and downloaded through the Job Artifact API. While the desktop GUI is running, a
new successful export is downloaded automatically. The desktop output-folder setting is a local
download destination and is never sent to the backend.
`qualityCheck` controls the optional Quality stage for LLM-backed `reference_style` and `local_style`;
`quick` always skips it and `learning_style` always runs it. When a machine-translation target is used
with `reference_style`, `local_style`, or `learning_style`, the backend automatically runs the existing
AO Quality path as a Reference-aware post-edit according to `translation.machineTranslation` settings.
The Reference prompt is not sent to DeepL, Google Cloud Translation, or Caiyun because those providers
do not consume LLM instructions. Translation jobs never execute
Reference Ingestion. Reference modes consume only completed Reference assets.

### List manga processor translation providers

```http
GET /runtime/manga-processor/translation-providers
```

The response contains a sanitized provider catalog with `providerId`, provider `kind`, readiness,
credential presence, models, and supported languages. It never contains credential values. Known
machine-translation providers are DeepL, Google Cloud Translation, and Caiyun. A provider whose status
is not `ready`, an unknown model, or an unsupported target language is rejected before the backend
creates an upstream processor project or uploads source pages. Koharu is the current adapter.

For Reference-backed modes, `referenceTranslatorId` identifies the read-only translator
Reference that supplies canonical terminology and style evidence. `translatorId` identifies the
output profile. In `learning_style`, that output profile must be a persisted learning clone whose
`styleSourceTranslatorId` equals `referenceTranslatorId`; output chapters, publications, and Local
Knowledge are written only under the clone. The Reference translator is never updated by learning.

Create a learning clone with:

```http
POST /manga/{mangaId}/translators
Content-Type: application/json

{
  "label": "Team A Learning Clone",
  "language": "zh-TW",
  "styleSourceTranslatorId": "translator_team_a"
}
```

The returned profile has `profileKind: "learning_clone"` and preserves its
`styleSourceTranslatorId` lineage. Chapters for learning translations must be created under this
clone profile.

`sourceChapterId` optionally overrides automatic source-chapter matching. Without it, the backend
matches chapter numbers first, then chapter sort order, and falls back to global memory with a warning.
The obsolete translation flags `referenceSetId`, `ingestReference`, and `knowledgeBuilder` are rejected.

Successful managed translations publish one active revision per manga, translator, and chapter. Older
Job artifacts remain immutable history, but their publication status becomes `superseded`. A failed
translation never replaces the current active revision. Successful selective page work publishes a
complete composite chapter rather than exposing a one-page export as the chapter's current download.

### Inspect published translation revisions

```http
GET /translation-publications/{mangaId}?translatorId={translatorId}
GET /translation-publications/{mangaId}?translatorId={translatorId}&chapterId={chapterId}
```

The chapter response includes `activeRevisionId`, immutable revision history, snapshot and export
locations, plus the Knowledge child status. Knowledge commits from superseded revisions are skipped.

### Inspect translation memory
```http
POST /translation/memory/inspect
```

Uses the translation payload context without starting Koharu or AO. It returns readiness, mode policy,
chapter mapping, memory usage, warnings, and the immutable memory fingerprint.

### Preview translation quality and learning
```http
POST /translation/preview
```

Accepts the same mode/context fields plus `translations[]`. It composes the production memory snapshot,
runs Quality when required, applies proposed revisions, and computes a Knowledge dry-run. It never writes
formal glossary, style memory, or Knowledge assets.

Standard Quality uses authoritative `sourceLanguage` and `targetLanguage` metadata to select missing,
source-identical, and structurally mismatched target text before representative sampling. AO receives only
the bounded suspicious windows. Every completeness candidate must be revised or explicitly accepted with
a reason; unresolved candidates add `translation_completeness` to `failedChecks` and block Export.

### Translation Deep Audit

```http
POST /jobs/{translationJobId}/deep-audit
```

Requires a succeeded Translation Job with a final snapshot. Creates a non-blocking
`translation_deep_audit` Job that resumes compatible window checkpoints.

### Create reference extraction job
```http
POST /jobs/reference-extraction
Content-Type: application/json
```

Request body:
```json
{
  "referenceSetId": "ref_001",
  "baseUrl": "http://127.0.0.1:4000",
  "targetLanguage": "zh-TW"
}
```

Required fields:
- `referenceSetId`

Optional fields:
- `baseUrl`
- `targetLanguage`

This job reads `domains/reference/images/<referenceSetId>/`, runs a Koharu extraction pipeline,
and writes:
- `domains/reference/extraction/<referenceSetId>/scene.json`
- `domains/reference/extraction/<referenceSetId>/texts.json`

### Create reference ingestion job
```http
POST /jobs/reference-ingestion
Content-Type: application/json
```

Request body:
```json
{
  "referenceSetId": "ref_001",
  "mangaId": "phantom_fantasy",
  "chapterId": "ch_001",
  "glossaryMode": "canonical"
}
```

This job promotes extracted reference text into:
- `domains/knowledge/self/<mangaId>/canonical_glossary.json`
- `domains/knowledge/self/<mangaId>/story_context.json`
- `domains/knowledge/self/<mangaId>/style_profile.json`
- `domains/knowledge/self/<mangaId>/translation_context.json`

### Read job
```http
GET /jobs/{jobId}
```

Returns:
- current status
- current stage
- original payload
- final result or error
- persisted events
- persisted artifacts

### List jobs
```http
GET /jobs
```

Returns:
- current and recent jobs
- each job with payload, result, error, events, and artifacts

### Stream job list updates
```http
GET /jobs/stream
Accept: text/event-stream
```

Purpose:
- hydrate the GUI job list with an initial `jobs.snapshot`
- push job-summary updates without waiting for periodic polling
- keep `Job List` in an SSE-first sync mode

Current stream event categories:
- `jobs.snapshot`
- `job.created`
- `job.stage`
- `job.completed`
- `job.failed`
- `job.deleted`
- `job.restored`
- `job.purged`
- `job.batch_deleted`
- `job.batch_restored`
- `job.batch_purged`
- `job.trash_cleanup`
- `maintenance.cleanup_completed`

Notes:
- this stream carries job-summary level updates, not full persisted job event history
- `GET /jobs/{jobId}/stream` remains the selected-job detail stream
- GUI should use `GET /jobs` as initial hydrate and `/jobs/stream` as the live-first update channel

### Preview maintenance cleanup
```http
GET /maintenance/cleanup/preview?target=all
```

`target` accepts `logs`, `translated`, `workspaces`, `postedit`, or `all`. Always a dry run;
returns per-target `{ deleted, freedBytes, dryRun: true }` without deleting anything.

### Run maintenance cleanup
```http
POST /maintenance/cleanup
```

Body:

```json
{
  "targets": ["logs", "translated", "workspaces", "postedit"],
  "dryRun": false,
  "translatedRetentionDays": 30
}
```

`"targets": ["all"]` expands to all four targets. `dryRun: true` previews without deleting.
Optional per-call retention overrides (`logRetentionDays`, `logMaxFiles`,
`translatedRetentionDays`, `workspaceRetentionDays`, `postEditRetentionDays`, `olderThanDays`)
fall back to `defaults.*` in backend config. Running jobs are never deleted, paths outside
`DATA_ROOT` are never removed, and Koharu server-side stored projects are never touched.
A non-dry run emits `maintenance.cleanup_completed` on the job stream.

Retention defaults (`GET /config`, editable via `PATCH /config`):

| key | default | meaning |
|---|---|---|
| `defaults.trashRetentionDays` | `30` | trashed DB rows (plus their local dirs, best-effort) |
| `defaults.logRetentionDays` | `14` | `logs/backend/` by file mtime |
| `defaults.logMaxFiles` | `200` | max log files kept (union with age rule) |
| `defaults.translatedRetentionDays` | `30` | `outputs/translated/` + `cache/translated-images/` |
| `defaults.workspaceRetentionDays` | `30` | `workspaces/jobs/<jobId>/` |
| `defaults.postEditRetentionDays` | `30` | `domains/post-edit/<jobId>/` |
| `cleanup.enabled` / `cleanup.intervalMs` | `true` / `3600000` | hourly scheduled `targets: ["all"]` run (skipped when disabled) |

### Read persisted job events
```http
GET /jobs/{jobId}/events
```

Returns:
- ordered persisted event history for the job

### Read persisted job artifacts
```http
GET /jobs/{jobId}/artifacts
```

Returns:
- artifact list
- artifact metadata

### Stream job events
```http
GET /jobs/{jobId}/stream
Accept: text/event-stream
```

Event categories currently emitted:
- `job.created`
- `job.stage`
- `reference_extraction.completed`
- `setup.completed`
- `pipeline.progress`
- `pipeline.metrics`
- `pipeline.completed`
- `quality.completed`
- `knowledge.completed`
- `export.completed`
- `project.closed`
- `job.completed`
- `job.failed`
- `job.cancel_requested`

`pipeline.progress` uses one-based `currentPageIndex`. `completedPages` excludes the active page, so
an event for current page 12 reports 11 completed pages until Koharu advances. `telemetry` preserves
the sanitized raw Koharu step, page, total, percent, status, and whether the observation came from SSE
or polling. When Koharu finishes, the backend emits one terminal progress event with source
`backend_terminal`, `status: completed`, and `completedPages === totalPages` before Export starts.
`progressSemanticsVersion` is `2` for this contract.

`pipeline.metrics` is emitted for both successful and failed translation Pipelines. It summarizes
backend-observed event gaps by page and last-reported engine, including total duration, P50/P90/P95,
slowest spans, provider/model identity, and non-secret prompt metadata. These measurements do not
represent Koharu-internal token usage, provider retries, queue time, or time-to-first-token.
For an LM Studio-backed target, the summary also includes a sanitized snapshot from LM Studio
`GET /api/v1/models`: loaded instance state, selected performance settings, and the model's public
reasoning capability/default. When the native proxy is active, `generationSettings` separately records
the enforced per-request Temperature and Thinking value; capability defaults are never used as proof.

### Retry job
```http
POST /jobs/{jobId}/retry
```

Creates a new job using the previous payload.

### Resume job
```http
POST /jobs/{jobId}/resume
```

Creates a new attempt that reuses compatible AO window checkpoints. This endpoint only accepts a failed job whose `resumeMetadata.resumeAvailable` is true. Quota failures are never retried automatically; transient network and 5xx failures are retried at most once before the job becomes resumable.

Job responses include `outcome` (`clean`, `warnings`, or `partial`), `diagnostics`, and `resumeMetadata`. A semantic `partial` result still uses lifecycle status `succeeded`; deterministic integrity, persistence, Koharu, Export, and AO resource failures use `failed`.

### Cancel job
```http
POST /jobs/{jobId}/cancel
```

Cancellation is cooperative outside external operations. While a Koharu pipeline is active, the backend
also sends `DELETE /api/v1/operations/{operationId}` to Koharu and marks the Job `canceled` only after
Koharu acknowledges the stop request. If that request fails, the Job becomes `failed` with
`koharu_cancel_failed` diagnostics because the remote operation may still be running.

### Read resolved config
```http
GET /config
```

`translation.generationOptions` controls the Temperature and reasoning values enforced by the native
proxy. `translation.lmStudio.baseUrl` points from Backend to LM Studio; Docker normally uses
`host.docker.internal`. `translation.lmStudio.koharuProxyBaseUrl` is the host-visible Backend URL that
Koharu uses instead of connecting to LM Studio directly.

### Health check
```http
GET /health
```

`/health` is a liveness check. HTTP `200` means only that the backend process is running; it does
not imply that Koharu or AO can be reached.

### Readiness check
```http
GET /ready
```

This endpoint is public like `/health`, and is also available as `GET /api/v1/ready`. It returns
HTTP `200` when manga-processing jobs can run and HTTP `503` when the configured processor is
unavailable. AO is an optional dependency at this level because some translation modes do not use it; when the processor is
ready but AO is unavailable, the response is HTTP `200` with `status: "degraded"`.

In native mode, backend startup and Koharu-backed requests may call the managed runtime's
`ensureRunning()`. In Docker mode, `koharuRuntime.managed` is `false`: the backend only probes
`http://host.docker.internal:4000`. The desktop GUI may own that Windows host process, or an operator
must start it with `--host 0.0.0.0 --port 4000 --headless` before submitting Koharu-backed work.

```json
{
  "ok": false,
  "status": "blocked",
  "checkedAt": "2026-10-02T06:45:00.000Z",
  "deploymentMode": "docker",
  "services": {
    "backend": { "required": true, "ready": true, "status": "ready" },
    "mangaProcessor": {
      "required": true,
      "ready": false,
      "status": "unavailable",
      "mode": "external",
      "baseUrl": "http://host.docker.internal:4000",
      "providerId": "koharu",
      "providerName": "Koharu"
    },
    "ao": { "required": false, "ready": true, "status": "ready", "baseUrl": "http://host.docker.internal:32768" }
  },
  "capabilities": { "mangaProcessingJobs": false, "aoJobs": true },
  "blockers": [
    { "service": "manga_processor", "code": "manga_processor_unavailable", "message": "Manga processor is not reachable." }
  ],
  "warnings": []
}
```

Creation, retry, and resume requests for manga-processing jobs fail before mutating job storage when
the configured processor cannot be started or reached:

```json
{
  "error": "External Koharu service is unavailable at http://host.docker.internal:4000.",
  "code": "manga_processor_unavailable",
  "details": {
    "service": "manga_processor",
    "jobType": "translation",
    "status": "unavailable",
    "mode": "external",
    "baseUrl": "http://host.docker.internal:4000",
    "retrySafe": true
  }
}
```

### Runtime status
```http
GET /runtime/status
```

Returns:
- backend status
- manga processor provider identity and configured base URL
- manga processor ownership mode (`managed` for native runtime or `external` for Docker)
- AO configured base URL and agent selection
- quality runtime summary
- translation runtime summary

Runtime lifecycle and catalog endpoints are provider-neutral:

```http
GET  /runtime/manga-processor/engines
GET  /runtime/manga-processor/translation-providers
GET  /runtime/manga-processor/paths
POST /runtime/manga-processor/install
POST /runtime/manga-processor/start
POST /runtime/manga-processor/prepare
POST /runtime/manga-processor/stop
```

Lifecycle responses use the `mangaProcessor` envelope. The concrete provider is identified by
`providerId` and `providerName`; the current implementation reports `koharu` and `Koharu`.

### Read manga glossary
```http
GET /knowledge/{mangaId}/glossary
```

### Read manga style profile
```http
GET /knowledge/{mangaId}/style-profile
```

### Read manga story context
```http
GET /knowledge/{mangaId}/story-context
```

## AO Conversation Interface
This is an internal backend-facing integration boundary, not a public backend API.

The backend initializes AO in this order:
- `POST /api/conversations`
- config upload to `workspace/.opencode/opencode.json`
- `PUT /api/conversations/:id/agent/config`
- `PUT /api/conversations/:id/agents`
- `POST /api/conversations/:id/skills/upload`
- `POST /api/conversations/:id/start`
- ready polling through `GET /api/conversations/:id`
- `POST /api/conversations/:id/message`
- `DELETE /api/conversations/:id`

## Upstream Koharu API

### Base Convention
- Base URL default: `http://127.0.0.1:4000/api/v1`
- Default content type: `application/json`

### Projects
```http
GET /projects
POST /projects
PUT /projects/current
DELETE /projects/current
```

### Pages
```http
POST /pages/from-paths
POST /pages
```

### LLM
```http
GET /llm/current
PUT /llm/current
DELETE /llm/current
GET /llm/catalog
```

### Engines
```http
GET /engines
```

### Pipelines and Operations

Pipeline monitoring uses the configured timeout as an inactivity limit. Continued page or engine
progress keeps a long-running operation alive. A Translation Job cannot succeed unless its export
contains exactly one rendered image for every selected source image.
```http
POST /pipelines
GET /operations
DELETE /operations/{id}
```

### Scene and History
```http
GET /scene.json
POST /history/apply
POST /history/undo
POST /history/redo
```

### Export
```http
POST /projects/current/export
```

Formats:
- `rendered`
- `psd`
- `khr`
- `inpainted`

### Events
```http
GET /events
Accept: text/event-stream
```

Known upstream event types:
- `jobStarted`
- `jobProgress`
- `jobWarning`
- `jobFinished`
- `snapshot`

## Backend Module Mapping
- `backend/src/integrations/koharu/pipeline/project_setup.js`
- `backend/src/integrations/koharu/pipeline/pipeline_monitor.js`
- `backend/src/domains/translation/quality/quality.js`
- `backend/src/domains/knowledge/learning/knowledge.js`
- `backend/src/domains/translation/execution/export.js`
- `backend/src/domains/manga_processing/manga_processing_ports.js`
- `backend/src/integrations/koharu/koharu_manga_processing_adapter.js`
- `backend/src/domains/reference/sets/reference_sets.js`
- `backend/src/integrations/koharu/client/koharu_client.js`

## Reference Observation API

- `GET /references/:id/observation`
- `POST /references/:id/observation/rebuild`
- `POST /references/:id/deep-review`
- `GET /knowledge/:mangaId/bilingual-evidence?translatorId=...`
- `POST /knowledge/:mangaId/bilingual-enrichment?translatorId=...`
- `PUT /knowledge/:mangaId/bilingual-evidence/links/:linkId`

The link update action is `accept`, `unbind`, or `bind`. Manual binding requires valid
`sourceNodeKeys` and `targetNodeKeys` from current Observations.

## Reference Asset Files
Reference processing uses these backend-owned file conventions:
- `domains/reference/manifests/<reference_set_id>.json`
- `domains/reference/extraction/<reference_set_id>/texts.json`
- `domains/reference/extraction/<reference_set_id>/chapter_observation.json`
- `domains/reference/extraction/<reference_set_id>/observations/<cache_key>.json`
- `domains/reference/extraction/<reference_set_id>/deep_reviews/<revision_id>.json`
- `domains/knowledge/self/<manga_id>/<translator_id>/bilingual_evidence.json`
- `domains/knowledge/self/<manga_id>/<translator_id>/bilingual_evidence_ledger.json`
- `domains/knowledge/self/<manga_id>/<translator_id>/bilingual_ledger_revisions/`
- `domains/knowledge/self/<manga_id>/<translator_id>/bilingual_runs/checkpoints/`

`reference_stream.json`, `dialogue_alignment.json`, and persisted TextRole evidence are not runtime
contracts.

## Quality Validation Report
Standard Quality writes backend-owned artifacts:
- `quality_context_projection`
- `quality_window_checkpoint`
- `quality_validation_report`
- `learning_evidence_snapshot`
- `translation_deep_audit_report` for manual full audits

Typical paths are under `workspaces/jobs/<jobId>/standard_quality/` and the Translation workspace.

This report is the formal quality-stage output.
Legacy comparison artifacts should be treated as transitional diagnostics, not the main quality result.

Current report shape includes:
- `overall`
- `score`
- `issues`
- `warnings`
- `passedChecks`
- `failedChecks`
- `usedKnowledgeSources`
- `coverage`, `candidateReasonCounts`, `windowCount`, `inputBytes`, `elapsedMs`

## Lifecycle Policy
- `DELETE /projects/current` means close, not delete
- close clears the current-open state only
- default workflow never deletes the stored project
# Translation Quality And Deep Audit

The translation workflow performs a full-chapter lightweight Quality Observation before specialist repair. Standard Quality is autonomous: unresolved terminology, meaning, story, style, fluency, empty translation, sequence, and locked-term findings are published as warnings and excluded from Knowledge learning. They no longer block Export. Publication records expose `completenessStatus`, warning counts, and excluded node IDs so incomplete output is visible without contaminating learned evidence.

- `GET /jobs/:id/deep-audit/review` returns the page-grouped review package for a completed Deep Audit job.
- `POST /jobs/:id/deep-audit/apply` accepts `decisions[]` and creates a `translation_deep_audit_apply` job.
- `POST /jobs/:id/quality-repair` creates a revalidation job from an existing Koharu project and Translation Memory snapshot without rerunning OCR or initial translation.

The page-grouped review and decision APIs are used by manually requested Deep Audit jobs. Decision actions are `accept_proposal`, `manual_edit`, `confirm_current`, and `ignore_and_publish`. Ignored evidence is published only by explicit user override and is never eligible for Knowledge learning.

Publication records use schema version 2 and include `qualityStatus`, `qualityReportPath`, `qualityObservationFingerprint`, `verifiedAt`, and `manualOverrideCount`. Runtime loading validates this schema strictly and never rewrites legacy publication data.

Publication Quality status is `passed`, `not_applicable`, or `unverified`. New publications may only use `passed` or `not_applicable`; `unverified` preserves historical revisions and blocks Local Memory while active. The one-time `backend/scripts/migrate_translation_publications_v2.js` command creates a backup before replacing the retired `pending_revalidation` value.

`POST /jobs/:id/knowledge-retry` creates only a missing Knowledge child for an active, Quality-passed publication with persisted learning evidence. It does not rerun Koharu translation or Quality and rejects committed or superseded revisions. An incomplete publication may still learn from its verified subset; excluded nodes never enter the Learning Evidence snapshot.

Job execution types are owned by `backend/src/domains/jobs/contracts/job_contracts.js`. Workflow-only types cannot enter the atomic worker, and unknown types are rejected before persistence rather than falling back to translation.

Knowledge enrichment uses the v3 fixed-line contract. Terminology records require an allowed durable category and source/target evidence node IDs. Character records carry original and target identities, while style records select a verified evidence node and let the backend copy role, channel, speaker, and confidence metadata. Unsupported legacy categories are not interpreted at runtime; `backend/scripts/migrate_knowledge_contract_v3.js` backs up the Knowledge file and quarantines ambiguous entries before migration.
