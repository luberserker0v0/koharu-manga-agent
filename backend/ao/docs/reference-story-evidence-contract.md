# Reference Story Evidence Contract

Use this contract when the task is reference terminology extraction plus story-context evidence extraction from manga pages.

This contract exists to reduce backend heuristic guessing. The backend should prefer the evidence in this file over rule-based reconstruction whenever the task explicitly requests structured story evidence.

## Objective

Return terminology, character naming, and story evidence that the backend can merge into:

- `canonical_glossary`
- `candidate_terms`
- `story_context`
- `story_graph`
- `social_graph`

The backend owns merge, dedupe, confidence accumulation, and persistence. You own evidence extraction.

## Language Contract

The caller may provide:

- `contentLanguage`
- `sourceLanguage`
- `targetLanguage`
- `fieldLanguagePolicy`

Treat these as authoritative runtime facts.

Rules:

- Schema keys must stay in English.
- Enum values such as `entityType`, `relationType`, `kind`, and `category` must stay in English.
- `surfaceForm` and `evidenceLine` must stay in `contentLanguage`.
- `canonicalForm`, `source_term`, and `source_name` must stay in the source-side language required by `fieldLanguagePolicy`.
- `targetRendering` must use `targetLanguage` only when translator-side evidence really supports that rendering.
- Do not translate evidence text into English just to satisfy formatting.
- If `targetLanguage` is absent, preserve source-side identity conservatively instead of inventing a translated rendering.

## Text Role Contract

When the caller provides `sourceNodes`, each node may include `textRole`, `styleChannel`, and speaker fields produced by Chapter Observer.

- Treat those fields as authoritative classification evidence.
- Use `dialogue`, `monologue`, and `narration` nodes for grounded mentions, relations, and key lines.
- Use `dialogue` and `narration` for externally grounded event evidence.
- A `monologue` can support motivation or characterization, but must not be rewritten as public speech or an externally confirmed event.
- Do not produce story evidence from `label_or_system`, `sfx_like`, `mixed`, or `uncertain` nodes.
- Preserve `pageName` and `nodeId` so the backend can validate every evidence record against its source node.

## Output Modes

There are two allowed output modes, determined by the caller:

1. `line_file`
   - Transitional mode.
   - Use the fixed line-based output requested by the task.
   - Do not invent new record names or reorder fields.
   - When possible, still reason using the structures defined below internally.

2. `json`
   - Preferred structured mode for future reference ingestion.
   - Return a single JSON object with the fields described below.

If the caller explicitly requests one mode, do not switch to the other mode.

## Fixed Line Formats For `line_file` Mode

When the caller requests `line_file`, only use these record types:

- `TERM|<source_term>|<canonical_translation>|<category>|<confidence 0-1>|<reason>`
- `CHARACTER|<source_name>|<canonical_name>|aliases=a,b;title_forms=x,y|<confidence 0-1>|<reason>`
- `MENTION|<entityType>|<surfaceForm>|<canonicalForm>|<pageName>|<nodeId>|<confidence 0-1>|<evidenceLine>`
- `RELATION|<relationType>|<subject>|<object>|<pageName>|<nodeId>|<confidence 0-1>|<evidenceLine>|<notes>`
- `EVENT|<summary>|<pageName>|<nodeId>|<confidence 0-1>|<evidenceLine>`
- `KEYLINE|<kind>|<text>|<pageName>|<nodeId>|<confidence 0-1>|<notes>`
- `MAYBE|<candidate>|<kind>|<confidence 0-1>|<reason>`
- `REJECT|<candidate>|<kind>|<confidence 0-1>|<reason>`
- `NOTES|<free text>`

Rules:

- Use empty fields when a slot is unknown, but keep field order unchanged.
- Do not rename records.
- Do not output JSON in `line_file` mode.
- `MENTION / RELATION / EVENT / KEYLINE` are optional unless the caller explicitly requires story evidence.

## Required Structured Fields For JSON Mode

### `terminologyEntries[]`

Durable terminology candidates suitable for glossary merging.

Each item should contain:

