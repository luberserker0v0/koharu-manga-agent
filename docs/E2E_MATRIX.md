# MangaTranslationAgent E2E Matrix

## Purpose
This matrix defines the current end-to-end acceptance inventory for the local full-environment workflow.

It answers:
- which checks are release blockers
- which checks are automated, manual, or hybrid
- which repo suites already cover them
- which gaps still require manual validation or future automation

## Gate Levels
- `Blocker`
  - must pass before a release candidate is accepted
- `Important`
  - should pass for a stable desktop build, but may ship with an explicit known-gap note
- `Optional`
  - useful confidence or polish coverage, but not a release gate

## Mode Types
- `Automated`
  - covered primarily by Jest/backend/API/agent/runtime suites
- `Manual`
  - requires GUI interaction or visual confirmation
- `Hybrid`
  - backend or API coverage exists, but GUI behavior still needs a final human check

## Matrix

| ID | Title | Gate | Mode | Environment | Current coverage | Main gap |
| --- | --- | --- | --- | --- | --- | --- |
| `E2E-BLK-START-001` | GUI managed startup + backend ready | Blocker | Hybrid | Local GUI + backend + Node | `docs/GUI_SMOKE_CHECKLIST.md`, `tests/integration/backend_api.test.js` | GUI launch remains manual |
| `E2E-BLK-START-002` | External backend attach | Important | Manual | Local GUI + externally started backend | `docs/GUI_SMOKE_CHECKLIST.md` | No automated desktop attach test |
| `E2E-BLK-START-003` | `node:sqlite` runtime compatibility | Blocker | Hybrid | Real Node runtime | `docs/GUI_SMOKE_CHECKLIST.md`, startup behavior in app | Manual desktop confirmation still needed |
| `E2E-BLK-TRAN-001` | Translation happy path from `Job` to export | Blocker | Hybrid | Local GUI + backend + Koharu | `tests/e2e/backend_job_flow.test.js` now exercises the official `sourcePreflightId -> translation` entry path, `tests/e2e/live_backend_smoke.test.js`, `docs/GUI_SMOKE_CHECKLIST.md` | GUI path from `Validate` to `Start translation` is manual |
| `E2E-BLK-TRAN-002` | Source preflight validation and conversion | Blocker | Hybrid | Local GUI + backend | `tests/integration/backend_api.test.js`, `tests/e2e/backend_job_flow.test.js`, `docs/GUI_SMOKE_CHECKLIST.md` | GUI rendering of preflight summaries remains manual |
| `E2E-IMP-GUI-REORDER-001` | Image reorder UX and apply-order behavior | Important | Manual | Local GUI | `docs/GUI_SMOKE_CHECKLIST.md` | No GUI automation |
| `E2E-BLK-TRAN-003` | Optional quality stage executes when enabled | Blocker | Automated | Backend + AO runtime | `tests/e2e/backend_job_flow.test.js` now passes through the official preflight-aware translation path before quality assertions | GUI toggle verification remains manual |
| `E2E-BLK-TRAN-004` | Optional knowledge stage executes when enabled | Blocker | Automated | Backend + AO runtime | `tests/e2e/backend_job_flow.test.js`, `tests/e2e/knowledge_base.test.js`; the backend flow covers the official preflight-aware translation path before knowledge assertions | GUI toggle verification remains manual |
| `E2E-BLK-SYNC-001` | `Job List` SSE-first sync | Blocker | Hybrid | Local GUI + backend SSE | `GET /jobs/stream` behavior via backend API coverage, `docs/GUI_SMOKE_CHECKLIST.md` | No dedicated automated GUI assertion |
| `E2E-BLK-SYNC-002` | `Job Detail` SSE-first sync | Blocker | Hybrid | Local GUI + backend SSE + Koharu | per-job runtime behavior exercised indirectly, `docs/GUI_SMOKE_CHECKLIST.md` | GUI live projection still manually verified |
| `E2E-BLK-SYNC-003` | Workflow / Engines / Page Progress projection | Blocker | Hybrid | Local GUI + backend + Koharu SSE | `tests/unit/pipeline_monitor.test.js`, `docs/GUI_SMOKE_CHECKLIST.md` | Visual correctness is manual |
| `E2E-IMP-SYNC-004` | Raw Events live interaction | Important | Manual | Local GUI + backend SSE | `docs/GUI_SMOKE_CHECKLIST.md` | No automated GUI scroll/follow checks |
| `E2E-BLK-REF-001` | Reference extraction happy path | Blocker | Automated | Backend + Koharu | `tests/e2e/backend_job_flow.test.js`, `tests/integration/backend_api.test.js` | GUI initiation is manual |
| `E2E-BLK-REF-002` | Reference ingestion happy path | Blocker | Automated | Backend | `tests/e2e/backend_job_flow.test.js`, `tests/integration/backend_api.test.js` | GUI initiation is manual |
| `E2E-IMP-REF-003` | Job-scoped comparison/glossary/style preview | Important | Manual | Local GUI | `docs/GUI_SMOKE_CHECKLIST.md` | No automated GUI artifact preview |
| `E2E-BLK-JOBS-001` | Retry terminal job | Blocker | Automated | Backend API | `tests/e2e/backend_job_flow.test.js` | GUI button path is manual |
| `E2E-BLK-JOBS-002` | Cancel active job | Blocker | Automated | Backend API | `tests/e2e/backend_job_flow.test.js` | GUI button path is manual |
| `E2E-BLK-JOBS-003` | Delete to Trash and Undo | Blocker | Hybrid | Local GUI + backend | `tests/integration/backend_api.test.js`, `docs/GUI_SMOKE_CHECKLIST.md` | Undo UI remains manual |
| `E2E-BLK-JOBS-004` | Trash restore | Blocker | Hybrid | Local GUI + backend | `tests/integration/backend_api.test.js`, `docs/GUI_SMOKE_CHECKLIST.md` | Restore UI remains manual |
| `E2E-BLK-JOBS-005` | Trash delete forever | Blocker | Hybrid | Local GUI + backend | `tests/integration/backend_api.test.js`, `docs/GUI_SMOKE_CHECKLIST.md` | Delete-forever UI remains manual |
| `E2E-IMP-JOBS-006` | Trash auto-cleanup retention | Important | Automated | Backend | `tests/integration/backend_api.test.js` | No GUI exposure requirement |
| `E2E-IMP-JOBS-007` | Search / filter / sort on large history | Important | Manual | Local GUI | `docs/GUI_SMOKE_CHECKLIST.md` | No automated GUI list interaction |
| `E2E-BLK-FAIL-001` | Pipeline failure stops downstream stages | Blocker | Automated | Backend | `tests/e2e/backend_job_flow.test.js` | GUI rendering of failed state is manual |
| `E2E-BLK-FAIL-002` | Quality failure stops export/close | Blocker | Automated | Backend + AO runtime | `tests/e2e/backend_job_flow.test.js` | GUI rendering of failure is manual |
| `E2E-BLK-FAIL-003` | Knowledge failure stops export/close | Blocker | Automated | Backend + AO runtime | `tests/e2e/backend_job_flow.test.js` | GUI rendering of failure is manual |
| `E2E-BLK-FAIL-004` | Export failure stops close | Blocker | Automated | Backend | `tests/e2e/backend_job_flow.test.js` | GUI rendering of failure is manual |
| `E2E-IMP-FAIL-005` | SSE reconnect and fallback polling | Important | Hybrid | Local GUI + backend SSE | `docs/GUI_SMOKE_CHECKLIST.md` | No automated GUI reconnect harness |
| `E2E-OPT-RWD-001` | Deep RWD pane/layout polish | Optional | Manual | Local GUI resized windows | `docs/GUI_SMOKE_CHECKLIST.md` | Pure manual |
| `E2E-OPT-SOAK-001` | Long-running live monitoring soak | Optional | Manual | Local GUI + backend + Koharu | none formal | No automation yet |

