---
name: story-delta-contract
description: Fixed line contract and conservative limits for translation-relevant story-memory deltas.
---

# Story Delta Contract

Write only these records:

- `STORY_EVENT|nodeId,nodeId|confidence|participants=name,name|summary|translationImpact`
- `RELATION_DELTA|relationType|subject|object|nodeId,nodeId|confidence|translationImpact`
- `CHARACTER_STATE|character|attribute|value|nodeId,nodeId|confidence|translationImpact`
- `OPEN_THREAD|nodeId,nodeId|confidence|participants=name,name|summary|translationImpact`
- `NO_UPDATE|reason`
- `NOTES|text`

Use one to six evidence anchors. A single narrowly stated fact may use one anchor. A summary joining multiple claims, causes, states, or relationship changes must cite every supporting anchor or be split/narrowed. Never place `|` inside a field.

`participants` contains only explicitly grounded character identities. Use an empty value (`participants=`) rather than a pronoun, title, `?`, or invented identity. Relationship `subject` and `object` must be explicit identities supported by the cited lines; otherwise omit the relation.

`relationType` is a closed enum. Use exactly one of:
- `parentOf`, `childOf`, `siblingOf`, `spouseOf`, `guardianOf`
- `instructorOf`, `studentOf`
- `retainerOf`, `employerOf`, `memberOf`, `leaderOf`
- `allyOf`, `rivalOf`, `enemyOf`, `knows`

Do not invent synonyms such as `tutorOf`, `mentorOf`, `servantOf`, or snake_case variants. Choose the closest exact enum only when its meaning is fully supported; otherwise omit the relationship.

Each relationship endpoint represents exactly one character identity. For one-to-many relationships, emit one `RELATION_DELTA` record per grounded named character. Never combine a role and several names into one endpoint such as `parents (A and B)`.

Limits per chapter:
- at most 3 story events
- at most 3 relationship updates
- at most 3 character-state updates
- at most 2 open threads

Use this incremental-update budget:
- at most 1 story event
- at most 2 relationship updates
- at most 1 character-state update
- at most 1 open thread

A standalone proper name, chapter title, credit, role card, or character-introduction label is not narration evidence when no image is available. Do not cite it in a story record. Cite the surrounding sentence that actually asserts the fact instead.

`summary` and character-state `value` must use `contentLanguage`. For `ja-JP`, write Japanese prose and do not substitute English explanations. If a trustworthy summary cannot be written in `contentLanguage`, narrow it or reuse the strongest evidence line. `translationImpact`, relationType, and attribute may remain English because they are internal control fields.

Only use node identifiers present in `sourceNodes`; the backend resolves each node's page. Every cited anchor is validated and one invalid or duplicated node identifier rejects the whole record. Use dialogue or narration for external events and open threads. Monologue may support motivation, character state, or a grounded relationship, but not an externally confirmed event.

Input role evidence comes from Chapter Observer. Apply it without emitting role-classification records. Do not bind an unknown utterance to a character, and cap confidence at `0.75` when narrative role remains uncertain.

`translationImpact` must say what later translation ambiguity this fact resolves. Omit records that have no concrete translation impact. Use `NO_UPDATE` when all apparent information is transient, already known, or weakly grounded.

Every confidence field must be a decimal number from `0` through `1`, inclusive. Use values such
as `0.70`, `0.85`, or `1`. Never use `high`, `medium`, `low`, `none`, percentages, or an empty field.

Do not emit `EVIDENCE_ROLE`. TextRole and styleChannel are supplied by Chapter Observation and are
not part of this output contract. `NO_UPDATE` must not appear together with an update record.
