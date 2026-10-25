# Docker Backend

## Scope

The container runs only the workflow and persistence backend. AO and Koharu remain external HTTP services. The image does not bundle the GUI, user manga data, a managed Koharu executable, or the repository-level `.opencode` runtime.

The desktop GUI can use this container or fall back to its bundled local-process backend. Both
implement the same REST contract. `GET /health` reports `deploymentMode: "docker"` for the Compose
service so the GUI can display the active backend type.

## Start

```bash
docker compose build --pull backend
docker compose up -d --force-recreate backend
docker compose ps
curl http://127.0.0.1:4001/health
curl http://127.0.0.1:4001/ready
```

The default Compose mapping is loopback-only:

```text
127.0.0.1:4001 -> backend:4001
```

The backend runs as the non-root `node` user. Its writable state is stored in the `backend-data` named volume at `/data`.

With the repository's top-level Compose name, the deployed resources are:

- container: `koharu-manga-agent-backend-1`
- image: `koharu-manga-agent-backend:latest`
- volume: `koharu-manga-agent_backend-data`

## External Services

The image config at `docker/koharu.json` uses these Docker Desktop host addresses:

- Koharu: `http://host.docker.internal:4000`
- AO: `http://host.docker.internal:32768`

`host.docker.internal:host-gateway` is also configured for Linux Docker Engine. Change the URLs when AO or Koharu are Docker services or remote hosts. Managed Koharu is disabled in the container.

Runtime ownership differs by deployment:

| Deployment | Backend owner | Koharu owner | Koharu address seen by backend |
| --- | --- | --- | --- |
| Native `node backend/server.js` | Native process or desktop GUI | Native backend runtime manager | `http://127.0.0.1:4000` |
| Docker backend + desktop GUI | Docker Compose | Desktop GUI host-process service | `http://host.docker.internal:4000` |
| Docker backend without GUI | Docker Compose | Operator-managed host process | `http://host.docker.internal:4000` |

The Linux container cannot install or execute the Windows Koharu binary. Its
`koharuRuntime.managed` setting is therefore `false`; `/runtime/koharu/start` cannot replace the
required host process in Docker mode.

The Docker profile sets `api.pageUploadMode` to `multipart`. This is required because host Koharu cannot open `/data/...` paths from the backend container. Do not change it to `from-paths` unless Backend and Koharu intentionally share the same filesystem and path namespace.

Start Koharu on the host before submitting a Koharu-backed job. It must listen on port `4000` and on an interface reachable from Docker; for example:

```powershell
koharu_windows_x64.exe --headless --host 0.0.0.0 --port 4000
```

The desktop GUI can manage this host process. When `/ready` reports Koharu unavailable, its recovery
dialog can download the official `koharu-rs/koharu` Windows x64 standalone executable, select an
existing executable, or let the user start Koharu manually. A downloaded copy is stored under
`%LOCALAPPDATA%\Koharu Manga Agent\gui\koharu-runtime\<version>\koharu.exe`. The GUI also reuses a
valid copy previously downloaded by the native backend. The selected path and auto-start preference
are stored in the GUI user-data `gui-settings.json`, outside the project folder. At the next GUI launch
it first probes `http://127.0.0.1:4000`; only when that endpoint is unavailable does it start the
configured executable with the command-line arguments shown above. The GUI stops only the Koharu
process it started.

The Koharu API URL in backend configuration remains `http://host.docker.internal:4000` for Docker.
The GUI's host probe uses `http://127.0.0.1:4000`; these addresses refer to the same host service from
different network namespaces.

Keep the host firewall restricted to the Docker/local-machine path. `GET /health` remains HTTP `200`
while Koharu is offline because it reports backend liveness. `GET /ready` returns HTTP `503` with a
`koharu_unavailable` blocker, and `/api/v1/runtime/status` provides the detailed external dependency
state. Koharu-backed create/retry/resume requests are rejected before a job is created.

Operational checks:

```powershell
Invoke-RestMethod http://127.0.0.1:4001/health
Invoke-RestMethod http://127.0.0.1:4001/runtime/status
Invoke-RestMethod http://127.0.0.1:4001/ready
```

Expected states:

- `/health`: `200` whenever the backend process is alive;
- `/runtime/status`: `backend.status = ready`; in Docker, Koharu uses `mode = external`;
- `/ready`: `200` only after host Koharu is reachable, otherwise `503` with
  `koharu_unavailable` and `retrySafe: true` on rejected Koharu-backed requests.

