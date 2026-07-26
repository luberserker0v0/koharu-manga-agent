# Manga Translation Process Backend

This repository now centers on a process-trigger backend for Koharu-based manga translation.

## Main Entry

```bash
node backend/server.js
```

## GUI Startup
The GUI can now manage backend startup automatically.

For normal desktop usage:

```bash
cd gui
npm run preview
```

Startup behavior:
- if backend is already running on `http://127.0.0.1:4001`, the GUI connects to it as `external`
- if backend is not running, Electron starts `node backend/server.js` as a managed child process
- closing the GUI stops only a GUI-managed backend
- closing the GUI does not stop an externally started backend

Runtime requirement:
- the backend uses Node built-in `node:sqlite`
- backend startup must use a real Node runtime
- if backend is launched with the wrong executable, you may see `no such built-in module sqlite`

## Backend API
- `POST /jobs/translation`
- `POST /jobs/reference-extraction`
- `POST /jobs/reference-ingestion`
- `GET /jobs/stream`
- `GET /jobs/:jobId`
- `GET /jobs/:jobId/stream`
- `POST /jobs/:jobId/retry`
- `POST /jobs/:jobId/cancel`
- `GET /config`
- `GET /knowledge/:mangaId/glossary`
- `GET /knowledge/:mangaId/style-profile`
- `GET /knowledge/:mangaId/story-context`

## Runtime Shape
- local HTTP backend for future CLI and GUI clients
- workflow engine inside the process
- AO API is the only LLM execution boundary for quality and knowledge tasks
- AO task stages record `import_manifest.json` and `export_manifest.json`
- AO conversations are created per stage, initialized over HTTP, polled until `ready=true`, then used for task messages
- each agent stage records `import_manifest.json` and `export_manifest.json`
- Koharu HTTP API remains the external execution target

AO integration notes:
- all AO interactions go through the AO HTTP API
- AO runtime assets live under `backend/ao/`
- `backend/ao/opencode/opencode.json` is uploaded into each AO workspace before `start`
- backend polls `GET /api/conversations/:id` until `ready=true` before `POST /api/conversations/:id/message`

## Reference Diagnostic Assets
Legacy reference diagnostics still use a dedicated `references/` tree:

```text
references/
|- other_images/<reference_set_id>/
|- extracted/<reference_set_id>/
|- comparisons/<reference_set_id>/
`- manifests/<reference_set_id>.json
```

The `comparisons/` subtree is transitional diagnostic output only.
The formal quality-stage result is the read-only `quality_validation_report` artifact written by the backend.

When reference images are ready, place them under:

```text
references/other_images/<reference_set_id>/
```

and add the matching manifest under:

```text
references/manifests/<reference_set_id>.json
```

Then extract the reference set through the backend:

```http
POST /jobs/reference-extraction
Content-Type: application/json

{
  "referenceSetId": "ref_001"
}
```

If the provided images are actually AVIF files with misleading extensions, convert them first:

```bash
node backend/scripts/convert_reference_images.js --reference-set-id ref_001
```

## Knowledge Base Design
Knowledge artifacts live under:
- `knowledge_base/self/my-manga.json`
- `knowledge_base/reports/extract_report.json`
- `knowledge_base/index.json`

Planned v2 references:
- `knowledge_base/self/my-manga.schema.example.json`
- `knowledge_base/reports/migration_plan_v2.md`

For manga-scoped knowledge storage, translation jobs may provide:
- `translationMode` (required)
- `mangaId`
- `mangaLabel`
- `translatorId`
- `chapterId`
- `sourceChapterId`
- `glossaryMode`

Translation jobs never run Reference Ingestion. Reference and learning modes compose completed
Reference assets and self-learning data into an immutable Translation Memory snapshot. Local and
learning modes schedule Knowledge as a non-blocking child after the corrected final snapshot is exported.

Reference ingestion promotes extracted reference text into reusable manga-scoped assets:
- `knowledge_base/self/<mangaId>/canonical_glossary.json`
- `knowledge_base/self/<mangaId>/story_context.json`
- `knowledge_base/self/<mangaId>/style_profile.json`

## AO Runtime Assets
- `backend/ao/AGENTS.md`
- `backend/ao/agents/*`
- `backend/ao/skills/*`
- `backend/ao/opencode/opencode.json`

These are uploaded into each AO conversation workspace at runtime.

## Important Config
Config file: `.opencode/koharu.json`

Important fields:
- `api.baseUrl`
- `llm.defaultModel`
- `timeouts.*`
- `paths.*`
- `defaults.targetLanguage`
- `defaults.exportFormat`
- `engines.*`

## Tests
```bash
npm test --prefix tests
npm run test:unit --prefix tests
npm run test:integration --prefix tests
npm run test:e2e --prefix tests
npm run test:coverage --prefix tests
```

AO-runtime specific coverage now includes:
- AO HTTP client polling and message dispatch
- AO asset zip packaging and upload preparation
- quality optimization and knowledge enrichment result validation

## Design Docs
- `docs/ARCHITECTURE.md`
- `docs/API.md`
- `docs/WORKFLOW.md`
- `docs/SRS.md`
- `docs/STD.md`
- `docs/AGENT_INTEGRATION.md`
- `docs/GUI_SPEC.md`
- `docs/GUI_IA_UX.md`
- `docs/JOB_DETAIL_SPEC.md`
- `docs/E2E_MATRIX.md`
- `docs/GUI_SCAFFOLD_PLAN.md`
- `docs/GUI_SMOKE_CHECKLIST.md`
- `docs/QUALITY_KNOWLEDGE_REFERENCE_SPEC.md`

GUI design notes:
- `docs/GUI_SPEC.md` captures the formal v1 screen and state requirements
- `docs/GUI_IA_UX.md` captures the user-first page, pane, tab, and scroll strategy
- `docs/JOB_DETAIL_SPEC.md` captures the selected-job workspace and progress presentation model
- `docs/E2E_MATRIX.md` captures the mixed local-environment e2e inventory, gate levels, and automated/manual/hybrid coverage split
- `docs/QUALITY_KNOWLEDGE_REFERENCE_SPEC.md` captures the new target responsibility split between upstream reference assets, long-term knowledge accumulation, and read-only quality validation
- the current GUI direction treats artifacts as job-scoped detail tabs inside `Job List`
- the current `Job List` workspace includes terminal-job delete-to-trash, restore/undo protection, permanent delete from Trash, checkbox batch actions, filtering, keyword search, sorting controls, and a collapsible/resizable list pane
- trashed jobs are automatically cleaned after the configured retention window (default: 30 days)
- `Job List` now uses `GET /jobs` for initial hydrate and `GET /jobs/stream` as the primary live sync channel, with fallback polling only when SSE is unavailable
- the `Job List` header shows a live-sync badge so users can tell whether list updates are flowing live, reconnecting, or falling back to polling
