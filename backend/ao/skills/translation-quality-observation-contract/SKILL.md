# Translation Quality Observation Contract

Read the bounded window once and write only escaped pipe-delimited records.

```text
NODE|windowId|nodeId|clean|none|confidence|reason
NODE|windowId|nodeId|suspect|riskType[,riskType...]|confidence|reason
SEQUENCE_RISK|windowId|pageName|startNodeId|endNodeId|confidence|sequence_shift|reason
WINDOW_DONE|windowId
```

Rules:
- Emit exactly one `NODE` record for every supplied node, in supplied order.
- Allowed risk types: `none`, `empty_translation`, `sequence_shift`, `meaning_change`, `locked_term_violation`, `terminology`, `style`, `story_context`, `fluency`.
- `SEQUENCE_RISK` may only span consecutive supplied nodes on one page. Every covered node must also be `suspect` with `sequence_shift`.
- Confidence is a decimal from 0 through 1.
- Escape `|` as `\|`, backslash as `\\`, and line breaks as `\n`.
- Write Unicode directly. Do not output JSON, markdown, unknown IDs, or additional keys.
