# Build And Package

This document covers the desktop GUI build and the Windows release package. The Docker backend has
a separate build lifecycle; see `docs/DOCKER_BACKEND.md`.

## Requirements

- Windows x64 for producing the current desktop release targets.
- Node.js 24 or newer. The backend uses the Node 24 built-in `node:sqlite` module, and the package
  script copies the current `node.exe` into the application as the local-process backend runtime.
- npm dependencies installed from the committed GUI lockfile.
- Enough free disk space for `gui/node_modules`, build output, the installer, and the portable ZIP.

From the repository root, verify the toolchain and install exact dependencies:

```powershell
node --version
npm --version
npm ci --prefix gui
```

Packaging intentionally fails when it is run outside Windows or with Node older than 24. Use a
Windows x64 Node 24 process when producing release artifacts.

## Development Checks

Run the static type check before building:

```powershell
npm --prefix gui run typecheck
```

Build the Electron main process, preload bridge, and React renderer:

```powershell
npm --prefix gui run build
```

The build output is written beneath `gui/dist/`:

```text
gui/dist/main/
gui/dist/preload/
gui/dist/renderer/
```

`npm run build` does not create an installer and does not update an already installed application.
Restart a repository preview after rebuilding when validating renderer changes:

```powershell
npm --prefix gui run preview
```

During repository development, the preview first connects to the configured backend. If it is
unavailable, Electron starts `backend/server.js` with the development machine's Node runtime.

## Windows Package

Create both the assisted NSIS installer and the portable ZIP from the repository root:

```powershell
npm --prefix gui run package
```

The package command performs these steps in order:

1. Verifies that packaging is running on Windows with Node 24 or newer.
2. Copies the current Node executable to `gui/.local-backend-runtime/node.exe`.
3. Runs the Electron production build.
4. Runs `electron-builder` for the `nsis` and `zip` Windows x64 targets.

The generated files are written to `gui/release/`. Their names use the version in
`gui/package.json`:

```text
gui/release/Koharu-Manga-Agent-<version>-Windows-x64.exe
gui/release/Koharu-Manga-Agent-<version>-Windows-x64.exe.blockmap
gui/release/Koharu-Manga-Agent-<version>-Windows-x64.zip
```

Older release files are not automatically removed. Confirm the version in each filename before
publishing or installing a package.

The package contains:

- the Electron GUI;
- backend source used by the local-process fallback;
- the copied Node 24 runtime.

It does not bundle AO, a running Docker backend, manga inputs, translated outputs, user databases,
repository Backend configuration, or a Koharu executable. The packaged Backend starts with its own
defaults and reads configuration from the OS user config directory. The GUI can download or use a
separately selected Koharu executable at runtime.

## Release Verification

At minimum, run:

```powershell
npm --prefix gui run typecheck
npm --prefix gui run build
npm test --prefix tests -- --runInBand
npm --prefix gui run package
```

Then install the newly generated `.exe` and follow `docs/GUI_SMOKE_CHECKLIST.md`. Do not treat a
successful `electron-builder` exit as proof that runtime startup, Backend/Koharu recovery, image
delivery, or uninstall cleanup works.

For an optional checksum before publishing:

```powershell
Get-FileHash gui/release/Koharu-Manga-Agent-<version>-Windows-x64.exe -Algorithm SHA256
Get-FileHash gui/release/Koharu-Manga-Agent-<version>-Windows-x64.zip -Algorithm SHA256
```

## Testing A Renderer Fix

There are two distinct test paths:

- Repository preview: rebuild and restart `npm --prefix gui run preview`.
- Installed or portable application: run `npm --prefix gui run package`, then reinstall the new
  `.exe` or extract the new ZIP.

An existing installed application never reads newly changed files from the repository. For example,
the Post Edit translated-image fix is visible in preview after a rebuild, but an installed copy needs
a newly packaged version.

## Runtime Data Layout

Repository source and runtime state are intentionally separated. A native or packaged backend uses:

```text
%LOCALAPPDATA%\Koharu Manga Agent\backend\
|- cache\               regenerable source and translated-image caches
|- domains\
|  |- knowledge\        durable manga knowledge and reports
|  |- post-edit\        editable scene documents
|  `- reference\        manifests, images, Extraction, and evidence
|- ingress\uploads\     staged REST uploads
|- logs\backend\        backend logs and diagnostic reports
|- outputs\translated\ backend-owned exports
|- runtime\koharu\      backend-managed Koharu runtime, when enabled
|- state\               SQLite job state and knowledge task state
`- workspaces\jobs\     job-scoped intermediate workspaces
```

The GUI stores its preferences separately under Electron's user-data directory. Docker uses the same
relative layout beneath `/data` in the `backend-data` named volume. Release logs therefore do not go
to the installation directory or repository checkout.

There is no legacy directory fallback or automatic migration. Jest creates the same hierarchy beneath
an isolated operating-system temporary directory and removes it in global teardown, so normal test
runs must not recreate runtime folders in the repository.

## Docker Backend Build

Building the desktop package does not rebuild the Docker backend. Build and start that deployment
separately:

```powershell
docker compose -p manga-backend up -d --build
docker compose -p manga-backend ps
Invoke-RestMethod http://127.0.0.1:4001/health
Invoke-RestMethod http://127.0.0.1:4001/ready
```

`/health` verifies backend liveness. `/ready` also checks required dependencies and may return HTTP
503 while Koharu or AO is unavailable.
