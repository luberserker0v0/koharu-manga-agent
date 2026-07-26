---
name: translation-deep-audit-contract
description: Fixed-line contract for complete, non-blocking translation audit windows.
---

# Translation Deep Audit Contract

Emit one disposition for every supplied node:

```text
AUDIT_KEEP|nodeId|reason
AUDIT_FINDING|nodeId|reasonType|severity|confidence|message|keep_or_revise
AUDIT_REVISION|nodeId|reasonType|confidence|revisedTranslation|reason
WINDOW_DONE|windowId
```

Use the same reason-type and severity enums documented by the Quality decision framework. Do not emit JSON, markdown, unknown nodes, or more than one revision per node.
