# GUI Smoke Checklist

## Current Startup Model
The GUI now owns backend startup for normal desktop usage.

Recommended command:

```bash
cd gui
npm run preview
```

Notes:
- if backend is already running, the GUI connects to it as `external`
- if backend is not running, Electron starts `node backend/server.js` as `managed`
- closing the GUI stops only a managed backend
- closing or refreshing the GUI does not stop backend jobs that belong to an external backend
- the backend remains the source of truth for jobs, events, artifacts, and knowledge assets
- backend startup requires a real Node runtime because the job store uses `node:sqlite`
- if backend is launched with the wrong executable, startup may fail with `no such built-in module sqlite`

## Latest Smoke Result
Validated on 2026-05-24.

Observed result:
- GUI preview started successfully without manually starting backend first
- Electron auto-started backend on `http://127.0.0.1:4001`
- `GET /health` returned success
- Electron process stayed alive during the observation window
- backend stderr only showed the expected `node:sqlite` experimental warning
- GUI build and typecheck passed after the latest `Trash / Restore / Delete forever / live interaction` updates

## Manual Smoke Checklist

Gate legend:
- `Blocker`: release acceptance item
- `Important`: should pass for a stable desktop build
- `Optional`: polish or exploratory confidence item

Failure rule:
- if a section's expected result is not met, treat that section as failed even if the backend APIs still respond
- GUI crash, blank page, broken context restore, or stale live state always count as failure signals

### A. Startup
Gate: `Blocker`
- Start GUI with `cd gui && npm run preview`
- Confirm Electron window opens
- Confirm backend starts automatically if it was not already running
- Open `http://127.0.0.1:4001/health`
- Confirm response contains `"ok": true`
- Confirm the top status bar renders
- Confirm the left navigation renders only:
  - `Settings`
  - `Job`
  - `Reference`
  - `Job List`
- Failure signal:
  - backend does not come up
  - Electron window is blank
  - wrong primary navigation appears

### B. Settings
Gate: `Important`
- Open `Settings`
- Confirm the page is not blank
- Confirm runtime badges render
- Confirm local settings file path renders
- Expand each settings section:
  - `Folders`
  - `Agent provider`
  - `Quality and translation LLM`
  - `Koharu and engines`
- Edit one text field
- Confirm `Unsaved changes` appears
- Use `Browse` on one folder field
- Confirm a directory picker opens
- Click `Reset to defaults`
- Confirm default values are restored
- Click `Save settings`
- Confirm success status message appears
- Confirm the page states that settings affect future jobs only
- Failure signal:
  - settings page crashes or renders blank
  - save does not persist
  - folder picker does not open

### C. Job Creation
Gate: `Blocker`
- Open `Job`
- Confirm the page is not blank
- Confirm `source folder` is on this page, not in `Settings`
- Click `Browse`
- Confirm it opens at the last remembered source folder when available
- Select a valid source folder
- Confirm `Validate` becomes the next required action
- Click `Validate`
- Confirm source preflight summary appears:
  - discovered
  - accepted
  - converted
  - rejected
- Confirm `Start translation` stays disabled until validation succeeds
- Reorder at least two images in the image-order area
- Confirm card-based drag reorder works
- Confirm images themselves are not draggable separately from the card
- Click `Apply order`
- Enter:
  - `Manga title`
  - optional `Chapter title`
- Choose a translation mode:
  - `快速翻譯`
  - `參考風格翻譯`
  - `本地風格翻譯`
  - `學習風格翻譯`
- Confirm only the fields required by the selected mode appear
- If a reference-style mode is selected, confirm related settings appear only for that mode
- Current mode names to verify in the GUI:
  - `快速翻譯`
  - `參考風格翻譯`
  - `本地風格翻譯`
  - `學習風格翻譯`
- Confirm the centered start notice uses mode wording such as:
  - `快速翻譯中...`
  - `參考 {referenceLabel} 風格翻譯中...`
  - `使用本地風格翻譯中...`
  - `學習 {referenceLabel} 風格翻譯中...`
- Confirm the review/checklist section clearly explains what still blocks start
- Click `Start translation`
- Confirm a centered notification appears
- Confirm the app does not crash
- Failure signal:
  - `Start translation` enables before validation
  - validate does not produce a preflight summary
  - starting translation crashes the GUI

### C1. Reference Page
Gate: `Blocker`
- Open `Reference`
- Confirm the page is not blank
- Confirm the page contains:
  - `Prepare reference material`
  - `Reference jobs`
  - `Extraction results`
  - `Ingestion reports`
  - `Artifact editor`
