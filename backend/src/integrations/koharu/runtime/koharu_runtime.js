const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const net = require("net");

const WINDOWS_X64_ASSET = "koharu_windows_x64.exe";

function trimBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

function defaultReleaseUrl(repository, version) {
  return `https://api.github.com/repos/${repository}/releases/tags/${version}`;
}

function selectReleaseAsset({ assets = [], platform = process.platform, arch = process.arch }) {
  if (platform === "win32" && arch === "x64") {
    return assets.find((asset) => asset?.name === WINDOWS_X64_ASSET) || null;
  }
  return null;
}

async function readResponseText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function fetchJson(fetchImpl, url, label) {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "manga-translation-koharu-runtime" },
  });
  if (!response.ok) {
    const text = await readResponseText(response);
    throw new Error(`${label} failed (${response.status}): ${text}`);
  }
  return response.json();
}

async function fetchBuffer(fetchImpl, url, label) {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "manga-translation-koharu-runtime" },
  });
  if (!response.ok) {
    const text = await readResponseText(response);
    throw new Error(`${label} failed (${response.status}): ${text}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPortAvailable(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

function defaultDataRoot() {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "Koharu");
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return home ? path.join(home, ".local", "share", "Koharu") : null;
}

function readConfiguredDataRoot(configPath) {
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const match = content.match(/^\s*path\s*=\s*['"]([^'"]+)['"]/m);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function pathExists(targetPath) {
  return targetPath ? fs.existsSync(targetPath) : false;
}

class KoharuRuntimeManager {
  constructor({
    config,
    installRoot,
    fetchImpl = globalThis.fetch,
    spawnImpl = spawn,
  }) {
    this.config = config || {};
    this.installRoot = installRoot;
    this.fetchImpl = fetchImpl;
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.lastError = null;
    this.lastInstall = null;
    this.lastPrepare = null;
    this.selectedPort = Number(this.config.port || 4000);
  }

  get enabled() {
    return this.config.managed !== false;
  }

  get version() {
    return this.config.version || "0.61.2";
  }

  get host() {
    return this.config.host || "127.0.0.1";
  }

  get port() {
    return this.selectedPort;
  }

  get preferredPort() {
    return Number(this.config.port || 4000);
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  get versionDir() {
    return path.join(this.installRoot, this.version);
  }

  get executablePath() {
    return path.join(this.versionDir, process.platform === "win32" ? "koharu.exe" : "koharu");
  }

  isSupportedPlatform() {
    return process.platform === "win32" && process.arch === "x64";
  }

  isManagedChildRunning() {
    return Boolean(this.child && !this.child.killed && this.child.exitCode === null);
  }

  async isReachable(baseUrl = this.baseUrl) {
    try {
      const response = await this.fetchImpl(`${trimBaseUrl(baseUrl)}/api/v1/projects`, {
        headers: { "User-Agent": "manga-translation-koharu-runtime" },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async selectPort() {
    const host = this.host;
    const preferredPort = this.preferredPort;
    const portSearchRange = Number(this.config.portSearchRange || 50);

    for (let offset = 0; offset <= portSearchRange; offset += 1) {
      const candidatePort = preferredPort + offset;
      const candidateBaseUrl = `http://${host}:${candidatePort}`;
      if (await this.isReachable(candidateBaseUrl)) {
        this.selectedPort = candidatePort;
        return { port: candidatePort, mode: "external" };
      }
      if (await isPortAvailable(host, candidatePort)) {
        this.selectedPort = candidatePort;
        return { port: candidatePort, mode: "managed" };
      }
    }

    throw new Error(
      `No available Koharu port found from ${preferredPort} to ${preferredPort + portSearchRange}.`
    );
  }

  async inspect() {
    const installed = fs.existsSync(this.executablePath);
    const reachable = await this.isReachable();
    let status = "not_installed";
    let mode = "managed";
    if (!this.enabled) {
      status = reachable ? "running" : "disabled";
      mode = "external";
    } else if (reachable) {
      status = "running";
      mode = this.isManagedChildRunning() ? "managed" : "external";
    } else if (this.lastError) {
      status = "failed";
    } else if (installed) {
      status = "installed";
    }
    return {
      status,
      mode,
      baseUrl: this.baseUrl,
      version: this.version,
      port: this.port,
      preferredPort: this.preferredPort,
      installed,
      executablePath: installed ? this.executablePath : null,
      installRoot: this.installRoot,
      managedPid: this.isManagedChildRunning() ? this.child.pid || null : null,
      lastError: this.lastError,
      lastInstall: this.lastInstall,
      lastPrepare: this.lastPrepare,
      supported: this.isSupportedPlatform(),
    };
  }

  async inspectPaths({ client = null, baseUrl = this.baseUrl } = {}) {
    const fallbackDataRoot = defaultDataRoot();
    const fallbackConfigPath = fallbackDataRoot ? path.join(fallbackDataRoot, "config.toml") : null;
    let configPath = fallbackConfigPath;
    let dataRoot = configPath ? readConfiguredDataRoot(configPath) : null;
    let projects = [];
    let projectApiError = null;

    if (client?.listProjects && (await this.isReachable(baseUrl))) {
      try {
        projects = await client.listProjects(baseUrl);
      } catch (error) {
        projectApiError = error.message;
      }
    }

    if (!dataRoot && projects[0]?.path) {
      dataRoot = path.dirname(path.dirname(projects[0].path));
      configPath = path.join(dataRoot, "config.toml");
    }
    if (!dataRoot) {
      dataRoot = fallbackDataRoot;
    }
    if (!configPath && dataRoot) {
      configPath = path.join(dataRoot, "config.toml");
    }

    const projectsRoot = dataRoot ? path.join(dataRoot, "projects") : null;
    const modelsRoot = dataRoot ? path.join(dataRoot, "models") : null;
    const runtimeRoot = dataRoot ? path.join(dataRoot, "runtime") : null;
    const fontsRoot = dataRoot ? path.join(dataRoot, "fonts") : null;

    return {
      dataRoot,
      projectsRoot,
      modelsRoot,
      runtimeRoot,
      fontsRoot,
      configPath,
      executablePath: pathExists(this.executablePath) ? this.executablePath : null,
      managedInstallRoot: this.installRoot,
      versionDir: this.versionDir,
      baseUrl,
      exists: {
        dataRoot: pathExists(dataRoot),
        projectsRoot: pathExists(projectsRoot),
        modelsRoot: pathExists(modelsRoot),
        runtimeRoot: pathExists(runtimeRoot),
        fontsRoot: pathExists(fontsRoot),
        configPath: pathExists(configPath),
      },
      projectSamples: projects.slice(0, 10).map((project) => ({
        id: project.id || null,
        name: project.name || null,
        path: project.path || null,
        updatedAtMs: project.updatedAtMs || null,
      })),
      projectApiError,
    };
  }

  async ensureInstalled() {
    if (!this.enabled) {
      throw new Error("Managed Koharu runtime is disabled.");
    }
    if (!this.isSupportedPlatform()) {
      throw new Error("Managed Koharu install currently supports Windows x64 only.");
    }
    if (fs.existsSync(this.executablePath)) {
      this.lastError = null;
      return this.inspect();
    }
    if (typeof this.fetchImpl !== "function") {
      throw new Error("Koharu download requires fetch support.");
    }
    fs.mkdirSync(this.versionDir, { recursive: true });
    const release = await fetchJson(
      this.fetchImpl,
      defaultReleaseUrl(this.config.repository || "mayocream/koharu", this.version),
      "Fetch Koharu release"
    );
    const asset = selectReleaseAsset({ assets: release.assets || [] });
    if (!asset?.browser_download_url) {
      throw new Error(`Koharu release ${this.version} does not include ${WINDOWS_X64_ASSET}.`);
    }
    const temporaryPath = path.join(this.versionDir, `${WINDOWS_X64_ASSET}.${process.pid}.${Date.now()}.tmp`);
    try {
      const buffer = await fetchBuffer(this.fetchImpl, asset.browser_download_url, "Download Koharu");
      fs.writeFileSync(temporaryPath, buffer);
      fs.renameSync(temporaryPath, this.executablePath);
      this.lastInstall = {
        version: this.version,
        assetName: asset.name,
        downloadedAt: new Date().toISOString(),
        size: buffer.length,
      };
      this.lastError = null;
      return this.inspect();
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      this.lastError = error.message;
      throw error;
    }
  }

  buildStartArgs(extraArgs = []) {
    const args = ["--host", this.host, "--port", String(this.port)];
    if (this.config.headless !== false) {
      args.push("--headless");
    }
    return [...args, ...extraArgs];
  }

  async waitUntilReachable(timeoutMs = Number(this.config.startupTimeoutMs || 30000)) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await this.isReachable()) {
        return true;
      }
      await delay(500);
    }
    return false;
  }

  async ensureRunning() {
    if (await this.isReachable()) {
      this.lastError = null;
      return this.inspect();
    }
    await this.ensureInstalled();
    if (this.isManagedChildRunning()) {
      const ready = await this.waitUntilReachable();
      if (!ready) {
        throw new Error(`Managed Koharu did not become reachable at ${this.baseUrl}.`);
      }
      return this.inspect();
    }
    const selected = await this.selectPort();
    if (selected.mode === "external") {
      this.lastError = null;
      return this.inspect();
    }
    const child = this.spawnImpl(this.executablePath, this.buildStartArgs(), {
      cwd: this.versionDir,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    this.child = child;
    child.once("exit", (code, signal) => {
      if (this.child === child) {
        this.child = null;
      }
      if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGINT") {
        this.lastError = `Managed Koharu exited with code ${code}.`;
      }
    });
    const ready = await this.waitUntilReachable();
    if (!ready) {
      this.lastError = `Managed Koharu did not become reachable at ${this.baseUrl}.`;
      throw new Error(this.lastError);
    }
    this.lastError = null;
    return this.inspect();
  }

  async prepareRuntime() {
    await this.ensureInstalled();
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.executablePath, ["--download"], {
        cwd: this.versionDir,
        stdio: "ignore",
        windowsHide: true,
        env: process.env,
      });
      child.once("error", (error) => {
        this.lastError = error.message;
        reject(error);
      });
      child.once("exit", (code) => {
        if (code === 0) {
          this.lastPrepare = { preparedAt: new Date().toISOString(), version: this.version };
          this.lastError = null;
          resolve(this.inspect());
        } else {
          const error = new Error(`Koharu runtime prepare failed with exit code ${code}.`);
          this.lastError = error.message;
          reject(error);
        }
      });
    });
  }

  async stopManaged() {
    if (!this.isManagedChildRunning()) {
      return this.inspect();
    }
    const child = this.child;
    child.kill();
    await delay(300);
    if (this.child === child && this.isManagedChildRunning()) {
      child.kill("SIGKILL");
    }
    this.child = null;
    return this.inspect();
  }
}

module.exports = {
  KoharuRuntimeManager,
  defaultDataRoot,
  readConfiguredDataRoot,
  selectReleaseAsset,
  WINDOWS_X64_ASSET,
};
