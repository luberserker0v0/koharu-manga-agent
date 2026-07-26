# Style Learning Refactor Plan

## Purpose
This document defines the formal refactor direction for translation style learning.

The project goal is not only to keep terminology stable. It must also preserve the
translation voice of a trusted translator group across many future chapters that do
not yet have a translated reference.

The current implementation stores a lightweight `style_profile.json`, but it is still
too shallow to represent real translator style. This refactor upgrades style learning
from heuristic metadata into an evidence-backed long-term memory layer.

## Product goal

The system should learn enough from a small number of translated chapters to continue
later untranslated chapters in a way that feels like the same translator group.

That means style learning must support:

1. global narration and dialogue tendencies
2. preferred punctuation and formatting
3. honorific usage
4. register and tone
5. repeated phrase and wording preferences
6. character-specific speech habits
7. confidence growth as more chapters are ingested

## Current state

### What exists today
Style is currently derived mainly from:

- `backend/src/modules/reference_ingestion.js`
  - `deriveStyleProfile()`
- `backend/src/modules/knowledge_assets.js`
  - `defaultStyleProfile()`
  - `mergeStyleProfile()`
  - `buildTranslationContext()`
  - `formatTranslationSystemPrompt()`
- `backend/src/modules/quality.js`
  - simple style compliance checks

### What the current logic actually learns
The current style profile mainly tracks:

- rough `register`
- `preserveHonorifics`
- punctuation preference
- dialogue vs narration ratio
- sentence length bucket
- a few raw text samples

This is useful as a first-pass hint layer, but it is not enough to represent translator style.

### Main limitations

1. no evidence model
2. no confidence model
3. no distinction between source-side structure and target-language style
4. no character-level speech modeling
5. no stable pattern memory
6. no meaningful merge policy beyond shallow overwrite/append
7. weak translation-time consumption

## Responsibility boundaries

### Source reference
Original-language reference can contribute:

- dialogue density
- narration density
- chapter structure
- character presence
- scene pacing hints

Original-language reference must not directly raise confidence in:

- Chinese wording preference
- punctuation preference in translated output
- translator voice
- character speech style in the target language

### Translator reference
Translator reference is the only legitimate source for:

- target-language punctuation style
- wording preferences
- honorific policy
- narration tone
- dialogue tone
- character speech habits
- repeated phrase templates

This boundary must be formalized in both ingestion and merge logic.

## Target architecture

Style learning should be split into two layers.

### Layer A: style evidence
Chapter-level observations extracted from each reference set.

Purpose:

- retain raw evidence for later confidence updates
- separate observations from merged rules
- keep provenance by chapter and reference set

Suggested file:

- `knowledge_base/self/<mangaId>/<translatorId>/style_evidence.json`

Suggested structure:

```json
{
  "metadata": {
    "manga_id": "manga_x",
    "translator_id": "translator_y",
    "updated_at": "2026-07-16T00:00:00.000Z"
  },
  "chapters": {
    "chapter_1": {
      "reference_kind": "translator",
      "reference_set_ids": ["ref_1"],
      "register_evidence": [],
      "punctuation_evidence": [],
      "honorific_evidence": [],
      "dialogue_samples": [],
      "narration_samples": [],
      "character_speech": []
    }
  }
}
```

### Layer B: style profile
Merged long-term style memory.

Purpose:

- define stable global translation style constraints
- define character-level speech tendencies
- provide translation-time constraints
- support quality validation

Existing file retained:

- `knowledge_base/self/<mangaId>/<translatorId>/style_profile.json`

But its schema must be upgraded.

## Target style profile schema

### Global profile
Suggested top-level sections:

- `metadata`
- `global`
- `characters`
- `samples`

### `global`
Should include:

- `register`
- `register_confidence`
- `tone`
- `tone_confidence`
- `preserve_honorifics`
- `honorific_confidence`
- `punctuation_policy`
- `punctuation_confidence`
- `preferred_patterns[]`
- `forbidden_patterns[]`
- `dialogue_narration_balance`
- `chapter_coverage`
- `reference_kind_support`
- `evidence_count`

### `characters`
Per-character speech style profile.

Each character should support:

- `identity_key`
- `canonical_name`
- `speech_register`
- `speech_register_confidence`
- `lexical_preferences[]`
- `honorific_behavior[]`
- `sentence_ending_patterns[]`
- `addressing_patterns[]`
- `evidence_count`
- `chapter_ids[]`
- `samples[]`

