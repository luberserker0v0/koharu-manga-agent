import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type ManagedState = "starting" | "running" | "stopped" | "failed";

export type BackendProcessState = {
  mode: "managed" | "external";
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
    mode: "managed",
    status: "stopped",
    note: "Backend not started yet.",
    pid: null,
  };

  private readonly host = "127.0.0.1";
  private readonly port = 4001;
  private readonly nodeCommand = process.platform === "win32" ? "node.exe" : "node";

  getState(): BackendProcessState {
    return this.state;
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
    return path.join(this.resolveProjectRoot(), "backend", "server.js");
  }

  private async isBackendReachable(): Promise<boolean> {
    try {
      const response = await fetch(`http://${this.host}:${this.port}/health`);
      if (!response.ok) {
        return false;
      }
      const payload = (await response.json()) as { ok?: boolean };
      return payload.ok === true;
    } catch {
      return false;
    }
  }

  async ensureStarted(): Promise<void> {
    if (await this.isBackendReachable()) {
      this.state = {
        mode: "external",
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
      mode: "managed",
      status: "starting",
      note: "Starting backend process and Koharu runtime...",
      pid: null,
    };

    const backendEntry = this.getBackendEntry();
    const child = spawn(this.nodeCommand, [backendEntry], {
      cwd: this.resolveProjectRoot(),
      stdio: "pipe",
      env: process.env,
    });

    this.child = child;
    this.state = {
      mode: "managed",
      status: "starting",
      note: "Starting backend process and Koharu runtime...",
      pid: child.pid ?? null,
    };

    child.stdout.on("data", () => {
      if (this.state.mode === "managed" && this.state.status === "starting") {
        this.state = {
          mode: "managed",
          status: "starting",
          note: "Backend process emitted startup output.",
          pid: child.pid ?? null,
        };
      }
    });

    child.stderr.on("data", () => {
      if (this.state.status !== "running") {
        this.state = {
          mode: "managed",
          status: "starting",
          note: "Backend process emitted stderr during startup.",
          pid: child.pid ?? null,
        };
      }
    });

    child.once("exit", (code) => {
      if (this.state.status !== "stopped") {
        this.state = {
          mode: "managed",
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
      if (await this.isBackendReachable()) {
        this.state = {
          mode: this.child ? "managed" : "external",
          status: "running",
          note: this.child
            ? "Backend process is running under Electron management."
            : "Connected to an already running backend.",
          pid: this.child?.pid ?? null,
        };
        return;
      }
      await delay(500);
    }

    this.state = {
      mode: this.child ? "managed" : "external",
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
      mode: "managed",
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
      mode: "managed",
      status: "stopped",
      note: "Managed backend process stopped.",
      pid: null,
    };
  }
}

export const backendProcessService = new BackendProcessService();
