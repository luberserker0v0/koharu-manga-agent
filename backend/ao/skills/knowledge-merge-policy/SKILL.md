# Knowledge Merge Policy

Use this policy when producing AO knowledge results.

## Objective
Generate conservative long-term knowledge that the backend can merge safely.

## Priority Rules
- Manual and locked glossary entries outrank AO inference.
- Reference-derived canonical terms outrank self-inferred variants.
- Character naming evidence outranks speculative alias expansion.
- Repeated usage outranks single-line intuition.

## What To Extract
- `terminologyEntries[]`
  - durable terms
  - stable aliases when evidence exists
  - category and confidence
- `characterEntries[]`
  - canonical displayed names
  - aliases or title forms only if evidenced
  - speech_style only if repeated
- `styleProfile`
  - register
  - punctuation behavior
  - honorific handling
  - preferred or forbidden patterns only when repeated
- `styleExampleEntries[]`
  - short representative examples with a reason

## What Not To Do
- Do not overwrite manual canon.
- Do not promote one-off dramatic phrasing into project-wide style.
- Do not treat uncertain proper nouns as durable terms.
- Do not invent aliases.

## Output Reminder
Write only the records defined by `knowledge-line-contract` to the requested output file. The backend owns the resulting JSON schema and merge operation.
