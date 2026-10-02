import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type ManagedState = "starting" | "running" | "stopped" | "failed";
type BackendDeploymentMode = "docker" | "local-process" | "standalone" | "unknown";

export type BackendProcessState = {
  mode: "local-process" | "external";
  deploymentMode: BackendDeploymentMode;
  fallbackUsed: boolean;
  baseUrl: string;
  status: ManagedState;
  note: string;
  pid: number | null;
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BackendProcessService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: BackendProcessState = {
    mode: "local-process",
    deploymentMode: "unknown",
    fallbackUsed: false,
    baseUrl: "http://127.0.0.1:4001",
    status: "stopped",
    note: "Backend not started yet.",
    pid: null,
  };

  private readonly host = "127.0.0.1";
  private readonly port = 4001;
  private activeBaseUrl = `http://${this.host}:${this.port}`;
  getState(): BackendProcessState {
    return this.state;
  }

  private getPackagedRoot(): string {
    return process.resourcesPath;
  }

  private resolveProjectRoot(): string {
    const candidates = [
      app.getAppPath(),
      process.cwd(),
      __dirname,
    ];

    for (const candidate of candidates) {
      let current = path.resolve(candidate);
      for (let depth = 0; depth < 6; depth += 1) {
        const backendEntry = path.join(current, "backend", "server.js");
        if (fs.existsSync(backendEntry)) {
          return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
          break;
        }
        current = parent;
      }
    }

    throw new Error("Unable to resolve project root for backend startup.");
  }

  private getBackendEntry(): string {
    return app.isPackaged
      ? path.join(this.getPackagedRoot(), "backend", "server.js")
      : path.join(this.resolveProjectRoot(), "backend", "server.js");
  }

  private getBackendWorkingDirectory(): string {
    return app.isPackaged ? this.getPackagedRoot() : this.resolveProjectRoot();
  }

  private getNodeCommand(): string {
    if (!app.isPackaged) return process.platform === "win32" ? "node.exe" : "node";
    return path.join(this.getPackagedRoot(), "runtime", process.platform === "win32" ? "node.exe" : "node");
  }

  private async inspectBackend(baseUrl = this.activeBaseUrl): Promise<{ reachable: boolean; deploymentMode: BackendDeploymentMode }> {
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`);
      if (!response.ok) {
        return { reachable: false, deploymentMode: "unknown" };
      }
      const payload = (await response.json()) as { ok?: boolean; deploymentMode?: string };
      const deploymentMode = ["docker", "local-process", "standalone"].includes(payload.deploymentMode || "")
        ? payload.deploymentMode as BackendDeploymentMode
        : "unknown";
      return { reachable: payload.ok === true, deploymentMode };
    } catch {
      return { reachable: false, deploymentMode: "unknown" };
    }
  }

  async ensureStarted(configuredBaseUrl = `http://${this.host}:${this.port}`): Promise<void> {
    this.activeBaseUrl = configuredBaseUrl.trim().replace(/\/+$/, "") || `http://${this.host}:${this.port}`;
    const existing = await this.inspectBackend();
    if (existing.reachable) {
      this.state = {
        mode: "external",
        deploymentMode: existing.deploymentMode,
        fallbackUsed: false,
        baseUrl: this.activeBaseUrl,
        status: "running",
        note: "Connected to an already running backend.",
        pid: this.child?.pid ?? null,
      };
      return;
    }

    if (this.child && !this.child.killed) {
      await this.waitUntilHealthy();
      return;
    }

    this.state = {
      mode: "local-process",
      deploymentMode: "local-process",
      fallbackUsed: true,
      baseUrl: `http://${this.host}:${this.port}`,
      status: "starting",
      note: "No external backend was found; starting the local-process fallback.",
      pid: null,
    };

    const backendEntry = this.getBackendEntry();
    const nodeCommand = this.getNodeCommand();
    this.activeBaseUrl = `http://${this.host}:${this.port}`;
    if (!fs.existsSync(backendEntry)) {
      this.state = { ...this.state, status: "failed", note: `Bundled backend entry was not found: ${backendEntry}` };
      throw new Error(`Bundled backend entry was not found: ${backendEntry}`);
    }
    if (app.isPackaged && !fs.existsSync(nodeCommand)) {
      this.state = { ...this.state, status: "failed", note: `Bundled Node runtime was not found: ${nodeCommand}` };
      throw new Error(`Bundled Node runtime was not found: ${nodeCommand}`);
    }
    const child = spawn(nodeCommand, [backendEntry], {
      cwd: this.getBackendWorkingDirectory(),
      stdio: "pipe",
      env: {
        ...process.env,
        MANGA_TRANSLATION_BACKEND_MODE: "local-process",
      },
    });

    this.child = child;
    this.state = {
      mode: "local-process",
      deploymentMode: "local-process",
      fallbackUsed: true,
      baseUrl: this.activeBaseUrl,
      status: "starting",
      note: "Starting the local-process backend fallback.",
      pid: child.pid ?? null,
    };

    child.stdout.on("data", () => {
      if (this.state.mode === "local-process" && this.state.status === "starting") {
        this.state = {
          ...this.state,
          status: "starting",
          note: "Backend process emitted startup output.",
          pid: child.pid ?? null,
        };
      }
    });

    child.stderr.on("data", () => {
      if (this.state.status !== "running") {
        this.state = {
          ...this.state,
          status: "starting",
          note: "Backend process emitted stderr during startup.",
          pid: child.pid ?? null,
        };
      }
    });

    child.once("error", (error) => {
      this.state = {
        mode: "local-process",
        deploymentMode: "local-process",
        fallbackUsed: true,
        baseUrl: this.activeBaseUrl,
        status: "failed",
        note: `Failed to start local-process backend: ${error.message}`,
        pid: null,
      };
    });

    child.once("exit", (code) => {
      if (this.state.status !== "stopped") {
        this.state = {
          mode: "local-process",
          deploymentMode: "local-process",
          fallbackUsed: true,
          baseUrl: this.activeBaseUrl,
          status: code === 0 ? "stopped" : "failed",
          note: code === 0 ? "Backend process exited." : `Backend process exited with code ${code}.`,
          pid: null,
        };
      }
      this.child = null;
    });

    await this.waitUntilHealthy();
  }

  private async waitUntilHealthy(): Promise<void> {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const backend = await this.inspectBackend();
      if (backend.reachable) {
        this.state = {
          mode: this.child ? "local-process" : "external",
          deploymentMode: this.child ? "local-process" : backend.deploymentMode,
          fallbackUsed: Boolean(this.child),
          baseUrl: this.activeBaseUrl,
          status: "running",
          note: this.child
            ? "Backend process is running under Electron management."
            : "Connected to an already running backend.",
          pid: this.child?.pid ?? null,
        };
        return;
      }
      if (this.state.status === "failed") break;
      await delay(500);
    }

    this.state = {
      mode: this.child ? "local-process" : "external",
      deploymentMode: this.child ? "local-process" : "unknown",
      fallbackUsed: Boolean(this.child),
      baseUrl: this.activeBaseUrl,
      status: "failed",
      note: "Backend health check timed out during startup.",
      pid: this.child?.pid ?? null,
    };
    throw new Error("Failed to start backend process.");
  }

  async stopManaged(): Promise<void> {
    if (!this.child || this.child.killed) {
      return;
    }

    this.state = {
      mode: "local-process",
      deploymentMode: "local-process",
      fallbackUsed: true,
      baseUrl: this.activeBaseUrl,
      status: "stopped",
      note: "Stopping managed backend process.",
      pid: this.child.pid ?? null,
    };

    const child = this.child;
    child.kill();
    await delay(300);
    if (!child.killed) {
      child.kill("SIGKILL");
    }
    this.child = null;
    this.state = {
      mode: "local-process",
      deploymentMode: "local-process",
      fallbackUsed: true,
      baseUrl: this.activeBaseUrl,
      status: "stopped",
      note: "Managed backend process stopped.",
      pid: null,
    };
  }
}

export const backendProcessService = new BackendProcessService();
