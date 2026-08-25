---
name: knowledge-line-contract
description: Fixed line protocol for lightweight long-term translation learning.
---

# Knowledge Line Contract

Write only these records to the requested output file. Do not write JSON or Markdown.

```text
TERM|sourceTerm|targetRendering|durableCategory|comma-separated evidenceNodeIds|confidence 0-1|notes
CHARACTER|sourceName|targetName|comma-separated evidenceNodeIds|firstSeenChapter|confidence 0-1|notes
CHARACTER_ALIAS|sourceName|alias
CHARACTER_TITLE|sourceName|titleForm
CHARACTER_SPEECH|sourceName|speechPattern
CHARACTER_ENDING|sourceName|sentenceEndingPattern
CHARACTER_ADDRESS|sourceName|addressingPattern
CHARACTER_EXAMPLE|sourceName|nodeId
STYLE_PROFILE|tone|register
STYLE_NARRATION|tone|register
STYLE_RULE|global or narration|honorific or punctuation or preferred or forbidden or note|value
STYLE_EXAMPLE|nodeId|confidence 0-1|reason
NOTE|text
KNOWLEDGE_DONE
```

Rules:
- Escape `|` as `\|`, backslash as `\\`, and line breaks as `\n` inside values.
- Do not escape commas, semicolons, quotes, or ordinary punctuation.
- Write Unicode characters directly; do not emit `\uXXXX` escape sequences.
- Confidence is always a decimal number from 0 through 1.
- Durable term category must be one of `character_name`, `place_name`, `organization_name`, `title`, `technique`, `ability`, `artifact`, `worldbuilding`, or `technical_term`.
- Pronouns, self-reference forms, ordinary nouns, acknowledgements, sentence fragments, and reusable style phrases are not terminology. Omit them rather than assigning a false durable category.
- Every `TERM` must cite at least one node where the source term occurs in `original` and the target rendering occurs in `translation`.
- Every `CHARACTER` must provide the original-language identity and target rendering supported by the same cited evidence.
- Emit `CHARACTER` before records that reference its `sourceName`.
- `STYLE_EXAMPLE` only selects an evidence node already marked with `style_evidence` or `speaker_evidence`; backend copies role, speaker, channel, text and confidence metadata from that node.
- Use only node IDs from the supplied Learning Evidence.
- Omit unsupported records. Do not emit empty placeholder records.
- `KNOWLEDGE_DONE` appears exactly once as the final line.
