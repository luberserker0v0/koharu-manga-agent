# Docker Backend

## Scope

The container runs only the workflow and persistence backend. AO and Koharu remain external HTTP services. The image does not bundle the GUI, user manga data, a managed Koharu executable, or the repository-level `.opencode` runtime.

## Start

```bash
docker compose -p manga-backend up -d --build
docker compose -p manga-backend ps
curl http://127.0.0.1:4001/health
```

The default Compose mapping is loopback-only:

```text
127.0.0.1:4001 -> backend:4001
```

The backend runs as the non-root `node` user. Its writable state is stored in the `backend-data` named volume at `/data`.

## External Services

The image config at `docker/koharu.json` uses these Docker Desktop host addresses:

- Koharu: `http://host.docker.internal:4000`
- AO: `http://host.docker.internal:32768`

`host.docker.internal:host-gateway` is also configured for Linux Docker Engine. Change the URLs when AO or Koharu are Docker services or remote hosts. Managed Koharu is disabled in the container.

The Docker profile sets `api.pageUploadMode` to `multipart`. This is required because host Koharu cannot open `/data/...` paths from the backend container. Do not change it to `from-paths` unless Backend and Koharu intentionally share the same filesystem and path namespace.

Start Koharu on the host before submitting a Koharu-backed job. It must listen on port `4000` and on an interface reachable from Docker; for example:

```powershell
koharu_windows_x64.exe --headless --host 0.0.0.0 --port 4000
```

Keep the host firewall restricted to the Docker/local-machine path. The backend health endpoint can be ready while Koharu is offline, but `/api/v1/runtime/status` will report the external dependency as unavailable and Koharu-backed jobs must not proceed.

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

On first native startup, an existing repository `.opencode/koharu.json` is copied to the user config
location. Runtime data is not silently moved or deleted; set `MANGA_TRANSLATION_DATA_ROOT` explicitly
when performing a controlled migration of an existing installation.

## Browser API Security

The server supports:

- configured CORS origin patterns, including browser-extension origins;
- optional Bearer authentication through `server.authToken`;
- JSON body size limits through `server.maxJsonBodyBytes`;
- request IDs in `X-Request-Id`;
- redaction of AO and backend tokens from configuration responses.

Browser clients should use `/api/v1`. Image input is uploaded through `/api/v1/uploads`; source preflight and Reference import accept the resulting `uploadId`. Job artifacts are downloaded through `/api/v1/jobs/{jobId}/artifacts/{artifactId}/content`, so the extension never needs a container filesystem path.

Run the complete REST Translation workflow with `scripts/rest_translation_workflow.mjs`. Its request sequence and client responsibilities are documented in `docs/REST_WORKFLOW.md`.

`GET /health` is intentionally public for the Docker healthcheck. The default container publishes only to loopback and leaves `server.authToken` unset for initial local development. Set a strong token before exposing the port beyond the local machine.

## Persistence Check

Container recreation must retain `/data`:

```bash
docker compose -p manga-backend restart backend
docker compose -p manga-backend exec backend find /data -maxdepth 3 -type f
```

Do not scale this service above one replica while it uses a single SQLite database and Koharu's single-current-project execution model.

## Stop

```bash
docker compose -p manga-backend down
```

This keeps the named volume. Removing the volume deletes container-owned persistent state and must be an explicit operator action.
