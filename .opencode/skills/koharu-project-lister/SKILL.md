---
name: koharu-project-lister
description: |
  Use this skill whenever you need to list, browse, or discover all available Koharu projects via HTTP API. This skill uses a Node.js script to query GET /projects and returns a formatted list of projects with their names, IDs, paths, and last-modified timestamps. Make sure to use this skill anytime the user asks "what projects do I have?", "list koharu projects", "show me all comics", or wants to browse available projects before opening one.
license: MIT
compatibility:
  tools: [node]
  dependencies: []
---

## Skill Instructions

### 1. List All Projects (Node.js Script)

**Action:** Run the script to fetch all available Koharu projects from the HTTP API.

**Script:** `node .opencode/skills/koharu-project-lister/scripts/list-projects.js`

**Logic:**
1. Execute the script (no arguments required).
2. The script queries `GET /api/v1/projects`.
3. Parse the response and format it into a readable table.
4. If the API is unreachable, report the error and suggest checking if Koharu is running.

### 2. Output Format

ALWAYS present the results in a Markdown table with these columns:

| ID | 專案名稱 | 路徑 | 最後更新時間 |
|----|---------|------|-------------|

### 3. Error Handling

- **API Unreachable**: Reply with `"QQ"` and suggest checking if the Koharu service is running.
- **Empty List**: Inform the user that no projects were found and suggest creating a new one.

## API Endpoint

| Action | Method | Endpoint |
|--------|--------|----------|
| List projects | `GET` | `/projects` |

## Script Usage

```bash
# List all available Koharu projects
node .opencode/skills/koharu-project-lister/scripts/list-projects.js

# Custom API URL (optional)
node .opencode/skills/koharu-project-lister/scripts/list-projects.js --api-url http://127.0.0.1:9999
```
