# Bilingual Evidence Contract

This task links only supplied evidence anchors. Target candidates are context, not mandatory
alignment items.

Terminology record:

`TERM_LINK|windowId|sourceMentionId|targetSurface|targetNodeKey[,targetNodeKey]|category|confidence|reason`

Style record:

`STYLE_PAIR|windowId|sourceNodeKey[,sourceNodeKey]|targetNodeKey[,targetNodeKey]|textRole|styleChannel|confidence|reason`

Unmatched anchor record:

`NO_MATCH|windowId|anchorType|anchorId|reason`

Completion record:

`WINDOW_DONE|windowId`

Rules:

- Emit exactly one `TERM_LINK`, `STYLE_PAIR`, or `NO_MATCH` for every supplied anchor.
- `anchorType` is `terminology` or `style`.
- `targetSurface` must occur verbatim in the referenced target nodes.
- Use only node keys, mention IDs, roles, channels, and categories present in the task input.
- A node list contains one to four comma-separated keys.
- Confidence is a decimal number from `0` through `1`.
- Do not emit JSON, markdown, headers, comments, or disposition records for context-only nodes.

Allowed categories: character, title, place, organization, technique, ability, device,
worldbuilding, other_named_entity.

Allowed text roles: dialogue, monologue, narration.

Allowed style channels: character_voice, inner_voice, narrator_voice.
