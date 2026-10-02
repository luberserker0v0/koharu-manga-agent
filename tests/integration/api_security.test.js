const { createApiServer } = require("../../backend/src/http/server/api_server");

describe("backend API security boundary", () => {
  let api;
  let baseUrl;
  const effectiveConfig = {
    agent: { apiKey: "ao-secret", model: "provider/model" },
    server: { authToken: "backend-secret" },
  };
  const configService = {
    update: jest.fn(() => effectiveConfig),
    reset: jest.fn(() => effectiveConfig),
  };
  const fetchForbiddenPorts = new Set([6000, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);

  beforeEach(async () => {
    configService.update.mockClear();
    api = createApiServer({
      jobManager: {
        getConfig: () => effectiveConfig,
        getReadiness: jest.fn().mockResolvedValue({ ok: true, status: "ready" }),
      },
      configService,
      host: "127.0.0.1",
      port: 0,
      serverConfig: {
        authToken: "backend-secret",
        corsAllowedOrigins: ["chrome-extension://allowed-id", "http://localhost:*"],
        maxJsonBodyBytes: 32,
      },
    });
    await api.listen();
    let port = api.server.address().port;
    while (fetchForbiddenPorts.has(port)) {
      await api.close();
      api = createApiServer({
        jobManager: {
          getConfig: () => effectiveConfig,
          getReadiness: jest.fn().mockResolvedValue({ ok: true, status: "ready" }),
        },
        configService,
        host: "127.0.0.1",
        port: 0,
        serverConfig: {
          authToken: "backend-secret",
          corsAllowedOrigins: ["chrome-extension://allowed-id", "http://localhost:*"],
          maxJsonBodyBytes: 32,
        },
      });
      await api.listen();
      port = api.server.address().port;
    }
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await api.close();
  });

  test("keeps health public and protects other endpoints", async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, deploymentMode: "standalone" });
    expect((await fetch(`${baseUrl}/config`)).status).toBe(401);
  });

  test("keeps readiness public for deployment probes", async () => {
    const response = await fetch(`${baseUrl}/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "ready" });
  });

  test("accepts a bearer token and redacts secrets", async () => {
    const response = await fetch(`${baseUrl}/config`, {
      headers: { Authorization: "Bearer backend-secret" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    const body = await response.json();
    expect(body.agent.apiKey).toBe("***");
    expect(body.server.authToken).toBe("***");
  });

  test("answers allowed CORS preflights and rejects other origins", async () => {
    const allowed = await fetch(`${baseUrl}/config`, {
      method: "OPTIONS",
      headers: { Origin: "chrome-extension://allowed-id" },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("chrome-extension://allowed-id");

    const denied = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "https://attacker.example" },
    });
    expect(denied.status).toBe(403);
  });

  test("rejects oversized JSON before applying config", async () => {
    const response = await fetch(`${baseUrl}/config`, {
      method: "PATCH",
      headers: {
        Authorization: "Bearer backend-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ agent: { model: "provider/a-very-long-model-name" } }),
    });
    expect(response.status).toBe(413);
    expect(configService.update).not.toHaveBeenCalled();
  });
});