- Select a reference material
- Start a reference extraction job
- Select the created reference job
- Preview `OCR / extracted texts`
- If editing is allowed, modify the JSON and save it
- Confirm the saved preview can be reloaded
- Use delete on an extracted artifact only when testing against disposable data
- Start a reference ingestion job
- Confirm glossary / story context / style profile / translation context artifacts can be previewed on the same page
- Failure signal:
  - reference page crashes or renders blank
  - reference jobs cannot be inspected from the page
  - extracted JSON cannot be previewed after extraction completes
  - ingestion artifacts do not appear after ingestion completes

### D. Job List Workspace
Gate: `Important`
- Open `Job List`
- Confirm the job list pane renders on the left
- Confirm the selected-job workspace renders on the right
- Confirm the job-list header shows a live-sync badge
- Confirm the job list pane can:
  - collapse
  - fully hide
  - expand again from the rail control
- Confirm the job list pane can be resized on desktop
- Confirm the layout falls back to single-column behavior on narrow screens if tested
- Confirm job list filter buttons exist:
  - `All`
  - `Active`
  - `Completed`
  - `Failed`
  - `Trash`
- Confirm keyword search works
- Confirm each job row shows a translation mode label and a short mode description
- Confirm sorting options exist:
  - `Last updated`
  - `Created (newest first)`
  - `Created (oldest first)`
  - `Status priority`
  - `Manga title (A-Z)`
- Failure signal:
  - pane cannot be collapsed/restored
  - resize breaks the layout
  - search/filter/sort controls stop affecting the list

### D1. Job List SSE Sync (`/jobs/stream`)
Gate: `Blocker`
- Open `Job List`
- Confirm the live-sync badge first shows a startup state such as:
  - `Connecting`
  - then settles to `Live`
- Create a new job from the `Job` page
- Return to `Job List`
- Confirm the new job appears without waiting for a manual refresh
- Confirm stage/status changes appear in the list without a visible 5-second batch jump
- If possible, temporarily interrupt backend connectivity
- Confirm the badge changes to:
  - `Reconnecting`
  - or `Fallback polling`
- Restore connectivity
- Confirm the badge returns to `Live`
- Confirm the list stays usable during reconnect and recovers without clearing the current selection
- Failure signal:
  - new jobs require manual refresh to appear
  - badge never reaches `Live`
  - reconnect loses list context or leaves the list frozen

### E. Job Detail Overview
Gate: `Blocker`
- In `Job List`, click a job
- Confirm the selected-job workspace updates without leaving the page
- Confirm the overview shows card-based sections for:
  - `Summary`
  - `Workflow overview`
  - `Pipeline engines`
  - `Page progress`
  - `Warnings / Errors`
- Confirm `Summary` includes:
  - status
  - job type
  - translation mode
  - created/updated time
  - manga/chapter identity
- Confirm `Summary` also shows a live-sync badge matching the same visual language used in `Job List`
- Confirm `Workflow overview` shows stage cards, not only raw log lines
- Confirm `Pipeline engines` shows one card per engine
- Confirm `Page progress` shows:
  - completed / total pages
  - current engine
  - current page
  - page index
- Failure signal:
  - selected-job workspace does not update when a job is selected
  - live badge stays stale while raw events continue
  - engine/page cards remain structurally broken or blank

### F. What To Expect In Workflow / Engines / Page Progress
Gate: `Blocker`

#### Workflow Overview
You should see backend process stages summarized as status cards, not only repeated raw events.

Expected stages:
- `source_preflight`
- `project_setup`
- `upload_pages`
- `start_pipeline`
- `pipeline_monitor`
- `quality`
- `knowledge`
- `export`
- `close_project`

Expected card statuses:
- `waiting`
- `running`
- `completed`
- `failed`
- `observed`

#### Pipeline Engines
You should see Koharu engine cards for:
- `detect`
- `fontDetect`
- `segment`
- `bubbleSegment`
- `ocr`
- `translate`
- `clean`
- `render`

Expected behavior:
- the currently active engine should look active/running
- completed engines should look complete
- not-yet-run engines should remain waiting/unknown

#### Page Progress
You should see a large progress summary such as:
- `12 / 45`

And supporting values:
- current engine
- current page name
- page index

If backend has not emitted full structured progress yet, some values may still display `unknown`, but the section itself should still render cleanly.
- Failure signal:
  - progress cards regress into unreadable raw-event spam
  - completed jobs still show impossible or self-contradictory engine/page states

