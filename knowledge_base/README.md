# Knowledge Base

This directory stores backend-owned translation knowledge artifacts.

## Current Runtime Files
- `self/my-manga.json`
- `reports/extract_report.json`
- `index.json`

## Manga-Scoped Layout
When a `mangaId` is provided, the backend resolves:
- `self/<manga_id>/knowledge.json`
- `reports/<manga_id>/extract_report.json`
- `self/<manga_id>/canonical_glossary.json`
- `self/<manga_id>/story_context.json`
- `self/<manga_id>/style_profile.json`
- `self/<manga_id>/translation_context.json`

The index file keeps track of registered manga-scoped knowledge bases:
- `index.json`

## Current Heuristic Enrichment
The backend currently performs conservative heuristic enrichment for:
- repeated terminology candidates
- repeated character-like name candidates

These inferred entries are written into:
- `terminology`
- `characters`

The current implementation does not yet perform full Agent-SDK semantic enrichment.

## v2 Schema
The v2 schema separates:
- fact-layer translation pairs
- inferred terminology
- inferred character knowledge
- inferred style guidance

Reference example:
- `self/my-manga.schema.example.json`
- `self/canonical_glossary.schema.example.json`
- `self/story_context.schema.example.json`
- `self/style_profile.schema.example.json`

Migration notes:
- `reports/migration_plan_v2.md`
