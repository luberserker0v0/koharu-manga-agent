# MangaTranslationAgent Architecture

## Overview
The official runtime is now a **process-trigger backend**.

The repository is split into three runtime-facing layers:
- `backend/`: workflow, validation, persistence, AO HTTP integration, and Koharu HTTP integration
- `gui/`: Electron client plus optional native backend and host-Koharu process ownership
- `backend/ao/`: assets uploaded into temporary AO conversations

The repository has no root `.opencode/` runtime. The backend never accesses an AgentOrchestrator
project workspace on disk; it uploads the canonical `backend/ao/` assets through AO HTTP APIs.

Primary runtime entrypoint:

```bash
node backend/server.js
```

## Runtime Layers

### API Server
The local HTTP API is the single control surface for future CLI and GUI clients.

Current endpoints:
- `POST /jobs/translation`
- `POST /jobs/:jobId/retranslations`
- `GET /jobs/:rootJobId/page-revisions`
- `POST /jobs/:rootJobId/page-revisions/activate`
- `GET /jobs/:jobId/translated-images`
- `POST /jobs/reference-extraction`
- `POST /jobs/reference-ingestion`
- `GET /jobs/:jobId`
- `GET /jobs/:jobId/stream`
- `POST /jobs/:jobId/retry`
- `POST /jobs/:jobId/cancel`
- `GET /config`
- `GET /knowledge/:mangaId/glossary`
- `GET /knowledge/:mangaId/style-profile`
- `GET /knowledge/:mangaId/story-context`

### Job Manager
`backend/src/domains/jobs/job_manager.js` is a façade. It preserves the API consumed by HTTP routes
and domain services while delegating cohesive responsibilities:

- `factory/`: job and generic workflow creation
- `queue/`: queue draining and Koharu review leases
- `lifecycle/`: recovery, execution, completion, cancellation, deletion, retry, and resume
- `runtime/`: atomic job dispatch, Koharu readiness, and runtime status
- `queries/`: job/event/artifact read models
- `events/`: persistence-backed event publication and subscriptions
- `maintenance/`: trash retention and cleanup orchestration
- `workflows/`: Reference and Translation workflow construction and dependency state

SQLite remains the persistence owner; workflow modules do not invent storage schemas or bypass the
job store.

Persistence tables:
- `jobs`
- `job_events`
- `job_artifacts`
- `job_errors`
- `translation_page_revisions`
- `translation_page_active_revisions`

Selective retranslations are ordinary Translation Jobs and therefore reuse the existing queue,
SSE, events, diagnostics, cancellation, and artifact lifecycle. Their payload contains immutable
root/parent/source-image lineage. Successful output is registered as inactive per-page revisions;
the active mapping changes only through one SQLite transaction in the activation endpoint.

### Workflow Engine
The workflow engine owns all translation control flow.

Formal stage order:
1. setup project
2. upload pages
3. load LLM
4. resolve the translation mode's named pipeline profile and validate its engines
5. start pipeline
6. monitor pipeline
7. optional quality review
8. optional knowledge-base update
9. export
10. close current project

Active pipeline cancellation crosses the same ownership boundary: the GUI requests cancellation from
the backend, and the pipeline monitor stops the matching Koharu operation through
`DELETE /api/v1/operations/:operationId`. A failed stop acknowledgement is preserved as a Job failure;
the backend does not report an unconfirmed remote stop as `canceled`.

### AO HTTP Boundary
AO is the only LLM execution boundary. The backend does not load `agent_sdk`, provider registries,
generic provider adapters, or compatibility layers.

For every AO task, the backend:

1. creates a temporary conversation;
2. uploads `opencode.json`, `AGENTS.md`, task agents, docs, and skills;
3. starts the conversation and polls until `ready === true`;
4. sends the task message;
5. validates the task-specific output contract;
6. deletes the temporary conversation unless preservation was explicitly requested for debugging.

The backend owns retries, timeouts, IDs, schema validation, persistence, export, and close sequencing.
AO supplies semantic values and evidence only. See `docs/AGENT_INTEGRATION.md`.

### Koharu Client
`backend/src/integrations/koharu/client/koharu_client.js` is the formal low-level Koharu wrapper.

It owns:
- Koharu HTTP request helpers
- provider-neutral translation catalog and target selection
- pipeline start
- operation polling
- scene access
- export
- current-project close

Workflow mode and translation target are separate contracts. `quick`, `reference_style`,
`local_style`, and `learning_style` may use local/hosted LLMs or Machine Translation. Machine
Translation produces the initial draft; Reference/Local workflows reuse the AO Quality contract for
post-edit before export. Provider credentials remain owned by Koharu and are never persisted by the
backend.

## Module Ownership

### Core Workflow Modules
- `backend/src/integrations/koharu/pipeline/project_setup.js`
  - owns Koharu project creation, page upload, and pipeline planning
- `backend/src/integrations/koharu/pipeline/pipeline_monitor.js`
  - replaces `pipeline-runner`
  - owns late-attach recovery and fast-finish handling
- `backend/src/domains/translation/quality/quality.js`
  - replaces `quality-checker`
  - owns bounded AO-assisted validation and validated revision application
