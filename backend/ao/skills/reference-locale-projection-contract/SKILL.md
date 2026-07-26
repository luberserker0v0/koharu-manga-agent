# Reference Locale Projection Contract

```text
TERM|entryId|targetRendering|confidence|reason
STYLE|exampleId|targetText|confidence|reason
PROJECTION_DONE|projectionId
```

Emit every supplied term and style example exactly once. Preserve meaning and style while adapting only the target locale. Confidence is 0 through 1. Escape pipe as `\|`, backslash as `\\`, and line breaks as `\n`. Do not output JSON, markdown, unknown IDs, manual entries, or locked entries.
