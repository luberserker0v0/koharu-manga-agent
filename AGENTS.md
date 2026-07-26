# Manga Translation System

## Scope
This file contains repository-level instructions for coding agents working on this project.
It is not an AO runtime prompt and must not define task-specific manga analysis behavior.

AO runtime instructions belong under `backend/ao/`:
- `backend/ao/AGENTS.md` contains the primary AO agent rules and routing index.
- `backend/ao/agents/*.md` contains task-specific subagent instructions.
- `backend/ao/skills/*/SKILL.md` contains task contracts and validation guidance.

## Communication
- Reply to the user in Traditional Chinese.
- Report observed facts from the current code, API, job database, and artifacts; do not rely on memory when they can be inspected.
- Be explicit about failures, their root cause, affected jobs, and whether retrying is safe.

## Current Runtime Architecture
- The backend is the workflow and persistence owner.
- AO HTTP API is the only LLM execution boundary.
- Koharu HTTP API is used for manga image processing, OCR, scene editing, translation, and export operations.
- The GUI communicates with the local backend and does not call AO or Koharu directly unless an explicitly documented Electron integration requires it.
- Do not restore `agent_sdk`, provider registries, generic provider adapters, or their compatibility layers.
- Do not access the AgentOrchestrator project workspace at runtime. Its repository may be read as documentation only; all AO interaction must use HTTP APIs.

Primary backend entrypoint:

```bash
node backend/server.js
```

Normal GUI entrypoint:

```bash
npm --prefix gui run preview
```

## AO Conversation Contract
AO tasks use this lifecycle:
1. Create a conversation.
2. Upload `opencode.json`, `AGENTS.md`, subagents, docs, and skills through AO APIs.
3. Start the conversation.
4. Poll `GET /api/conversations/:id` until `ready === true`.
5. Send the task message only after readiness is confirmed.
6. Validate AO output with the task-specific backend contract.
7. Delete the temporary conversation when the task finishes, unless a user explicitly requests preservation for debugging.

Polling intervals and timeouts come from backend config. AO model identifiers use the
`provider_id/model_id` form.

## Reference Architecture
Extraction and Ingestion are separate concerns:
- Extraction stores Koharu OCR and scene data and can be corrected without rerunning OCR.
- Chapter Observation is the single reusable full-chapter Agent reading.
- Story, terminology, style, and bilingual enrichment consume Observation data and only the necessary local text windows.
- Reusing an unchanged Extraction fingerprint must reuse its compatible Observation.
- Bilingual enrichment is non-blocking and operates after source and translator Observations exist.
- Low-confidence or conflicting evidence may trigger local deep review, never an unnecessary full-chapter reread.

Source Reference workflow:
1. `reference_observation`
2. `reference_story_update`
3. `reference_knowledge_commit`

Translator Reference workflow:
1. `reference_observation`
2. `reference_style_commit`

Bilingual workflow:
1. `reference_bilingual_enrichment`
2. terminology linking and knowledge commit within the enrichment workflow

Source story updates are ordered by chapter. A failed earlier chapter must block later chapters
until the dependency is repaired and retried. Terminal failed or blocked jobs do not silently resume.

See `docs/REFERENCE_OBSERVATION_ARCHITECTURE.md` for the current contract.

## Data Ownership And Validation
- The backend owns JSON schemas, IDs, revisions, merge rules, confidence updates, and persistence.
- AO supplies semantic values and evidence; it does not own storage layout or arbitrary key names.
- Prefer strict line protocols for AO output where a generated JSON structure would be fragile.
- Validate enums, node IDs, evidence references, coverage, ordering, duplicates, and confidence before committing results.
- Manual and locked knowledge always has priority over inferred evidence.
- Do not preserve obsolete V1/V2 runtime branches after a migration is accepted and tested.
- Do not add heuristic language-term lists to compensate for an inadequate AO contract unless the user explicitly approves that design.

## Failure Handling
- Stop dependent workflow stages when a runtime stage fails; do not perform downstream mutations.
- Preserve the failed job, events, artifacts, and error details for diagnosis.
- Inspect the earliest failed atomic child job rather than reporting only the parent workflow failure.
- Distinguish actual failures from `blocked`, `waiting_dependency`, `waiting_prerequisite`, cancellation, and timeout states.
- Fix the root cause and verify it before recommending a retry.
- Do not automatically retry live user jobs or delete diagnostic AO conversations unless the user asks or the established workflow policy requires it.
- When retrying ordered source Ingestion, explain which terminal workflows must be recreated.

## Configuration
Config precedence is always:
1. HTTP request overrides
2. `.opencode/koharu.json`
3. backend defaults

Important runtime settings include:
- Koharu API base URL and timeouts
- AO base URL, API key, model, agent name, ready polling, and message timeout
- workflow quality and knowledge flags
- filesystem paths and job retention settings

Do not generate or overwrite `backend/ao/opencode/opencode.json`; the user owns its contents.

## Frontend Rules
- Keep page files as route-level containers; feature behavior belongs in `features/*` components, hooks, and view models.
- New user-visible text must use i18n message keys. Do not add Traditional Chinese or English UI literals directly to pages or components.
- Reuse shared loading, error, empty-state, status, summary, and section components.
- Use WebSocket/SSE job updates as the primary live path; polling is fallback behavior only.
- Display user-local dates and times.
- Job List must expose atomic job intent, manga, translator, chapter, progress, dependencies, and actionable failure details.

## Editing And Technical Debt
- Remove obsolete runtime code after the replacement path passes tests; do not accumulate compatibility branches during active development.
- Do not modify or delete unrelated user changes in a dirty worktree.
- Keep backend API changes synchronized with GUI types, messages, documentation, and tests.
- Avoid large mixed-responsibility files and duplicated formatters or status mappings.
- Do not hardcode test or demonstration data into production reports or UI fallbacks.

## Verification
Use focused tests while iterating, then run the relevant full checks before completion.

Backend tests:

```bash
npm test --prefix tests -- --runInBand
```

GUI checks:

```bash
npm --prefix gui run typecheck
npm --prefix gui run build
```

For live Reference work, also verify:
- AO is reachable at the configured base URL.
- The running backend process has loaded the current source version.
- The first atomic job type and its events match the current architecture.
- Existing Extraction remains available before asking the user to rerun expensive OCR.

## Key Paths
- `backend/server.js`: backend entrypoint
- `backend/src/ao_client.js`: AO HTTP client
- `backend/src/ao_assets.js`: AO runtime asset packaging
- `backend/src/modules/reference_observation.js`: reusable chapter observation
- `backend/src/modules/reference_ingestion.js`: Reference workflow orchestration
- `backend/src/modules/reference_ingestion_story.js`: source story update
- `backend/src/modules/reference_bilingual_enrichment.js`: source-target evidence enrichment
- `backend/ao/`: AO runtime assets
- `gui/src/renderer/features/`: maintainable GUI feature modules
- `references/`: Reference manifests, Extraction, Observation, and evidence artifacts
- `knowledge_base/`: manga-scoped durable knowledge
- `cache/process-agent.sqlite`: job and event persistence
- `docs/REFERENCE_OBSERVATION_ARCHITECTURE.md`: current Reference design
- `docs/AGENT_INTEGRATION.md`: AO integration contract