### G. Delete -> Undo
Gate: `Blocker`
- In `Job List`, filter to `Completed` or `Failed`
- Select one terminal job
- Click `Delete`
- Confirm the confirmation dialog says the job will move to `Trash`
- Confirm the selected job disappears from the normal list
- Confirm a centered notification appears
- Confirm the notification contains `Undo`
- Click `Undo`
- Confirm the job returns to the normal list
- Confirm the job is not left in `Trash`
- Failure signal:
  - delete hard-removes the job immediately
  - undo does not restore list state

### H. Trash -> Restore
Gate: `Blocker`
- Delete one or more terminal jobs
- Switch filter to `Trash`
- Confirm trashed jobs appear with `trashed:` timestamp
- Select one trashed job
- Click `Restore`
- Confirm the job leaves `Trash`
- Confirm the job reappears in the normal list
- Test batch restore:
  - select multiple trashed jobs
  - click `Restore selected`
  - confirm all selected jobs return
- Failure signal:
  - restored jobs remain stuck in `Trash`
  - batch restore only partially updates the list without explanation

### I. Trash -> Delete Forever
Gate: `Blocker`
- Delete one or more terminal jobs
- Switch filter to `Trash`
- Select one trashed job
- Click `Delete forever`
- Confirm the confirmation dialog warns that it cannot be undone
- Confirm the job disappears from `Trash`
- Confirm it is no longer restorable
- Test batch permanent delete:
  - select multiple trashed jobs
  - click `Delete forever`
  - confirm all selected jobs are removed from `Trash`
- Failure signal:
  - trashed jobs remain restorable after permanent delete
  - current selection points to a deleted job without clearing

### J. Style Sources Tab
Gate: `Important`
- In selected-job detail, open `Style Sources`
- Confirm the tab shows:
  - `Translation mode`
  - `Reference material`
  - `Reference glossary strategy`
  - `Quality validation`
  - `Local style update`
- If the job used a reference-style mode, confirm the values match what was submitted
- Failure signal:
  - enabled/disabled state shown here does not match the submitted job payload
  - tab cannot render style-source metadata cleanly

### K. Artifacts Tab
Gate: `Important`
- In selected-job detail, open `Artifacts`
- Confirm the content is job-scoped
- Confirm sections appear for:
  - `Quality validation reports and legacy diagnostics`
  - `Workspace manifests`
  - `Other job artifacts`
- Confirm `Preview` works on:
  - quality validation report
  - legacy comparison report
  - workspace import manifest
  - workspace export manifest
- If glossary data exists, confirm user-facing wording such as `Local glossary` appears instead of only backend-facing labels
- Confirm summary cards appear before raw JSON
- Failure signal:
  - artifacts preview opens the wrong job context
  - preview only shows raw JSON with no summary cards

### L. Raw Events Live Interaction
Gate: `Important`
- In selected-job detail, open `Raw Events`
- Confirm the `Live interaction` panel renders inside the tab
- Confirm historical events appear first
- Start or watch a running job
- Confirm new live events append without crashing the GUI
- Test source filters:
  - `all`
  - `backend`
  - `koharu`
  - `agent`
  - `llm`
- Test direction filters:
  - `all`
  - `request`
  - `response`
  - `internal`
  - `error`
- Scroll upward
- Confirm auto-follow pauses
- Confirm unread count increases when new events arrive
- Click `Jump to Latest`
- Confirm the view returns to the latest entries and unread count clears
- Failure signal:
  - new events stop appearing while the job is active
  - filters stop affecting visible events
  - `Jump to Latest` does not recover auto-follow

### M. Persistence
Gate: `Important`
- Change page to `Job List`
- Select a job
- Collapse or resize the job-list pane
- Close the GUI
- Reopen the GUI
- Confirm:
  - settings are restored
  - the app still starts cleanly
- If layout-state persistence is enabled in the current build, also confirm the pane state returns as expected
- Failure signal:
  - restart drops saved settings
  - reopen produces broken or mismatched page context

### N. Backend Separation
Gate: `Important`
- Start a long-running job against an externally started backend
- Close the GUI window
- Confirm backend process keeps running
- Reopen the GUI
- Confirm the job is still visible
- Confirm the event history is still recoverable
- Failure signal:
  - closing the GUI kills an external backend
  - reopening cannot recover running-job context

### O. Managed Backend Lifecycle
Gate: `Blocker`
- Ensure backend is not already running
- Start GUI with `cd gui && npm run preview`
- Confirm backend becomes reachable automatically
- Close the GUI
- Confirm the managed backend also exits

## Known Limitation
- the backend still requires a compatible Node runtime with built-in `node:sqlite`
- the GUI still relies on backend event quality for how precise the engine/page projections can be