Koharu translation credentials remain on the host. Configure DeepL, Google Cloud Translation, or
Caiyun in Koharu, then inspect the sanitized backend view at
`GET /api/v1/runtime/koharu/translation-providers`. Never put those provider API keys in the browser
extension, Docker image, Job payload, or `docker/koharu.json`.

## Configuration And Data

Two bootstrap environment variables separate code from deployment state:

- `MANGA_TRANSLATION_CONFIG_PATH`: backend configuration file
- `MANGA_TRANSLATION_DATA_ROOT`: root for SQLite, workspaces, references, Knowledge, outputs, and logs

Relative paths from the selected configuration resolve beneath the data root. The default container values are `/data/config/koharu.json` and `/data`. On first startup, the container copies the image template from `/app/docker/koharu.json` into the persistent volume. Settings changed through the API therefore survive container recreation.

`backend/ao/opencode/opencode.json` is bind-mounted read-only by Compose. The build excludes it, so user-owned provider configuration is not stored in an image layer.

For deployment-specific settings, create the ignored local files:

```powershell
Copy-Item docker/koharu.json docker/koharu.local.json
Copy-Item compose.override.example.yaml compose.override.yaml
```

Compose will then mount the local config at `/config/koharu.json`. Update that file with the deployment AO URL, Koharu URL, API key, allowed extension origin, and a strong `server.authToken`. Do not commit API keys or backend tokens.

For a native backend without environment overrides, configuration and runtime data also live outside
the repository:

- Windows config: `%APPDATA%\Koharu Manga Agent\backend\koharu.json`
- Windows data: `%LOCALAPPDATA%\Koharu Manga Agent\backend`
- macOS: `~/Library/Application Support/Koharu Manga Agent/backend`
- Linux config: `${XDG_CONFIG_HOME:-~/.config}/koharu-manga-agent/backend`
- Linux data: `${XDG_DATA_HOME:-~/.local/share}/koharu-manga-agent/backend`

When no native OS user config exists, the backend uses its built-in defaults until settings are
persisted through the backend API. Docker instead initializes its persistent config from
`docker/koharu.json`. Runtime state is created beneath the OS data root. The backend does not migrate
the former flat `cache`, `knowledge_base`, `post_edit`, `references`, `translated`, or `uploads`
layout.

## Browser API Security

The server supports:

- configured CORS origin patterns, including browser-extension origins;
- optional Bearer authentication through `server.authToken`;
- JSON body size limits through `server.maxJsonBodyBytes`;
- request IDs in `X-Request-Id`;
- redaction of AO and backend tokens from configuration responses.

Browser clients should use `/api/v1`. Image input is uploaded through `/api/v1/uploads`; source preflight and Reference import accept the resulting `uploadId`. Job artifacts are downloaded through `/api/v1/jobs/{jobId}/artifacts/{artifactId}/content`, so the extension never needs a container filesystem path.

Run the complete REST Translation workflow with `scripts/rest_translation_workflow.mjs`. Its request sequence and client responsibilities are documented in `docs/REST_WORKFLOW.md`.

`GET /health` and `GET /ready` are intentionally public for deployment probes. Compose uses `/health`
so a temporary external-service outage does not restart the persistence backend. The default container
publishes only to loopback and leaves `server.authToken` unset for initial local development. Set a
strong token before exposing the port beyond the local machine.

## Persistence Check

Container recreation must retain `/data`:

```bash
docker compose restart backend
docker compose exec backend find /data -maxdepth 3 -type f
```

Do not scale this service above one replica while it uses a single SQLite database and Koharu's single-current-project execution model.

## Stop

```bash
docker compose down
```

This keeps the named volume. Removing the volume deletes container-owned persistent state and must be an explicit operator action.

## Rebuild And Fresh Deployment

Update the base image and rebuild the backend from the current workspace:

```powershell
docker compose build --pull backend
docker compose up -d --force-recreate backend
docker compose ps
```

To deliberately discard all Docker-backend state and deploy with a new empty volume:

```powershell
docker compose down
docker volume rm koharu-manga-agent_backend-data
docker compose build --pull backend
docker compose up -d --force-recreate backend
```

The volume deletion is irreversible. It removes the container-owned configuration, SQLite jobs and
events, Reference and Knowledge data, uploads, workspaces, logs, and backend-owned exports. It does
not remove the Docker image, host Koharu projects/models, GUI preferences, or files exported outside
the backend data root.

After deployment, require both container health and dependency readiness:

```powershell
docker inspect --format "{{.State.Status}} {{.State.Health.Status}}" koharu-manga-agent-backend-1
Invoke-RestMethod http://127.0.0.1:4001/health
Invoke-RestMethod http://127.0.0.1:4001/runtime/status
```
