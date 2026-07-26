const path = require("path");

const SCRIPT_MODULE_PATH = path.join(
  __dirname,
  "../../.opencode/skills/koharu-pipeline-launcher/scripts/listen_events.js"
);
const CONFIG_MODULE_PATH = path.join(
  __dirname,
  "../../.opencode/skills/koharu-pipeline-launcher/lib/config.js"
);
const API_MODULE_PATH = path.join(
  __dirname,
  "../../.opencode/skills/koharu-pipeline-launcher/lib/api.js"
);

function loadScript({ apiFetchImpl } = {}) {
  jest.resetModules();

  jest.doMock(
    CONFIG_MODULE_PATH,
    () => ({
      DEFAULT_BASE_URL: "http://127.0.0.1:9999",
      TIMEOUTS: { sseListen: 600 },
      DEFAULTS: { targetLanguage: "zh-TW" },
      STEP_LABELS: { translate: "Translation" },
      KNOWN_STEPS: ["translate"],
      TERMINAL_STATES: [
        "completed",
        "failed",
        "completed_with_errors",
        "cancelled",
      ],
    }),
    { virtual: false }
  );

  jest.doMock(
    API_MODULE_PATH,
    () => ({
      apiFetch: jest.fn(apiFetchImpl),
      ENDPOINTS: {
        OPERATIONS: "/api/v1/operations",
        EVENTS: "/api/v1/events",
        SCENE: "/api/v1/scene.json",
      },
    }),
    { virtual: false }
  );

  return require(SCRIPT_MODULE_PATH);
}

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(payload),
    text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
  };
}

describe("listen_events.js", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test("recoverFinishedOperation succeeds when listener attaches too late but translated scene state exists", async () => {
    const script = loadScript({
      apiFetchImpl: async (endpoint) => {
        if (endpoint === "/api/v1/scene.json") {
          return jsonResponse({
            scene: {
              pages: {
                page1: {
                  name: "001.png",
                  nodes: {
                    node1: {
                      kind: {
                        text: {
                          text: "hello",
                          translation: "哈囉",
                        },
                      },
                    },
                  },
                },
              },
            },
          });
        }

        throw new Error(`Unexpected endpoint: ${endpoint}`);
      },
    });

    const result = await script.recoverFinishedOperation(
      "http://127.0.0.1:9999",
      "op-123",
      "listener_attached_too_late"
    );

    expect(result.recovered).toBe(true);
    expect(result.finalStatus).toBe("completed_before_listener_attached");
    expect(result.stepTracker.translate.status).toBe("completed");
    expect(result.stepTracker.translate.totalPages).toBe(1);
  });

  test("recoverFinishedOperation fails when no translated scene state exists", async () => {
    const script = loadScript({
      apiFetchImpl: async (endpoint) => {
        if (endpoint === "/api/v1/scene.json") {
          return jsonResponse({
            scene: {
              pages: {
                page1: {
                  name: "001.png",
                  nodes: {},
                },
              },
            },
          });
        }

        throw new Error(`Unexpected endpoint: ${endpoint}`);
      },
    });

    const result = await script.recoverFinishedOperation(
      "http://127.0.0.1:9999",
      "op-123",
      "listener_attached_too_late"
    );

    expect(result.recovered).toBe(false);
    expect(result.finalStatus).toBe("listener_attached_too_late");
  });
});
