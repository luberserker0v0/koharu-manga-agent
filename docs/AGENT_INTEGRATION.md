# Agent Integration Design

## Goal
This document defines the official AO-only integration contract between the backend
and the LLM runtime.

AO is the only LLM execution boundary. The backend never touches the AO project
workspace on disk and never uses `agent_sdk`, provider registries, or SDK-loaded
runtime adapters.

## Design Principles
- backend owns workflow control flow
- backend owns retries, timeout policy, export, and close sequencing
- AO is accessed only through HTTP API
- AO conversations are temporary stage resources and must be deleted after use
- backend validates AO outputs against task-specific schemas before mutating state

## Implemented Backend Modules
- `backend/src/ao_client.js`
- `backend/src/ao_assets.js`
- `backend/src/ao_tasks.js`
- `backend/src/ao_contracts.js`

Responsibilities:
- `ao_client`
  - create/configure/start/poll/message/delete AO conversations
- `ao_assets`
  - load `backend/ao/` assets and package skill folders
- `ao_tasks`
  - run quality and knowledge AO tasks and write backend-owned artifacts
- `ao_contracts`
  - validate AO task result shapes

## AO Conversation Protocol
Each AO task uses this fixed sequence:
1. `POST /api/conversations`
2. upload `backend/ao/opencode/opencode.json` to `workspace/.opencode/opencode.json`
3. upload `backend/ao/AGENTS.md`
4. upload `backend/ao/agents/*.md`
5. upload `backend/ao/skills/*`
6. `POST /api/conversations/:id/start`
7. poll `GET /api/conversations/:id` until `ready === true`
8. `POST /api/conversations/:id/message`
9. `DELETE /api/conversations/:id`

Rules:
- `message` must never be sent before `ready === true`
- if AO returns non-running state, HTTP error, or ready timeout, the stage fails
- backend treats AO initialization failure as a normal stage failure under workflow policy

## AO Asset Sources
Runtime AO assets live in this repository:
- `backend/ao/AGENTS.md`
- `backend/ao/agents/`
- `backend/ao/skills/`
- `backend/ao/opencode/opencode.json`

`opencode.json` is provided manually and only uploaded by the backend.

## Task Contracts

### Quality
Backend input includes:
- one evidence-selected candidate window
- only relevant canonical or locked terms
- compact chapter story, role, speaker, style, and exact local-pair evidence

AO writes the fixed-line `ISSUE`, `WARNING`, `REVISION`, `PASS`, `FAIL`, `NOTES`, and `WINDOW_DONE` protocol. The backend owns report JSON, score, coverage, statistics, and validation.

The backend converts `proposedTranslations[]` into Koharu history ops, reapplies the
scene fetch, and writes the final quality report artifact.

### Knowledge
Knowledge enrichment reads only the backend-owned `learning_evidence_snapshot`; it never rereads the complete final scene or Translation Memory.

AO output must include:
- `terminologyEntries[]`
- `characterEntries[]`
- `styleProfile`
- `styleExampleEntries[]`
- `notes`

Merge policy is backend-owned:
- manual and locked glossary entries are not overwritten
- reference-derived canonical glossary outranks self-inferred entries
- AO may enrich aliases, examples, speech style, and confidence
- style profile is incrementally merged, not wholesale replaced

## Config Contract
`.opencode/koharu.json` now uses AO-specific agent keys:

```json
{
  "agent": {
    "baseUrl": "http://127.0.0.1:32768",
    "apiKey": null,
    "model": null,
    "agentName": null,
    "qualityAgentName": "quality-optimizer",
    "knowledgeAgentName": "knowledge-builder",
    "startTimeoutMs": 10000,
    "readyPollIntervalMs": 1000,
    "readyTimeoutMs": 30000,
    "messageTimeoutMs": 300000
  }
}
```

Config precedence remains:
- HTTP request overrides
- `.opencode/koharu.json`
- backend defaults

## Acceptance Criteria
- AO is the only LLM boundary
- no `agent_sdk` compatibility layer remains in runtime code
- backend can initialize, poll, message, and clean up AO conversations
- quality can apply AO-proposed fixes back to Koharu
- knowledge learns only from quality-optimized scenes
- AO failures stop the current stage according to workflow failure policy