- `backend/src/domains/knowledge/learning/knowledge.js`
  - replaces `knowledge-builder`
  - uses AO HTTP tasks for semantic enrichment of backend-owned learning evidence
- `backend/src/domains/translation/execution/export.js`
  - owns export behavior
- `backend/src/integrations/koharu/pipeline/project_lifecycle.js`
  - owns close behavior

Current implementation note:
- the target architecture treats `quality` as read-only validation
- the current runtime now uses knowledge-driven validation and no longer performs quality-triggered rerender
- some legacy comparison helpers and historical artifacts still remain in the repository, but they are not part of the primary quality path

### Non-Workflow Modules
- `backend/src/domains/jobs/maintenance/job_maintenance.js`
  - trash retention
  - cleanup orchestration
- `backend/src/domains/maintenance/cleanup_service.js`
  - owns the file cleanup policy for `logs`, translated output, job workspaces, and post-edit documents
  - exposes preview/execute runs; the hourly scheduler is started from `backend/src/runtime.js` and stopped with the API server

### Agent Integration Modules
- `backend/src/integrations/ao/client/ao_client.js`
- `backend/src/integrations/ao/assets/ao_assets.js`
- `backend/src/integrations/ao/tasks/ao_tasks.js`
- `backend/src/integrations/ao/contracts/ao_contracts.js`

These now form the AO-only integration layer. The backend no longer keeps a
generic provider registry, SDK-loaded runtime adapter, or `agent_sdk`
compatibility abstraction.

## Runtime Policy
- backend configuration lives in the OS user config directory, or at `MANGA_TRANSLATION_CONFIG_PATH`
- when the selected config file is absent, backend defaults apply until the backend API persists a
  user configuration; Docker separately seeds `/data/config/koharu.json` from `docker/koharu.json`
- request payloads may override config values
- default workflow never deletes stored Koharu projects
- `close project` always means `DELETE /projects/current`
- backend returns structured job status and error data
- `QQ` belongs to the outer agent response layer, not the backend transport layer
- AO tasks must run inside isolated per-job stage workspaces

## Reference Comparison Layout
The quality workflow can consume a reference set through `referenceSetId`.

Reference assets live under:
- `domains/reference/images/<reference_set_id>/`
- `domains/reference/extraction/<reference_set_id>/`
- `domains/reference/comparisons/<reference_set_id>/` (optional diagnostics)
- `domains/reference/manifests/<reference_set_id>.json`

`domains/reference/comparisons/` stores optional diagnostics.
It is not part of the primary quality-validation contract.

Process expectations:
1. user provides other-translation images under `other_images/`
2. Koharu extraction produces normalized `texts.json` under `extracted/`
3. the backend promotes extracted reference text into normalized project assets
4. any retained comparison outputs are transitional diagnostics only

## Knowledge Base Layout
Knowledge artifacts live under:
- `domains/knowledge/self/default.json`
- `domains/knowledge/reports/extract_report.json`

V2 separates:
- fact-layer `translation_pairs`
- inferred `terminology`
- inferred `characters`
- inferred `style_profile`
- inferred `style_examples`

Reference-promoted translation assets now also include:
- `domains/knowledge/self/<mangaId>/canonical_glossary.json`
- `domains/knowledge/self/<mangaId>/story_context.json`
- `domains/knowledge/self/<mangaId>/style_profile.json`
- `domains/knowledge/self/<mangaId>/translation_context.json`

## Agent Workspace Isolation
External agent communication must not operate directly in repo root.

Design target:
- `workspaces/jobs/<jobId>/<stage>/input/`
- `workspaces/jobs/<jobId>/<stage>/output/`
- `workspaces/jobs/<jobId>/<stage>/artifacts/`

The backend remains the only writer for canonical storage:
- `domains/knowledge/`
- `domains/reference/`
- backend-owned export directory beneath `paths.translated`; clients cannot override or observe its filesystem path

Current agent audit artifacts:
- `workspaces/jobs/<jobId>/<stage>/artifacts/import_manifest.json`
- `workspaces/jobs/<jobId>/<stage>/artifacts/export_manifest.json`

These manifests record:
- what the backend materialized into the isolated workspace
- what outputs were accepted
- what outputs were rejected and why

## GUI Contract
The GUI is now an explicit product target for the backend.

High-level GUI requirements are defined in:
- `docs/GUI_SPEC.md`

Important GUI-facing runtime rules:
- refreshing or closing the GUI must not interrupt backend jobs
- the GUI must restore state from backend snapshot plus live stream
- interaction history must remain reconstructible from SQLite and disk artifacts
- local source and reference paths stay inside Electron; the backend receives uploaded bytes and an `uploadId`
- the GUI downloads artifacts through HTTP into its local output folder instead of opening backend paths

## Repository Shape
```text
comics/1/
|- backend/
|  |- ao/
|  |- scripts/
|  |- server.js
|  `- src/
|     |- domains/
|     |- http/
|     |- integrations/
|     |- config.js
|     |- config_service.js
|     `- runtime.js
|- docker/
|- docs/
|- gui/
|- scripts/
`- tests/
```

Runtime state is not part of the repository tree. Native and packaged backends use the OS data
directory; Docker uses `/data`. Both follow the modular layout documented in
`docs/BUILD_AND_PACKAGE.md`.
