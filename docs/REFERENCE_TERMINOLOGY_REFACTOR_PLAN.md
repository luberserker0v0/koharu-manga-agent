# Reference Terminology Refactor Plan

## Purpose
This document defines the formal refactor direction for the manga reference system.

The project goal is not generic translation. It is:

1. learn stable terminology and translation style from a small set of trusted reference chapters
2. project that knowledge forward into many untranslated future chapters
3. keep improving terminology confidence and context coverage as more chapters are ingested

The current implementation already supports extraction and ingestion, but its data model still mixes:

- source-language entity extraction
- translator-specific canonical rendering
- translation-oriented glossary contracts

This refactor separates those responsibilities explicitly.

## Product Model

### Problem
Users may only have:

- original manga chapters in Japanese
- a small number of Chinese translated chapters from a trusted scanlation group

The system must use those few translated chapters to build durable knowledge that can guide later translation of many untranslated chapters.

### Core capabilities
The reference system must support:

1. terminology discovery
2. terminology confirmation
3. terminology enforcement in future translation
4. character and context accumulation across chapters
5. translator-style accumulation across chapters

### Key distinction
There are two fundamentally different reference inputs:

- `source reference`
  - original-language material
  - used to discover entities, chapter context, and source-side canonical forms
- `translator reference`
  - translated material from a trusted translator group
  - used to align source entities to preferred target renderings and style behavior

These two inputs must no longer share the same primary semantics.

## Current problems

### 1. Translation-oriented naming leaks into source-only ingestion
Current ingestion stores source-only terminology under:

- `source_term`
- `canonical_translation`

For source references, `canonical_translation` is usually not a translation at all. It is only the chosen canonical form of the source-side entity.

This creates confusion in:

- knowledge assets
- AO task payloads
- UI terminology
- future merge logic

### 2. AO terminology extraction still assumes translation pairs
Source references are currently converted into pseudo translation pairs and sent to AO under a translation-shaped contract.

This makes the AO layer reason about source references as if they were translated examples, which is the wrong abstraction.

### 3. Candidate pool and accepted glossary are conceptually mixed
Current ingestion writes accepted items and candidate items into overlapping structures.

This makes it hard to answer basic product questions such as:

- what is only observed
- what is still under review
- what is already canonical

### 4. Identity and confidence accumulation are too weak
Confidence increases when similar items repeat, but the identity model still depends too heavily on unstable surface forms.

This means:

- the same entity may split into multiple entries
- unrelated entities may merge too early
- confidence can rise for the wrong reasons

### 5. Reference kind is not treated as a first-class runtime fact everywhere
Some code paths still infer source-vs-translator behavior from labels rather than formal stored data.

That must be removed.

## Target architecture

## Layer split

### Layer A: observed entity evidence
Raw and lightly normalized observations extracted from a single reference set.

This layer answers:

- what did this chapter appear to contain
- what evidence lines support it
- how certain was the extractor

### Layer B: candidate entity memory
Cross-chapter accumulation of not-yet-fully-trusted entity candidates.

This layer answers:

- which entities keep reappearing
- how many chapters support them
- whether confidence is rising or falling

### Layer C: accepted canonical knowledge
The stable knowledge layer used by future translation and quality review.

This layer answers:

- which terms are already fixed
- which target rendering should be used
- which aliases and title forms are known

## Target data model

### Shared concepts
Every terminology or character item should revolve around these concepts:

- `entity_id`
- `identity_key`
- `reference_kind`
- `entity_type`
- `source_term`
- `canonical_form`
- `target_rendering`
- `status`
- `confidence`
- `evidence`
- `chapter_ids`
- `reference_set_ids`

### `source reference` semantics
For source references:

- `source_term`
  - observed original-language form
- `canonical_form`
  - normalized source-language canonical form
- `target_rendering`
  - `null` unless aligned by translator evidence later

### `translator reference` semantics
For translator references:

- `source_term`
  - source-side original entity when known
- `canonical_form`
  - stable identity form for the entity
- `target_rendering`
  - preferred translated rendering used by that translator profile

### Compatibility rule
`canonical_translation` remains a compatibility field for existing downstream code, but it is no longer the primary semantic field.

