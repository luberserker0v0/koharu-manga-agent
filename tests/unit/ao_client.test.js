const { AOClient } = require("../../backend/src/ao_client");

describe("AOClient", () => {
  test("waitUntilReady polls conversation status until ready", async () => {
    const responses = [
      { ok: true, status: 200, json: async () => ({ id: "conv-1", status: "running", ready: false }) },
      { ok: true, status: 200, json: async () => ({ id: "conv-1", status: "running", ready: true }) },
      {
        ok: true,
        status: 200,
        json: async () => ({
          id: "conv-1",
          status: "running",
          ready: true,
          sessionId: "ses-1",
        }),
      },
    ];
    const fetchImpl = jest.fn().mockImplementation(async () => responses.shift());
    const client = new AOClient({
      baseUrl: "http://127.0.0.1:32768",
      fetchImpl,
      readyPollIntervalMs: 1,
      readyTimeoutMs: 100,
    });

    const result = await client.waitUntilReady("conv-1");

    expect(result.ready).toBe(true);
    expect(result.sessionId).toBe("ses-1");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("sendMessage includes optional model and agent", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messageId: "msg-1", text: "{}" }),
    });
    const client = new AOClient({
      baseUrl: "http://127.0.0.1:32768",
      apiKey: "secret-token",
      fetchImpl,
    });

    await client.sendMessage("conv-1", {
      text: "hello",
      model: "openai/gpt-5",
      agent: "quality-optimizer",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:32768/api/conversations/conv-1/message",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          text: "hello",
          model: "openai/gpt-5",
          agent: "quality-optimizer",
        }),
      })
    );
  });

  test("abortSession stops the active AO session", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ aborted: true }),
    });
    const client = new AOClient({ baseUrl: "http://127.0.0.1:32768", fetchImpl });

    await client.abortSession("conv-1");

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:32768/api/conversations/conv-1/sessions/abort",
      expect.objectContaining({ method: "POST", body: "{}" })
    );
  });

  test("writeFile uploads workspace file content through AO API", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    const client = new AOClient({
      baseUrl: "http://127.0.0.1:32768",
      fetchImpl,
    });

    await client.writeFile("conv-1", "input/task_input.json", "{\"ok\":true}");

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:32768/api/conversations/conv-1/files",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          path: "input/task_input.json",
          content: "{\"ok\":true}",
        }),
      })
    );
  });
});
