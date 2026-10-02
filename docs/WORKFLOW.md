# MangaTranslationAgent Workflow

## Translation Model
- `reference` builds upstream story, terminology, bilingual, and translator-style evidence.
- `translation memory` creates one immutable, mode-filtered snapshot for Koharu and AO Quality.
- `quality` projects high-risk evidence into bounded AO windows before revising the Koharu scene.
- `knowledge` learns only from a lightweight Learning Evidence snapshot in an independent non-blocking child Job.
- `translation_deep_audit` is a manual, non-blocking complete review with resumable window checkpoints.

## Official Flow
1. Start the backend with `node backend/server.js`
2. Create a translation job with `POST /jobs/translation`
3. The backend validates the local source folder and builds a staged source-image set
4. The user may confirm or adjust source-image order before translation proceeds
5. The backend composes and persists `translation_memory_snapshot`
6. The backend injects that exact snapshot into the Koharu pipeline system prompt
7. The backend runs project setup and starts the Koharu pipeline
8. The backend monitors pipeline completion
9. Mode policy builds `quality_context_projection`, runs bounded AO Quality windows, and applies validated revisions
10. The backend persists `final_translation_snapshot`, `learning_evidence_snapshot`, and the Post Edit document
11. The backend exports the corrected project and closes Koharu
12. Local/learning modes schedule an independent Knowledge child Job from Learning Evidence

## Stage Ownership
- `backend/src/domains/jobs/workflows/workflow_engine.js` owns workflow routing
- source preflight and ordering belong to the translation entry workflow before project setup
- `backend/src/integrations/koharu/pipeline/project_setup.js` owns pre-pipeline setup
- `backend/src/integrations/koharu/pipeline/pipeline_monitor.js` owns pipeline completion detection
- `backend/src/domains/translation/quality/quality.js` owns optional quality review
- `backend/src/domains/knowledge/learning/knowledge.js` owns optional knowledge-base updates
- `backend/src/domains/translation/execution/export.js` owns export
- `backend/src/integrations/koharu/pipeline/project_lifecycle.js` owns close behavior

## User-Facing Translation Modes
| Mode | Reference memory | Local memory | Quality | Knowledge update |
| --- | --- | --- | --- | --- |
| `quick` | no | no | no | no |
| `reference_style` | yes | no | optional | no |
| `local_style` | no | yes | optional | yes |
| `learning_style` | yes | yes | required | yes |

`translationMode` is required. `referenceSetId`, `ingestReference`, and `knowledgeBuilder` are not
translation payload controls and are rejected. Reference Ingestion must be completed independently.

Recommended running text:
- `快速翻譯中...`
- `參考 {referenceLabel} 風格翻譯中...`
- `使用本地風格翻譯中...`
- `學習 {referenceLabel} 風格翻譯中...`

## Source Preflight Flow
1. The GUI collects a per-job `sourceFolder`
2. The backend validates that the folder is readable
3. The system scans local files and separates:
   - accepted image files
   - convertible image files
   - rejected files
4. Convertible files are normalized into supported staged source images
5. The GUI presents the final source image list with preview and manual ordering
6. If the final order differs from the detected order, the staged images are renamed in ordered form
7. The staged source images become the upload input for project setup

Rules:
- the original source folder is read-only from the workflow perspective
- ordering should not rename source files in place
- when the user keeps the detected order, rename work should be skipped
- if source-folder read access fails or output-folder write access fails, translation must not start until the user fixes the issue

## Reference Style Flow
1. Import other-translation images through the Reference API
2. The backend writes `domains/reference/manifests/<reference_set_id>.json`
3. Run `POST /jobs/reference-extraction` with `referenceSetId`
4. Optionally run `POST /jobs/reference-ingestion` with `referenceSetId + mangaId (+ chapterId)`
5. The backend extracts reference text into `domains/reference/extraction/<reference_set_id>/texts.json`
   and stores the raw scene in `domains/reference/extraction/<reference_set_id>/scene.json`
6. The backend promotes the extracted reference into:
   - `domains/knowledge/self/<manga_id>/canonical_glossary.json`
   - `domains/knowledge/self/<manga_id>/story_context.json`
   - `domains/knowledge/self/<manga_id>/style_profile.json`
7. Run a `reference_style` or `learning_style` translation for the bound manga and translator
8. The backend writes:
  - optional diagnostic outputs may exist under `domains/reference/comparisons/<reference_set_id>/`

Comparison artifacts are diagnostics rather than required quality-stage outputs.

## Knowledge Base Artifacts
Current runtime outputs:
- `domains/knowledge/self/default.json`
- `domains/knowledge/reports/extract_report.json`
- `domains/knowledge/index.json`

When `mangaId` is provided, the backend resolves manga-scoped paths:
- `domains/knowledge/self/<manga_id>/knowledge.json`
- `domains/knowledge/reports/<manga_id>/extract_report.json`
- `domains/knowledge/self/<manga_id>/canonical_glossary.json`
- `domains/knowledge/self/<manga_id>/story_context.json`
- `domains/knowledge/self/<manga_id>/style_profile.json`

When `chapterId` is provided:
- the knowledge base still stays under the same `mangaId`
- `metadata.chapter_ids` records known chapters
- each translation pair may carry `chapterId` provenance
- heuristic terminology and character enrichment is still aggregated into the same manga-scoped knowledge base

## Responsibility Model
- `reference`
  - builds upstream style/context assets from external translated material
- `knowledge`
  - accumulates self-derived translation memory for the manga
- `quality`
  - validates the current translation against project knowledge assets
  - should be treated as a read-only validation stage from the user point of view

## Job Status Model
Backend job states:
- `queued`
- `running`
- `waiting_pipeline`
- `quality_review`
- `knowledge_build`
- `exporting`
- `closing`
- `succeeded`
- `failed`
- `canceled`

## Failure Policy
- pipeline-monitor failure: stop, no export, no close
- quality failure: stop, no export, no close
- knowledge child failure: keep the completed Export and final snapshot; retry only the child
- export failure: stop, no close
- invalid agent result schema: treat the current stage as failed and stop downstream stages

## Close and Delete Rules
- `close project` means `DELETE /projects/current`
- close after successful Export; Knowledge no longer requires a live Koharu scene
- default workflow never deletes the stored project
- `defaults.autoDeleteProject` remains compatibility-only and is not the main workflow switch

## Agent Workspace Audit
When `quality_review` or `knowledge_enrichment` runs through the agent provider layer,
the backend records:
- `artifacts/import_manifest.json`
- `artifacts/export_manifest.json`

These manifests belong to:
- `workspaces/jobs/<jobId>/quality_review/`
- `workspaces/jobs/<jobId>/knowledge_enrichment/`
