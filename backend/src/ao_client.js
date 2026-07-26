const crypto = require("crypto");

class AOClient {
  constructor({
    baseUrl,
    apiKey = null,
    fetchImpl = fetch,
    readyPollIntervalMs = 1000,
    readyTimeoutMs = 30000,
  } = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.readyPollIntervalMs = readyPollIntervalMs;
    this.readyTimeoutMs = readyTimeoutMs;
  }

  buildUrl(pathname) {
    return `${this.baseUrl}${pathname}`;
  }

  buildHeaders(extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async request(pathname, { method = "GET", headers = {}, body } = {}) {
    const finalHeaders = this.buildHeaders(headers);
    const options = { method, headers: finalHeaders };

    if (body !== undefined) {
      options.body = body;
    }

    const response = await this.fetchImpl(this.buildUrl(pathname), options);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`AO request failed (${method} ${pathname}, ${response.status}): ${text}`);
    }
    return response;
  }

  async requestJson(pathname, options = {}) {
    const response = await this.request(pathname, options);
    if (response.status === 204) {
      return null;
    }
    return response.json();
  }

  async createConversation(conversationId = null) {
    return this.requestJson("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: conversationId || `ao-${crypto.randomUUID()}` }),
    });
  }

  async writeConfig(conversationId, config) {
    return this.requestJson(`/api/conversations/${conversationId}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
  }

  async writeAgentsMd(conversationId, content) {
    return this.requestJson(`/api/conversations/${conversationId}/agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  }

  async writeAgentFile(conversationId, name, content) {
    return this.requestJson(`/api/conversations/${conversationId}/agents`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content }),
    });
  }

  async writeFile(conversationId, filePath, content) {
    return this.requestJson(`/api/conversations/${conversationId}/files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, content }),
    });
  }

  async readFile(conversationId, filePath) {
    return this.requestJson(`/api/conversations/${conversationId}/files/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath }),
    });
  }

  async listFiles(conversationId, filePath = null) {
    const body = filePath ? { path: filePath } : {};
    return this.requestJson(`/api/conversations/${conversationId}/files/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async uploadSkillZip(conversationId, skillName, zipBuffer) {
    return this.requestJson(`/api/conversations/${conversationId}/skills/upload?name=${encodeURIComponent(skillName)}`, {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: zipBuffer,
    });
  }

  async startConversation(conversationId) {
    return this.requestJson(`/api/conversations/${conversationId}/start`, {
      method: "POST",
    });
  }

  async getConversation(conversationId) {
    return this.requestJson(`/api/conversations/${conversationId}`);
  }

  async waitUntilReady(conversationId, {
    readyPollIntervalMs = this.readyPollIntervalMs,
    readyTimeoutMs = this.readyTimeoutMs,
  } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < readyTimeoutMs) {
      const current = await this.getConversation(conversationId);
      if (
        current.ready === true &&
        typeof current.sessionId === "string" &&
        current.sessionId.length > 0
      ) {
        return current;
      }
      if (current.status !== "running") {
        throw new Error(`AO conversation ${conversationId} is not running while waiting for ready.`);
      }
      await new Promise((resolve) => setTimeout(resolve, readyPollIntervalMs));
    }
    throw new Error(`AO conversation ${conversationId} did not become ready within ${readyTimeoutMs}ms.`);
  }

  async sendMessage(conversationId, { text, model = null, agent = null }) {
    const payload = { text };
    if (model) {
      payload.model = model;
    }
    if (agent) {
      payload.agent = agent;
    }
    return this.requestJson(`/api/conversations/${conversationId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async abortSession(conversationId) {
    return this.requestJson(`/api/conversations/${conversationId}/sessions/abort`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  }

  async listSessionMessages(conversationId, sessionId) {
    return this.requestJson(
      `/api/conversations/${conversationId}/sessions/${encodeURIComponent(sessionId)}/messages`
    );
  }

  async deleteConversation(conversationId) {
    return this.request(`/api/conversations/${conversationId}`, {
      method: "DELETE",
    });
  }
}

module.exports = {
  AOClient,
};
