---
name: koharu-project-opener
description: |
  Use this skill whenever you need to open, switch, list, or close Koharu projects via HTTP API. This skill handles project listing, creation, opening, and closing using Node.js scripts that query the Koharu HTTP API. Make sure to use this skill anytime the user mentions opening a project, switching projects, listing available projects, or checking project status.
license: MIT
compatibility:
  tools: [node]
  dependencies: []
---

## Skill Instructions

All operations use the Koharu HTTP API (`http://127.0.0.1:9999/api/v1`).

### 1. List All Projects

**Script:** `node .opencode/skills/koharu-project-opener/scripts/open-project.js --list`

Fetches all projects via `GET /projects` and displays them in a table.

### 2. Open a Project

**Script:** `node .opencode/skills/koharu-project-opener/scripts/open-project.js --open "{project-id}"`

Opens a managed project by its id via `PUT /projects/current`. The project must already exist in Koharu's managed directory (`{data.path}/projects/`).

### 3. Create a New Project

**Script:** `node .opencode/skills/koharu-project-opener/scripts/open-project.js --create "{project-name}"`

Creates a new project via `POST /projects` with body `{ name: "..." }`.

### 4. Close Current Project

**Script:** `node .opencode/skills/koharu-project-opener/scripts/open-project.js --close`

Closes the currently open project via `DELETE /projects/current`.

### 5. Check Current Project

**Script:** `node .opencode/skills/koharu-project-opener/scripts/open-project.js --current`

Gets the current scene snapshot via `GET /scene.json` to verify a project is open.

## API Endpoints Reference

| Action | Method | Endpoint | Body |
|--------|--------|----------|------|
| List projects | `GET` | `/projects` | — |
| Create project | `POST` | `/projects` | `{ name }` |
| Open project | `PUT` | `/projects/current` | `{ id }` |
| Close project | `DELETE` | `/projects/current` | — |
| Scene snapshot | `GET` | `/scene.json` | — |

## Error Handling

- **API Unreachable**: Reply with `"QQ"` and suggest checking if Koharu is running.
- **Project not found**: Report the error, suggest listing projects first.
- **Success**: Confirm the action and show relevant info (project name, id, page count).

## Script Usage

```bash
# List all projects
node .opencode/skills/koharu-project-opener/scripts/open-project.js --list

# Open a project by id
node .opencode/skills/koharu-project-opener/scripts/open-project.js --open "project-id"

# Create a new project
node .opencode/skills/koharu-project-opener/scripts/open-project.js --create "My Comic"

# Close current project
node .opencode/skills/koharu-project-opener/scripts/open-project.js --close

# Check current project status
node .opencode/skills/koharu-project-opener/scripts/open-project.js --current

# Custom API URL
node .opencode/skills/koharu-project-opener/scripts/open-project.js --list --api-url http://127.0.0.1:9999
```
