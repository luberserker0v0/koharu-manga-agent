# Chapter Observation Contract

Write plain text records only. Never write JSON or markdown.

Every input node must have exactly one record:

`NODE|pageName|nodeId|textRole|speakerType|speakerRef|styleChannel|roleConfidence|speakerConfidence|reason`

Optional grounded evidence records:

`MENTION|mentionId|pageName::nodeId[,pageName::nodeId]|surfaceForm|entityType|confidence|reason`

`STORY_CUE|cueId|pageName::nodeId[,pageName::nodeId]|cueType|confidence|reason`

`NOTES|free text`

Confidence fields are decimal numbers from `0` through `1`, inclusive. Always emit a numeric
literal such as `0`, `0.35`, `0.80`, or `1`. Never emit qualitative labels such as `high`,
`medium`, `low`, `none`, `unknown`, or percentages such as `80%`.

For `speakerType=none`, `speakerConfidence` means confidence that the node has no speaker; it is
still numeric. For example:

`NODE|001.jpg|node-1|narration|narrator||narrator_voice|0.96|0.92|Narration is explicit.`

`NODE|001.jpg|node-2|sfx_like|none||sfx|0.88|0.95|The node is a sound effect with no speaker.`

`NODE|001.jpg|node-3|uncertain|uncertain||unknown|0.30|0.20|Text-only evidence is insufficient.`

Speaker semantics:
- `dialogue`: use `character` when a character is speaking, otherwise `uncertain`.
- `monologue`: use `character` for an internal character voice, otherwise `uncertain`; do not use `narrator`.
- `narration`: use `narrator` when narration is grounded, otherwise `uncertain`.
- `label_or_system` and `sfx_like`: normally use `none`.
- Leave `speakerRef` empty unless the character identity is grounded by supplied text or knownCharacters.
- Never invent placeholder identities such as `MC`, `speaker_1`, `guide`, or `unknown_character`.

Allowed values:

- textRole: dialogue, monologue, narration, label_or_system, sfx_like, mixed, uncertain
- speakerType: character, narrator, none, uncertain
- styleChannel: character_voice, inner_voice, narrator_voice, label_text, sfx, unknown
- entityType: character, title, place, organization, technique, ability, device, worldbuilding, other_named_entity
- cueType: event, relationship, character_state, worldbuilding, open_thread, translation_ambiguity

Use `worldbuilding` only for a grounded setting rule, political structure, rank system, named state,
or institution whose meaning can affect later translation. Do not emit atmosphere, generic setting
description, or every newly mentioned object as worldbuilding.

Emit at most 12 `STORY_CUE` records for one chapter. Select only the strongest durable cues that can
prevent a later translation ambiguity. This is a first-pass observation, not a chapter summary.

Use English only for keys and enum values. Preserve surfaceForm in the input language. Write
reason in contentLanguage. Do not emit ordinary nouns as mentions, and do not emit a story cue
unless it could prevent a later translation ambiguity.
