# MangaTranslationAgent TDD Notes

## Current Test Focus
- `backend/` is now the official runtime surface
- legacy `.opencode` scripts remain covered as migration adapters
- workflow behavior is validated at unit, integration, and backend API levels

## Unit Tests

### `backend/src/workflow_engine.js`
Covered scenarios:
- quality runs when enabled
- knowledge is skipped when disabled
- export runs after workflow stages complete
- close runs only after export
- `quality` runs as a read-only validation stage

### `backend/src/modules/reference_sets.js`
- manifest validation
- reference path resolution
- scene normalization for extracted reference text output

### `backend/src/modules/quality.js`
- review output is a read-only validation report
- quality report includes issues, warnings, and knowledge-source usage
- invalid agent result schema fails the stage before import

### `backend/src/job_manager.js`
- job creation
- persisted success result
- artifact persistence
- retry and cancellation boundaries

### `backend/src/modules/pipeline_monitor.js`
- normal operation polling
- late-attach recovery
- timeout recovery
- translated-scene based completion recovery

### `backend/src/ao_*`
- AO conversation create/config/agent/skills/start/get/message/delete flow
- `start` 後未 `ready` 前不得送出 message
- ready polling timeout / non-running / HTTP error failure handling
- AO result schema normalization for `quality` and `knowledge`
- stage manifests are written for backend-owned artifact auditing

### `backend/src/config.js`
- merged defaults
- `koharu.json` overrides
- runtime host/port
- database path resolution

### Legacy migration coverage
- `one_click_translate.js`
  - original page validation
  - provider/local LLM fallback behavior
  - upload fallback behavior
  - engine resolution
- `listen_events.js`
  - recovery helpers still behave as expected while the new backend absorbs the logic

## Integration Tests
- `backend_api.test.js`
  - `POST /jobs/translation`
  - `GET /jobs/:jobId`
  - successful backend execution path
- `config_override.test.js`
  - config values still come from `koharu.json`
- `script_load.test.js`
  - migration scripts still exist and remain loadable during transition

## E2E Coverage
- `backend_job_flow.test.js`
  - successful backend job with quality on / knowledge off
  - successful backend job with quality off / knowledge on
  - export failure stops close and marks job failed
  - cancellation moves a running job into `canceled`
  - `/jobs/:jobId/stream` emits ordered backend events
- `pipeline.test.js`
  - Koharu availability
  - project listing / open / scene access
  - engine and LLM reachability
- `knowledge_base.test.js`
  - knowledge-base directory layout
  - config path resolution
  - persisted knowledge-base file shape
  - TODO list presence

Legacy comparison live E2E is not a release-facing goal. Current priority is knowledge-driven quality validation.

## Suggested Commands
```bash
npm test --prefix tests
npm run test:unit --prefix tests
npm run test:integration --prefix tests
npm run test:e2e --prefix tests
npm run test:coverage --prefix tests
```
