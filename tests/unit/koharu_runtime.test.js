const fs = require("fs");
const { EventEmitter } = require("events");
const net = require("net");
const os = require("os");
const path = require("path");

const {
  KoharuRuntimeManager,
  WINDOWS_X64_ASSET,
  readConfiguredDataRoot,
  selectReleaseAsset,
} = require("../../backend/src/modules/koharu_runtime");

function tempInstallRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "koharu-runtime-test-"));
}

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function binaryResponse(buffer, ok = true, status = 200) {
  return {
    ok,
    status,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    text: async () => buffer.toString("utf8"),
  };
}

function listen(server, port = 0, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address()));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function fakeChildProcess() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.killed = false;
  child.exitCode = null;
  child.kill = jest.fn(() => {
    child.killed = true;
    child.exitCode = 0;
    child.emit("exit", 0, "SIGTERM");
  });
  return child;
}

describe("KoharuRuntimeManager", () => {
  test("selects the Windows x64 standalone release asset", () => {
    const asset = selectReleaseAsset({
      platform: "win32",
      arch: "x64",
      assets: [
        { name: "koharu_0.61.2_x64-setup.exe" },
        { name: WINDOWS_X64_ASSET, browser_download_url: "https://example.test/koharu.exe" },
      ],
    });

    expect(asset).toEqual(expect.objectContaining({ name: WINDOWS_X64_ASSET }));
  });

  test("reads Koharu data root from config.toml", () => {
    const dir = tempInstallRoot();
    const configPath = path.join(dir, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        "[data]",
        "path = 'C:\\Users\\tester\\AppData\\Local\\Koharu'",
        "",
        "[pipeline]",
        "ocr = \"paddle-ocr-vl-1.6\"",
      ].join("\n")
    );

    expect(readConfiguredDataRoot(configPath)).toBe("C:\\Users\\tester\\AppData\\Local\\Koharu");
  });

  test("does not download when the executable is already installed", async () => {
    const installRoot = tempInstallRoot();
    const versionDir = path.join(installRoot, "0.61.2");
    fs.mkdirSync(versionDir, { recursive: true });
    fs.writeFileSync(path.join(versionDir, "koharu.exe"), "installed");
    const fetchImpl = jest.fn();
    const manager = new KoharuRuntimeManager({
      config: { version: "0.61.2", managed: true },
      installRoot,
      fetchImpl,
    });

    const status = await manager.ensureInstalled();

    expect(status.installed).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain("/api/v1/projects");
  });

  test("removes partial downloads when the asset download fails", async () => {
    const installRoot = tempInstallRoot();
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        assets: [{ name: WINDOWS_X64_ASSET, browser_download_url: "https://example.test/koharu.exe" }],
      }))
      .mockResolvedValueOnce(binaryResponse(Buffer.from("failure"), false, 503));
    const manager = new KoharuRuntimeManager({
      config: { version: "0.61.2", managed: true },
      installRoot,
      fetchImpl,
    });

    await expect(manager.ensureInstalled()).rejects.toThrow("Download Koharu failed");

    const versionDir = path.join(installRoot, "0.61.2");
    const leftovers = fs.existsSync(versionDir)
      ? fs.readdirSync(versionDir).filter((name) => name.endsWith(".tmp") || name === "koharu.exe")
      : [];
    expect(leftovers).toEqual([]);
  });

  test("uses an existing reachable external Koharu without spawning a managed process", async () => {
    const installRoot = tempInstallRoot();
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ projects: [] }));
    const spawnImpl = jest.fn();
    const manager = new KoharuRuntimeManager({
      config: { version: "0.61.2", managed: true, host: "127.0.0.1", port: 4000 },
      installRoot,
      fetchImpl,
      spawnImpl,
    });

    const status = await manager.ensureRunning();

    expect(status.status).toBe("running");
    expect(status.mode).toBe("external");
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  test("selects the next available port when the preferred port is occupied", async () => {
    const blocker = net.createServer();
    const address = await listen(blocker);
    const preferredPort = address.port;
    const installRoot = tempInstallRoot();
    const versionDir = path.join(installRoot, "0.61.2");
    fs.mkdirSync(versionDir, { recursive: true });
    fs.writeFileSync(path.join(versionDir, "koharu.exe"), "installed");
    let spawned = false;
    const fetchImpl = jest.fn(async (url) => {
      if (spawned && String(url).includes(`:${preferredPort + 1}/api/v1/projects`)) {
        return jsonResponse({ projects: [] });
      }
      throw new Error("unreachable");
    });
    const spawnImpl = jest.fn(() => {
      spawned = true;
      return fakeChildProcess();
    });
    const manager = new KoharuRuntimeManager({
      config: {
        version: "0.61.2",
        managed: true,
        host: "127.0.0.1",
        port: preferredPort,
        portSearchRange: 3,
      },
      installRoot,
      fetchImpl,
      spawnImpl,
    });

    try {
      const status = await manager.ensureRunning();

      expect(status.baseUrl).toBe(`http://127.0.0.1:${preferredPort + 1}`);
      expect(status.port).toBe(preferredPort + 1);
      expect(spawnImpl).toHaveBeenCalledWith(
        manager.executablePath,
        expect.arrayContaining(["--port", String(preferredPort + 1)]),
        expect.any(Object)
      );
    } finally {
      await closeServer(blocker);
    }
  });
});
