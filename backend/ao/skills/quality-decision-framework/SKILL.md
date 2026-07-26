# Quality Decision Framework

Use this framework when producing AO quality results.

## Objective
Judge whether each translation line should stay unchanged, receive a warning, or receive a proposed rewrite.

## Atomic Window Scope
The input `purpose` is authoritative. Perform only checks relevant to that purpose. Other candidate
reasons may be used as supporting evidence, but must not trigger a broader chapter review.

## Required Checks
- glossary_consistency
- locked_term_preservation
- speaker_voice_consistency
- register_consistency
- punctuation_consistency
- context_accuracy
- readability_fluency
- ambiguity_control
- translation_completeness
- sequence_alignment

## Decision Policy
- Emit `ISSUE` when the line is incorrect, inconsistent, misleading, or clearly below project quality.
- Emit `WARNING` when the line may be acceptable but has unresolved ambiguity or weak evidence.
- Emit `REVISION` only when you can produce a clearly better line.
- Prefer minimal, targeted rewrites.
- Treat source/target language metadata as authoritative. A completeness candidate is not automatically wrong, but it must be revised or explicitly accepted with a concrete reason.
- For `sequence` windows, compare the complete ordered page and repair every affected node in the shifted range. Never repair only the final empty node when earlier targets are displaced.

## Rewrite Heuristics
- Preserve canonical terms exactly.
- Preserve the intended speaker attitude.
- Prefer natural Traditional Chinese comic dialogue.
- Avoid over-formal or machine-translated phrasing.
- Avoid changing meaning for style alone.

## Output Reminder
Follow the fixed-line contract selected by the task. Never output JSON or markdown.