- `term`
- `translation`
- `category`
- `confidence`
- `source_term`
- `notes`

Optional:

- `aliases`
- `source_aliases`
- `evidence`

### `characterEntries[]`

Stable character naming entries suitable for knowledge merging.

Each item should contain:

- `name`
- `source_name`
- `confidence`

Optional:

- `aliases`
- `title_forms`
- `example_lines`
- `speech_style`
- `notes`

### `observedMentions[]`

Mention-level evidence from the source material.

Each item should contain:

- `entityType`
  - one of `character`, `term`, `title_form`, `role`, `location`, `organization`, `worldbuilding`
- `surfaceForm`
- `canonicalForm`
- `pageName`
- `nodeId`
- `evidenceLine`
- `confidence`

Optional:

- `chapterId`
- `roleHint`
- `speakerHint`
- `notes`

### `observedRelations[]`

Structured relation evidence intended to replace backend-first relation guessing.

Each item should contain:

- `relationType`
  - examples: `family_parent`, `family_child`, `family_spouse`, `family_senior_sibling`, `family_junior_sibling`, `mentor_of`, `serves`, `has_role`, `betrothed_to`, `related_to`
- `subject`
- `object`
- `evidenceLine`
- `confidence`

Optional:

- `subjectSurfaceForm`
- `objectSurfaceForm`
- `pageName`
- `nodeId`
- `chapterId`
- `notes`

Rules:

- Only emit `subject` or `object` when the text supports the grounding.
- If the relation signal is visible but grounding is weak, leave the uncertain side empty and explain that in `notes`.
- Do not invent a fully grounded relation from a generic title alone unless the input evidence clearly supports it.

### `observedEvents[]`

Event candidates the backend can merge into chapter/global story context.

Each item should contain:

- `summary`
- `evidenceLine`
- `confidence`

Optional:

- `pageName`
- `nodeId`
- `chapterId`
- `participants`
- `notes`

Rules:

- Prefer concrete plot or state-change events over generic chatter.
- Do not create an event for every dramatic sentence.

### `keyLines[]`

Important context lines worth preserving as chapter evidence.

Each item should contain:

- `text`
- `kind`
  - one of `event`, `relation`, `narration`, `worldbuilding`, `characterization`, `terminology`
- `confidence`

Optional:

- `pageName`
- `nodeId`
- `notes`

Rules:

- Keep only a small, high-signal set.
- Prefer lines that justify terminology, character roles, relationships, or future translation decisions.

### `notes`

Use `notes` to explain:

- uncertain readings
- ambiguous grounding
- why a probable term was omitted
- why a generic-looking term was still extracted as durable setting vocabulary

## Extraction Policy

- Prioritize original-language identity from source text.
- Use translated text only as supporting evidence when it is clearly trustworthy.
- Do not reject a term only because it is not a person name.
- Named schools, techniques, houses, devices, factions, ports, and setting concepts are valid extraction targets.
- When a term appears once but is clearly introduced as a named setting concept, it can still be emitted with moderate confidence.

## Relation Policy

- A relation word by itself is not enough. Prefer grounded relation evidence.
- Generic role mentions are still useful if you preserve uncertainty honestly.
- Backend fallback dictionaries exist, but the goal is to reduce reliance on them by providing direct structured evidence here.

## Event Policy

- Extract fewer, better events.
- Avoid overproducing summaries from weak lines.
- Prefer durable context the translation system can reuse later.
- Prefer plot change, role change, transfer of control, conflict outcome, arrival/departure, training milestone, execution, assignment, or revealed causality.
- Do not emit an event for a line that only expresses desire, resolve, attitude, admiration, or generic observation unless it clearly triggers a durable state change.
- Keep chapter-level event output small. In normal cases, no more than 4 high-signal events should survive.

## Confidence Guidance

- `0.85 - 1.0`: repeated and explicit
- `0.70 - 0.84`: strong single-scene evidence or repeated contextual support
- `0.55 - 0.69`: plausible but not fully grounded
- `< 0.55`: usually omit unless the caller explicitly wants uncertain candidates