During migration:

- source references map `canonical_translation <- canonical_form`
- translator references map `canonical_translation <- target_rendering`

This preserves backward compatibility while new code moves to explicit fields.

## Target asset layout

### 1. `observed_entities.json`
Per manga and translator profile.

Purpose:

- chapter-level observations from each ingested reference set
- source evidence before canonical merge

Suggested shape:

```json
{
  "metadata": {
    "manga_id": "manga_x",
    "translator_id": "translator_y",
    "updated_at": "2026-07-16T00:00:00.000Z"
  },
  "chapters": {
    "chapter_1": {
      "reference_set_ids": ["ref_1"],
      "entities": [
        {
          "entity_id": "entity_123",
          "reference_kind": "source",
          "entity_type": "character",
          "source_term": "リアム",
          "canonical_form": "リアム・セラ・バンフィールド",
          "target_rendering": null,
          "status": "observed",
          "confidence": 0.82,
          "evidence": [
            {
              "page_name": "001.jpg",
              "line": "..."
            }
          ]
        }
      ]
    }
  }
}
```

### 2. `candidate_terms.json`
Cross-chapter candidate pool.

Purpose:

- accumulate repeated terminology and character candidates
- retain evidence and confidence trends
- keep candidate and rejected states separate from accepted canonical knowledge

Required fields:

- `entity_id`
- `identity_key`
- `reference_kind`
- `entity_type`
- `source_term`
- `canonical_form`
- `target_rendering`
- `status`
- `confidence_score`
- `accepted_count`
- `candidate_count`
- `rejected_count`
- `chapter_ids`
- `reference_set_ids`
- `evidence`

### 3. `canonical_glossary.json`
Accepted and translation-facing knowledge only.

Purpose:

- stable terms used by translation and quality stages
- translator-specific target renderings where known

Required fields:

- `entity_id`
- `identity_key`
- `entity_type`
- `source_term`
- `canonical_form`
- `target_rendering`
- `aliases`
- `source_aliases`
- `title_forms`
- `locked`
- `source`
- `confidence`
- `provenance`

Compatibility fields allowed for migration:

- `canonical_translation`

### 4. `story_context.json`
Story state and chapter evidence.

Purpose:

- chapter-level character lists
- chapter-level terminology references
- key lines and relationships

Update rule:

- `story_context` should store references to canonical entities
- it should not be the primary long-term terminology database

### 5. `style_profile.json`
Translator-facing style memory only.

Important rule:

- source references may contribute evidence about dialogue density and chapter structure
- only translator references may raise target-language style confidence

### 6. `translation_context.json`
A translation-time projection layer.

Purpose:

- collect only the assets needed by runtime translation
- expose canonical terms, chapter-local entities, and style constraints in a translation-friendly format

This file is a derived view, not the primary storage layer.

## AO task split

### Task 1: source terminology extraction
Purpose:

- extract entities from original-language material
- decide whether they should be fixed
- emit conservative evidence-backed candidates

Input should include:

- `referenceKind: "source"`
- `sourceLines[]`
- optional chapter metadata
- existing candidate and glossary context
- story context

Output should include:

- `observedTerminology[]`
- `observedCharacters[]`
- `candidateEntries[]`
- `rejectedEntries[]`
- `notes`

Important:

- no translation-oriented field should be required
- `target_rendering` should normally be `null`

### Task 2: translator terminology alignment
Purpose:

- align source entities to translator-preferred target renderings
- detect aliases, title forms, and rendering preferences

Input should include:

- `referenceKind: "translator"`
- `sourceLines[]`
- `targetLines[]`
- aligned or pseudo-aligned text pairs where available
- existing canonical glossary
- candidate memory
- story context

Output should include:

- `alignedTerminology[]`
- `alignedCharacters[]`
- `candidateEntries[]`
- `rejectedEntries[]`
- `styleSignals`
- `notes`

Important:

- this is the only task that should raise confidence in `target_rendering`

### Task 3: terminology enforcement for future translation
Purpose:

- ensure downstream translation uses accepted canonical knowledge
- prefer trusted target renderings

