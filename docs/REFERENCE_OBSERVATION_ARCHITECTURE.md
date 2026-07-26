# Reference Observation Architecture

Each extracted chapter is read completely by AO once. The immutable result is
`references/extracted/<referenceSetId>/chapter_observation.json`, with cache revisions under
`observations/`.

The cache identity includes the Extraction fingerprint, observer contract hash, AO model, and
content language. Story, terminology, style, and bilingual enrichment consume Observation records
and resolve exact text from canonical Extraction by node ID. They do not resend a complete chapter.

Source workflow:

1. `reference_observation`
2. `reference_story_update`
3. `reference_knowledge_commit`

Translator workflow:

1. `reference_observation`
2. `reference_style_commit`

Bilingual evidence is non-blocking. When current source and translator Observations exist, the
backend schedules `reference_bilingual_enrichment`. It plans bounded terminology and representative
style evidence windows. Window IDs are chapter-stable, and checkpoints are keyed by the local window
fingerprint rather than the whole-book plan, so unchanged chapters can be reused after later chapters
are added. Each successful commit merges into `bilingual_evidence_ledger.json`, writes an immutable
ledger revision, and publishes `bilingual_evidence.json` as the current view. Repeated identical
evidence is deduplicated; evidence from distinct chapters can increase confidence. Competing target
renderings are downgraded for review instead of being promoted. Only high-confidence or manually
accepted evidence can promote a canonical translation. A local `reference_deep_review` reads only
selected nodes and their immediate neighbors.

Extraction changes make the affected Observation and bilingual evidence stale. OCR and Extraction
revisions remain intact and do not need to be regenerated.

Durable bilingual assets:

- `knowledge_base/self/<manga_id>/<translator_id>/bilingual_evidence.json`
- `knowledge_base/self/<manga_id>/<translator_id>/bilingual_evidence_ledger.json`
- `knowledge_base/self/<manga_id>/<translator_id>/bilingual_ledger_revisions/revision_<number>.json`
- `knowledge_base/self/<manga_id>/<translator_id>/bilingual_runs/checkpoints/<window_fingerprint>.json`