## Detailed Acceptance Items

### `E2E-BLK-TRAN-001` Translation happy path
- **Preconditions**
  - GUI can start
  - backend is reachable
  - Koharu is reachable
  - source folder contains valid images
- **Steps**
  1. Open `Job`
  2. Choose `sourceFolder`
  3. Run `Validate`
  4. Optionally reorder images
  5. Fill manga/chapter labels
  6. Start translation
  7. Observe the job in `Job List`
- **Expected result**
  - translation job is created
  - preflight succeeds
  - job reaches export and close
  - output artifact exists
- **Failure signal**
  - start button enables before validation
  - pipeline never reaches terminal state
  - export artifact missing
  - GUI crashes or loses job context

### `E2E-BLK-SYNC-001` Job List SSE-first sync
- **Preconditions**
  - backend is reachable
  - `GET /jobs/stream` is available
- **Steps**
  1. Open `Job List`
  2. Confirm live badge transitions to `Live`
  3. Create a new job elsewhere in the app
  4. Return to `Job List`
- **Expected result**
  - job appears without manual refresh
  - badge reflects reconnect/fallback state when interrupted
  - selection remains stable
- **Failure signal**
  - list only updates after explicit refresh
  - visible 5-second batch jumps remain
  - badge never leaves `Connecting`

### `E2E-BLK-JOBS-003` Delete to Trash and Undo
- **Preconditions**
  - at least one terminal job exists
- **Steps**
  1. Delete one terminal job
  2. Confirm centered notice appears
  3. Click `Undo`
- **Expected result**
  - job first moves to Trash
  - undo restores it to the normal list
- **Failure signal**
  - job disappears permanently on first delete
  - undo does not restore job state

### `E2E-BLK-FAIL-004` Export failure stop policy
- **Preconditions**
  - backend test harness can force export failure
- **Steps**
  1. Run translation flow with export module failure injected
- **Expected result**
  - job becomes `failed`
  - project close does not run
- **Failure signal**
  - close runs after export failure
  - job reports success despite missing export

## Current Coverage Summary
- **Strong automated coverage already exists** for backend orchestration, API contracts, source-preflight-aware translation entry, agent runtime, reference ingestion, and live backend smoke.
- **Current high-value automated baseline is green** for:
  - `tests/integration/backend_api.test.js`
  - `tests/e2e/backend_job_flow.test.js`
  - `tests/unit/ao_client.test.js`
  - `tests/unit/ao_assets.test.js`
  - plus `gui` `typecheck` and `build`
- **Strong manual coverage already exists** for GUI startup, `Job`, `Job List`, selected-job workspace, artifacts, and raw events.
- **Main remaining gap** is not missing documentation anymore; it is the absence of GUI automation for drag/drop, badges, pane behavior, and live-event presentation.

## Known Gaps
- No headless GUI automation currently validates badge transitions, pane resizing, or drag-reorder interactions.
- `Job List` and `Job Detail` live-sync behavior is specified and manually testable, but not fully machine-asserted in desktop UI.
- Long-duration soak tests are still ad hoc rather than formalized in Jest.