This remains downstream of reference ingestion and is not part of extraction itself.

## Merge rules

### Identity
Identity must no longer rely only on visible surface strings.

Target rule:

- `identity_key` should be based on normalized entity identity, not only raw observed text
- for source references, prefer normalized source-side identity
- for translator references, align to an existing source identity whenever evidence allows

### Confidence
Confidence should rise with:

- repeated chapter support
- repeated reference-set support
- agreement between source and translator references
- explicit accepted outcomes

Confidence should fall with:

- rejected outcomes
- contradictory alignments
- low-evidence singletons

### Accepted vs candidate
Promotion from candidate to accepted should require:

- sufficient repeated evidence
- no conflict with manual or locked entries
- no stronger conflicting translator alignment

### Locked / manual priority
Manual and locked entries remain highest priority:

- they cannot be overwritten by AO
- AO may only add aliases, examples, or supporting evidence

### Source-vs-translator priority
Target precedence:

1. manual / locked
2. translator-confirmed target rendering
3. source-confirmed canonical form
4. low-confidence candidate memory

## Runtime file impact

### Backend modules to change first
- `backend/src/modules/reference_ingestion.js`
- `backend/src/modules/knowledge_assets.js`
- `backend/src/ao_tasks.js`
- `backend/src/ao_contracts.js`
- `backend/src/http/api_server.js`

### Backend modules to adjust later
- `backend/src/modules/reference_sets.js`
- `backend/src/modules/quality.js`
- `backend/src/modules/knowledge.js`
- `backend/src/modules/knowledge_paths.js`

### GUI files to update after backend contract stabilizes
- `gui/src/renderer/api/jobs.ts`
- `gui/src/renderer/api/knowledge.ts`
- `gui/src/renderer/pages/ReferencePage.tsx`
- ingestion report display helpers

## Migration strategy

### Phase 1: additive compatibility
Add new fields without removing old ones.

Rules:

- keep writing `canonical_translation` for compatibility
- start writing `canonical_form`, `target_rendering`, `entity_type`, and `reference_kind`
- update UI to prefer new fields when available

### Phase 2: AO split
Separate AO extraction paths:

- source extraction path
- translator alignment path

Legacy translation-shaped payloads may remain temporarily behind compatibility helpers.

### Phase 3: candidate and glossary cleanup
Stop writing accepted items into candidate memory as if all candidates were the same class of object.

Target outcome:

- `candidate_terms.json` becomes a true candidate memory layer
- `canonical_glossary.json` becomes a true accepted knowledge layer

### Phase 4: story context cleanup
Refactor `story_context.json` to store references to canonical entities and chapter evidence rather than acting like a secondary glossary.

### Phase 5: compatibility removal
Once all runtime and UI readers use new fields:

- downgrade `canonical_translation` to a compatibility-only export field
- eventually remove label-based source-vs-translator inference

## Validation and test plan

### Unit tests
Add or rewrite tests for:

- source reference ingestion
- translator reference ingestion
- candidate confidence accumulation
- accepted promotion rules
- locked glossary protection
- source-only chapters with no translator rendering

### Integration tests
Cover:

- extraction -> ingestion for source references
- extraction -> ingestion for translator references
- mixed ingestion over multiple chapters
- repeated chapter accumulation
- report payload correctness

### UI validation
The Reference report must clearly show:

- reference type
- confirmed terminology
- pending terminology
- characters
- analyzed chapters
- whether a target rendering exists

For source references, UI must not imply that a translation exists when it does not.

## Implementation order

1. add new terminology fields and compatibility writers
2. split AO extraction contracts into source and translator tasks
3. refactor merge logic for candidate vs accepted layers
4. refactor ingestion report payloads
5. update Reference UI
6. migrate existing knowledge assets
7. adjust downstream quality and translation context readers

## Success criteria

The refactor is successful when:

- source references no longer pretend to be translated glossary entries
- translator references are the only source of preferred target renderings
- terminology confidence improves as more chapters are ingested
- candidates and accepted entries are clearly separated
- role and chapter evidence are visible and trustworthy
- future translation can consume this knowledge without guessing which fields are source-side vs target-side
