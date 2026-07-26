---
name: knowledge-line-contract
description: Fixed line protocol for lightweight long-term translation learning.
---

# Knowledge Line Contract

Write only these records to the requested output file. Do not write JSON or Markdown.

```text
TERM|term|translation|category|confidence 0-1|notes
CHARACTER|name|firstSeenChapter|confidence 0-1|notes
CHARACTER_ALIAS|characterName|alias
CHARACTER_TITLE|characterName|titleForm
CHARACTER_SPEECH|characterName|speechPattern
CHARACTER_ENDING|characterName|sentenceEndingPattern
CHARACTER_ADDRESS|characterName|addressingPattern
CHARACTER_EXAMPLE|characterName|pageName|nodeId|translation
STYLE_PROFILE|tone|register
STYLE_NARRATION|tone|register
STYLE_RULE|global or narration|honorific or punctuation or preferred or forbidden or note|value
STYLE_EXAMPLE|translation|dialogue or narration|pageName|nodeId|reason
NOTE|text
KNOWLEDGE_DONE
```

Rules:
- Escape `|` as `\|`, backslash as `\\`, and line breaks as `\n` inside values.
- Do not escape commas, semicolons, quotes, or ordinary punctuation.
- Write Unicode characters directly; do not emit `\uXXXX` escape sequences.
- Confidence is always a decimal number from 0 through 1.
- Emit `CHARACTER` before records that reference that character.
- Use only node IDs from the supplied Learning Evidence.
- Omit unsupported records. Do not emit empty placeholder records.
- `KNOWLEDGE_DONE` appears exactly once as the final line.