### `samples`
Samples should be separated by purpose:

- `dialogue`
- `narration`
- `honorifics`
- `character_examples`

Samples should not just be appended forever. They must remain curated and bounded.

## AO task split for style

### Task 1: translator style extraction
Purpose:

- extract target-language style evidence from trusted translated reference material

Input should include:

- `referenceKind: "translator"`
- `sourceLines[]`
- `targetLines[]`
- optional `translationPairs[]`
- existing style profile
- existing style evidence
- character glossary
- story context

Output should include:

- `styleSignals`
- `globalStyleEvidence[]`
- `characterSpeechEvidence[]`
- `styleExampleEntries[]`
- `notes`

### Task 2: source structural style extraction
Purpose:

- extract source-side structural context that may help pacing and dialogue distribution

Input should include:

- `referenceKind: "source"`
- `sourceLines[]`
- story context

Output should include:

- dialogue/narration balance hints
- chapter structure hints
- conservative notes

Important:

- this task must not invent target-language style rules
- it can enrich context, but not translator voice

## Merge rules

### Source evidence
Source-only evidence may update:

- dialogue/narration balance hints
- chapter-local structure
- character presence

It must not update:

- target-language punctuation confidence
- target-language lexical preference confidence
- character speech style confidence in the target language

### Translator evidence
Translator evidence may update:

- target punctuation policy
- register
- tone
- honorific policy
- preferred patterns
- forbidden patterns
- character speech profiles

### Confidence rules
Confidence should increase with:

- repeated support across chapters
- repeated support across reference sets
- agreement between multiple translator chapters
- stable reuse of the same character style signals

Confidence should decrease or stay low when:

- sample count is too low
- evidence conflicts across chapters
- OCR noise is suspected
- evidence is only source-side and not translator-side

## Translation-time consumption

The translation runtime should no longer consume style as only a few flat rules.

Instead, `translation_context.json` should project style into:

- global style constraints
- chapter-local style hints
- character speech constraints
- examples for high-confidence characters

Suggested translation-time fields:

- `styleConstraints.global`
- `styleConstraints.characters`
- `styleConstraints.samples`

## Quality-time consumption

Style validation should become more specific.

Quality can validate:

- register drift
- punctuation drift
- honorific drift
- repeated forbidden pattern usage
- character speech drift for high-confidence characters

Quality should not over-enforce style when evidence is weak.

## UI implications

Reference and artifact views should eventually show:

- style source type: source vs translator
- style confidence
- global style summary
- character speech summary
- supporting chapter count
- sample examples

The UI should help users answer:

- what style has actually been learned
- whether that style comes from translated evidence
- which character speech rules are strong enough to trust

## File impact

### Backend files to change first
- `backend/src/modules/reference_ingestion.js`
- `backend/src/modules/knowledge_assets.js`
- `backend/src/ao_tasks.js`
- `backend/src/ao_contracts.js`

### Backend files to change after schema stabilizes
- `backend/src/modules/quality.js`
- `backend/src/modules/knowledge.js`
- `backend/src/http/api_server.js`

### GUI files to update later
- `gui/src/renderer/pages/ReferencePage.tsx`
- style artifact preview mappings
- ingestion report summaries

## Migration strategy

### Phase 1
Add `style_evidence.json` and extend `style_profile.json` fields without removing old ones.

### Phase 2
Separate translator style extraction from source structural extraction.

### Phase 3
Add character-level speech evidence and merge logic.

### Phase 4
Upgrade translation-time consumption to use structured style constraints.

### Phase 5
Upgrade quality validation to use style confidence and character speech profiles.

## Validation plan

### Unit tests
Add or rewrite tests for:

- translator-only style evidence updates
- source-only style evidence restrictions
- character speech evidence merge
- conflict handling
- confidence accumulation
- noisy sample rejection

### Integration tests
Cover:

- reference ingestion with `useForStyle=true`
- mixed chapter accumulation
- translator-vs-source style separation
- translation context style projection

### Manual review
Use a real 1-34 chapter reference corpus and inspect:

- global style summary
- character speech summaries
- examples
- chapter coverage
- confidence trends

## Success criteria

The style-learning refactor is successful when:

- translator references are the only source that can raise target-language style confidence
- style evidence accumulates across chapters with provenance
- character speech habits become inspectable and reusable
- translation-time prompts consume structured style constraints rather than only flat heuristics
- quality can validate style drift conservatively instead of relying on a few shallow rules
