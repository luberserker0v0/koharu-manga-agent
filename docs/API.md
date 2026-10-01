# MangaTranslationAgent API Notes

This document now covers two API layers:
- the local backend API exposed by `backend/server.js`
- the upstream Koharu HTTP API consumed by the backend

## Local Backend API

Browser clients should use the versioned `/api/v1` prefix. Existing unversioned routes remain available during the backend-client migration.

For the complete upload, preflight, Translation Job, SSE, and artifact-download lifecycle, see `docs/REST_WORKFLOW.md`. The executable reference client is `scripts/rest_translation_workflow.mjs`.

### Browser upload sessions

Create a source-chapter or Reference upload session:

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

Complete and inspect the session:

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

Each image entry contains stable `encodedUrl` and `contentUrl` fields. Read one image as Base64 JSON:

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

### Base Convention
- Host: `127.0.0.1`
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
  "targetLanguage": "zh-TW",
  "baseUrl": "http://127.0.0.1:9999",
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
Translation jobs also require `mangaId`, `translatorId`, and `chapterId`. These fields identify the
single output publication; chapter numbers do not need to be contiguous.
The backend generates the export directory beneath its configured `paths.translated` root using the
manga, translator, chapter, and Job identifiers. Browser clients must not send `outputDir`; exported
files are discovered and downloaded through the Job Artifact API. A trusted desktop deployment may
temporarily supply an optional `outputDir` override for its native folder-picker integration. An
override outside the backend data root is not downloadable through the Artifact Content API.
`qualityCheck` controls the optional Quality stage for LLM-backed `reference_style` and `local_style`;
`quick` always skips it and `learning_style` always runs it. When a machine-translation target is used
with `reference_style`, `local_style`, or `learning_style`, the backend automatically runs the existing
AO Quality path as a Reference-aware post-edit according to `translation.machineTranslation` settings.
The Reference prompt is not sent to DeepL, Google Cloud Translation, or Caiyun because those providers
do not consume LLM instructions. Translation jobs never execute
Reference Ingestion. Reference modes consume only completed Reference assets.

### List Koharu translation providers

```http
GET /runtime/koharu/translation-providers
```

The response contains a sanitized provider catalog with `providerId`, provider `kind`, readiness,
credential presence, models, and supported languages. It never contains credential values. Known
machine-translation providers are DeepL, Google Cloud Translation, and Caiyun. A provider whose status
is not `ready`, an unknown model, or an unsupported target language is rejected before the backend
creates a Koharu project or uploads source pages.

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
translation never replaces the current active revision.

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
  "baseUrl": "http://127.0.0.1:9999",
  "targetLanguage": "zh-TW"
}
```

Required fields:
- `referenceSetId`

Optional fields:
- `baseUrl`
- `targetLanguage`

This job reads `references/other_images/<referenceSetId>/`, runs a Koharu extraction pipeline,
and writes:
- `references/extracted/<referenceSetId>/scene.json`
- `references/extracted/<referenceSetId>/texts.json`

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
- `knowledge_base/self/<mangaId>/canonical_glossary.json`
- `knowledge_base/self/<mangaId>/story_context.json`
- `knowledge_base/self/<mangaId>/style_profile.json`
- `knowledge_base/self/<mangaId>/translation_context.json`

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

Notes:
- this stream carries job-summary level updates, not full persisted job event history
- `GET /jobs/{jobId}/stream` remains the selected-job detail stream
- GUI should use `GET /jobs` as initial hydrate and `/jobs/stream` as the live-first update channel

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
- `pipeline.completed`
- `quality.completed`
- `knowledge.completed`
- `export.completed`
- `project.closed`
- `job.completed`
- `job.failed`
- `job.cancel_requested`

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

Cancellation is cooperative and handled by the workflow engine.

### Read resolved config
```http
GET /config
```

### Health check
```http
GET /health
```

### Runtime status
```http
GET /runtime/status
```

Returns:
- backend status
- Koharu configured base URL
- AO configured base URL and agent selection
- quality runtime summary
- translation runtime summary

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
- Base URL default: `http://127.0.0.1:9999/api/v1`
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
- `backend/src/integrations/koharu/pipeline/project_lifecycle.js`
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
- `references/manifests/<reference_set_id>.json`
- `references/extracted/<reference_set_id>/texts.json`
- `references/extracted/<reference_set_id>/chapter_observation.json`
- `references/extracted/<reference_set_id>/observations/<cache_key>.json`
- `references/extracted/<reference_set_id>/deep_reviews/<revision_id>.json`
- `knowledge_base/self/<manga_id>/<translator_id>/bilingual_evidence.json`
- `knowledge_base/self/<manga_id>/<translator_id>/bilingual_evidence_ledger.json`
- `knowledge_base/self/<manga_id>/<translator_id>/bilingual_ledger_revisions/`
- `knowledge_base/self/<manga_id>/<translator_id>/bilingual_runs/checkpoints/`

`reference_stream.json`, `dialogue_alignment.json`, and persisted TextRole evidence are not runtime
contracts.

## Quality Validation Report
Standard Quality writes backend-owned artifacts:
- `quality_context_projection`
- `quality_window_checkpoint`
- `quality_validation_report`
- `learning_evidence_snapshot`
- `translation_deep_audit_report` for manual full audits

Typical paths are under `cache/workspaces/<jobId>/standard_quality/` and the Translation workspace.

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
