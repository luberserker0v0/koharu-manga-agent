import { spawn, type ChildProcess } from "node:child_process";
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const KOHARU_VERSION = "0.61.2";
const KOHARU_REPOSITORY = "koharu-rs/koharu";
const KOHARU_WINDOWS_X64_ASSET = "koharu_windows_x64.exe";

type KoharuHostStatus = "checking" | "downloading" | "running" | "stopped" | "unavailable" | "failed";

export type KoharuHostProcessState = {
  mode: "external" | "managed";
  status: KoharuHostStatus;
  baseUrl: string;
  executablePath: string | null;
  pid: number | null;
  note: string;
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class KoharuHostProcessService {
  private child: ChildProcess | null = null;
  private readonly baseUrl = "http://127.0.0.1:4000";
  private state: KoharuHostProcessState = {
    mode: "external",
    status: "stopped",
    baseUrl: this.baseUrl,
    executablePath: null,
    pid: null,
    note: "Koharu has not been checked yet.",
  };

  getState(): KoharuHostProcessState {
    return this.state;
  }

  getManagedExecutablePath(): string {
    const localDataRoot = process.env.LOCALAPPDATA || app.getPath("userData");
    return path.join(localDataRoot, "Koharu Manga Agent", "gui", "koharu-runtime", KOHARU_VERSION, "koharu.exe");
  }

  private getLegacyBackendExecutablePath(): string | null {
    if (!process.env.LOCALAPPDATA) return null;
    return path.join(
      process.env.LOCALAPPDATA,
      "Koharu Manga Agent",
      "backend",
      "cache",
      "koharu-runtime",
      KOHARU_VERSION,
      "koharu.exe"
    );
  }

  private validateExecutable(executablePath: string, expectedSize?: number): void {
    const stat = fs.statSync(executablePath);
    if (!stat.isFile() || stat.size < 1024 * 1024) {
      throw new Error("Downloaded Koharu executable is unexpectedly small.");
    }
    if (expectedSize && stat.size !== expectedSize) {
      throw new Error(`Downloaded Koharu size mismatch: expected ${expectedSize}, received ${stat.size}.`);
    }
    const header = Buffer.alloc(2);
    const descriptor = fs.openSync(executablePath, "r");
    try {
      fs.readSync(descriptor, header, 0, header.length, 0);
    } finally {
      fs.closeSync(descriptor);
    }
    if (header.toString("ascii") !== "MZ") {
      throw new Error("Downloaded Koharu file is not a valid Windows executable.");
    }
  }

  async install(): Promise<string> {
    if (process.platform !== "win32" || process.arch !== "x64") {
      throw new Error("Automatic Koharu installation currently supports Windows x64 only.");
    }
    const executablePath = this.getManagedExecutablePath();
    const installedCandidates = [executablePath, this.getLegacyBackendExecutablePath()].filter(Boolean) as string[];
    for (const installedPath of installedCandidates) {
      if (!fs.existsSync(installedPath)) continue;
      try {
        this.validateExecutable(installedPath);
        this.state = {
          ...this.state,
          mode: "managed",
          status: "stopped",
          executablePath: installedPath,
          note: `Koharu ${KOHARU_VERSION} is already installed.`,
        };
        return installedPath;
      } catch {
        // Ignore invalid candidates. Only the GUI-managed target is replaced below.
      }
    }

    const versionDir = path.dirname(executablePath);
    const temporaryPath = path.join(versionDir, `${KOHARU_WINDOWS_X64_ASSET}.${process.pid}.${Date.now()}.tmp`);
    fs.mkdirSync(versionDir, { recursive: true });
    this.state = {
      ...this.state,
      mode: "managed",
      status: "downloading",
      executablePath,
      pid: null,
      note: `Downloading Koharu ${KOHARU_VERSION}.`,
    };

    try {
      const releaseResponse = await fetch(
        `https://api.github.com/repos/${KOHARU_REPOSITORY}/releases/tags/${KOHARU_VERSION}`,
        { headers: { Accept: "application/vnd.github+json", "User-Agent": "koharu-manga-agent-gui" } }
      );
      if (!releaseResponse.ok) {
        throw new Error(`Koharu release lookup failed (${releaseResponse.status}).`);
      }
      const release = await releaseResponse.json() as {
        assets?: Array<{ name?: string; size?: number; browser_download_url?: string }>;
      };
      const asset = release.assets?.find((entry) => entry.name === KOHARU_WINDOWS_X64_ASSET);
      if (!asset?.browser_download_url) {
        throw new Error(`Koharu ${KOHARU_VERSION} does not provide ${KOHARU_WINDOWS_X64_ASSET}.`);
      }
      const assetUrl = new URL(asset.browser_download_url);
      if (assetUrl.protocol !== "https:" || assetUrl.hostname !== "github.com") {
        throw new Error("Koharu release returned an unexpected download URL.");
      }
      const downloadResponse = await fetch(assetUrl, {
        headers: { Accept: "application/octet-stream", "User-Agent": "koharu-manga-agent-gui" },
      });
      if (!downloadResponse.ok || !downloadResponse.body) {
        throw new Error(`Koharu download failed (${downloadResponse.status}).`);
      }
      await pipeline(Readable.fromWeb(downloadResponse.body as never), fs.createWriteStream(temporaryPath, { flags: "wx" }));
      this.validateExecutable(temporaryPath, asset.size);
      fs.rmSync(executablePath, { force: true });
      fs.renameSync(temporaryPath, executablePath);
      this.state = {
        ...this.state,
        mode: "managed",
        status: "stopped",
        executablePath,
        note: `Koharu ${KOHARU_VERSION} was installed by the desktop app.`,
      };
      return executablePath;
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      this.state = {
        ...this.state,
        status: "failed",
        note: `Failed to install Koharu: ${error instanceof Error ? error.message : String(error)}`,
      };
      throw new Error(this.state.note);
    }
  }

  async installAndStart(): Promise<KoharuHostProcessState> {
    if (await this.isReachable()) return this.inspect();
    const executablePath = await this.install();
    return this.start(executablePath);
  }

  private async isReachable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/projects`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async inspect(): Promise<KoharuHostProcessState> {
    const reachable = await this.isReachable();
    if (reachable) {
      this.state = {
        ...this.state,
        mode: this.child ? "managed" : "external",
        status: "running",
        pid: this.child?.pid ?? null,
        note: this.child ? "Koharu is managed by the desktop app." : "Connected to an existing Koharu service.",
      };
    } else if (this.state.status === "checking" || this.state.status === "running") {
      this.state = {
        ...this.state,
        status: this.child ? "failed" : "unavailable",
        pid: this.child?.pid ?? null,
        note: this.child ? "The managed Koharu process is not reachable." : "Koharu is not reachable on the host.",
      };
    }
    return this.state;
  }

  async ensureStarted(options: { autoStart: boolean; executablePath: string }): Promise<KoharuHostProcessState> {
    this.state = { ...this.state, status: "checking", executablePath: options.executablePath || null };
    if (await this.isReachable()) return this.inspect();
    if (!options.autoStart) {
      this.state = {
        ...this.state,
        mode: "external",
        status: "stopped",
        note: "Koharu auto-start is disabled.",
      };
      return this.state;
    }
    if (!options.executablePath.trim()) {
      this.state = {
        ...this.state,
        mode: "external",
        status: "unavailable",
        note: "Koharu auto-start is enabled, but no executable is configured.",
      };
      return this.state;
    }
    return this.start(options.executablePath);
  }

  async start(executablePath: string): Promise<KoharuHostProcessState> {
    if (await this.isReachable()) return this.inspect();
    const resolvedExecutable = path.resolve(executablePath);
    if (!fs.existsSync(resolvedExecutable) || !fs.statSync(resolvedExecutable).isFile()) {
      this.state = {
        ...this.state,
        mode: "managed",
        status: "failed",
        executablePath: resolvedExecutable,
        note: `Koharu executable was not found: ${resolvedExecutable}`,
      };
      throw new Error(this.state.note);
    }
    if (this.child && !this.child.killed) return this.inspect();

    const child = spawn(resolvedExecutable, ["--headless", "--host", "0.0.0.0", "--port", "4000"], {
      cwd: path.dirname(resolvedExecutable),
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    this.child = child;
    this.state = {
      mode: "managed",
      status: "checking",
      baseUrl: this.baseUrl,
      executablePath: resolvedExecutable,
      pid: child.pid ?? null,
      note: "Starting Koharu on the host.",
    };

    child.once("error", (error) => {
      this.state = { ...this.state, status: "failed", pid: null, note: `Failed to start Koharu: ${error.message}` };
    });
    child.once("exit", (code) => {
      if (this.child === child) this.child = null;
      if (this.state.status !== "stopped") {
        this.state = {
          ...this.state,
          status: code === 0 ? "stopped" : "failed",
          pid: null,
          note: code === 0 ? "Koharu exited." : `Koharu exited with code ${code}.`,
        };
      }
    });

    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (await this.isReachable()) return this.inspect();
      if (this.state.status === "failed") break;
      await delay(500);
    }
    this.state = { ...this.state, status: "failed", note: "Koharu did not become reachable within 60 seconds." };
    throw new Error(this.state.note);
  }

  async stopManaged(): Promise<KoharuHostProcessState> {
    if (!this.child || this.child.killed) return this.inspect();
    const child = this.child;
    this.state = { ...this.state, status: "stopped", note: "Stopping desktop-managed Koharu." };
    child.kill();
    await delay(300);
    if (!child.killed) child.kill("SIGKILL");
    this.child = null;
    return this.state;
  }
}

export const koharuHostProcessService = new KoharuHostProcessService();
