# MangaTranslationAgent API Notes

This document now covers two API layers:
- the local backend API exposed by `backend/server.js`
- the upstream Koharu HTTP API consumed by the backend

## Local Backend API

### Base Convention
- Host: `127.0.0.1`
- Default port: `4001`
- Content type: `application/json`
- Job event stream uses `text/event-stream`

AO-facing agent communication is documented separately:
- `docs/AGENT_INTEGRATION.md`

Current AO runtime config lives under:
- `.opencode/koharu.json -> agent`

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
`qualityCheck` only controls the optional Quality stage for `reference_style` and `local_style`;
`quick` always skips it and `learning_style` always runs it. Translation jobs never execute
Reference Ingestion. Reference modes consume only completed Reference assets.

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
- `backend/src/modules/project_setup.js`
- `backend/src/modules/pipeline_monitor.js`
- `backend/src/modules/quality.js`
- `backend/src/modules/knowledge.js`
- `backend/src/modules/export.js`
- `backend/src/modules/project_lifecycle.js`
- `backend/src/modules/reference_sets.js`
- `backend/src/koharu_client.js`

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
# Translation Quality Review

The translation workflow performs a full-chapter lightweight Quality Observation before specialist repair. Standard Quality is autonomous: unresolved terminology, meaning, story, style, and fluency findings are published as provisional warnings and are excluded from Knowledge learning. Later chapter evidence may increase their coverage and confidence. Empty translations, sequence shifts, and locked-term violations remain structural blockers; if automatic repair cannot resolve them, the job fails instead of requesting user labeling.

- `GET /jobs/:id/quality-review` returns the page-grouped review package.
- `POST /jobs/:id/quality-review/confirm` accepts `decisions[]` and creates a `translation_quality_finalize` job.
- `POST /jobs/:id/quality-repair` creates a revalidation job from an existing Koharu project and Translation Memory snapshot without rerunning OCR or initial translation.

The page-grouped review and decision APIs are used by manually requested Deep Audit jobs. Decision actions are `accept_proposal`, `manual_edit`, `confirm_current`, and `ignore_and_publish`. Ignored evidence is published only by explicit user override and is never eligible for Knowledge learning.

Publication records include `qualityStatus`, `qualityReportPath`, `qualityObservationFingerprint`, `verifiedAt`, and `manualOverrideCount`. Legacy publications are migrated to `pending_revalidation` and excluded from Local Memory until superseded by a verified publication.
