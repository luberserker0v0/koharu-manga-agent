---
name: quality-line-contract
description: Fixed-line contract for bounded Standard Quality windows.
---

# Quality Line Contract

Write plain text records only. Escape `|` as `\|`, `\` as `\\`, and line breaks as `\n` inside fields.

Allowed records:

```text
ISSUE|nodeId|reasonType|severity|confidence|message|keep_or_revise
WARNING|nodeId|reasonType|severity|confidence|message|keep_or_revise
REVISION|nodeId|reasonType|confidence|revisedTranslation|reason
ACCEPT|nodeId|translation_completeness|reason
PASS|checkName
FAIL|checkName
NOTES|free text
WINDOW_DONE|windowId
```

Do not emit a `WINDOW` header, JSON, markdown, `\uXXXX` escapes, or any record not listed above. Write Unicode characters directly.

Allowed reason types are `glossary_consistency`, `locked_term_preservation`, `context_accuracy`, `speaker_voice_consistency`, `register_consistency`, `punctuation_consistency`, `readability_fluency`, `ambiguity_control`, and `translation_accuracy`.

Severity is `low`, `medium`, or `high`. Confidence is a decimal from 0 through 1. Emit no more than one `REVISION` per node and never rewrite a locked canonical term. End with exactly one matching `WINDOW_DONE` record.

Every candidate selected for `translation_missing`, `source_target_identity`, or `target_script_mismatch` must receive exactly one completeness outcome:
- Emit `REVISION` when the target text is missing or untranslated.
- Emit `ACCEPT` only when retaining the supplied target text is intentional, such as a proper name, symbol, or sound effect. The reason must identify the concrete exception.

Do not emit `ACCEPT` for `representative_sample` or any other non-completeness candidate. A `keep` issue or warning cannot be followed by `REVISION` for the same node.
