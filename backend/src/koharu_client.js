const fs = require("fs");
const path = require("path");
const { config } = require("./config");

const ENDPOINTS = {
  PROJECTS: "/api/v1/projects",
  PROJECTS_CURRENT: "/api/v1/projects/current",
  SCENE: "/api/v1/scene.json",
  PAGES: "/api/v1/pages",
  PAGES_FROM_PATHS: "/api/v1/pages/from-paths",
  LLM_CURRENT: "/api/v1/llm/current",
  LLM_CATALOG: "/api/v1/llm/catalog",
  ENGINES: "/api/v1/engines",
  PIPELINES: "/api/v1/pipelines",
  OPERATIONS: "/api/v1/operations",
  EVENTS: "/api/v1/events",
  EXPORT: "/api/v1/projects/current/export",
  HISTORY_APPLY: "/api/v1/history/apply",
};

function buildUrl(endpoint, baseUrl = config.api.baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, "")}${endpoint}`;
}

async function apiFetch(endpoint, opts = {}) {
  const { baseUrl, body, headers, ...rest } = opts;
  const finalHeaders = { "Content-Type": "application/json", ...(headers || {}) };
  const finalOpts = { ...rest, headers: finalHeaders };

  if (body !== undefined) {
    finalOpts.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  return fetch(buildUrl(endpoint, baseUrl), finalOpts);
}

async function readTextSafe(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

async function ensureJson(res, label) {
  if (!res.ok) {
    const text = await readTextSafe(res);
    throw new Error(`${label} failed (${res.status}): ${text}`);
  }

  return res.json();
}

class KoharuClient {
  constructor(defaultBaseUrl = config.api.baseUrl) {
    this.defaultBaseUrl = defaultBaseUrl;
  }

  resolveBaseUrl(baseUrl) {
    return (baseUrl || this.defaultBaseUrl).replace(/\/+$/, "");
  }

  async getScene(baseUrl) {
    const res = await apiFetch(ENDPOINTS.SCENE, { baseUrl: this.resolveBaseUrl(baseUrl) });
    return ensureJson(res, "Read scene");
  }

  async getEngines(baseUrl) {
    const res = await apiFetch(ENDPOINTS.ENGINES, { baseUrl: this.resolveBaseUrl(baseUrl) });
    return ensureJson(res, "Fetch engines");
  }

  async createProject(name, baseUrl) {
    const res = await apiFetch(ENDPOINTS.PROJECTS, {
      method: "POST",
      baseUrl: this.resolveBaseUrl(baseUrl),
      body: { name },
    });
    return ensureJson(res, "Create project");
  }

  async openProject(projectId, baseUrl) {
    const res = await apiFetch(ENDPOINTS.PROJECTS_CURRENT, {
      method: "PUT",
      baseUrl: this.resolveBaseUrl(baseUrl),
      body: { id: projectId },
    });
    return ensureJson(res, "Open project");
  }

  async listOperations(baseUrl) {
    const res = await apiFetch(ENDPOINTS.OPERATIONS, {
      baseUrl: this.resolveBaseUrl(baseUrl),
    });
    const data = await ensureJson(res, "List operations");
    return data.operations || [];
  }

  async startPipeline({ steps, targetLanguage, pages, systemPrompt, defaultFont, baseUrl }) {
    const body = { steps };
    if (targetLanguage) body.targetLanguage = targetLanguage;
    if (pages && pages.length > 0) body.pages = pages;
    if (systemPrompt) body.systemPrompt = systemPrompt;
    if (defaultFont) body.defaultFont = defaultFont;

    const res = await apiFetch(ENDPOINTS.PIPELINES, {
      method: "POST",
      baseUrl: this.resolveBaseUrl(baseUrl),
      body,
    });
    const data = await ensureJson(res, "Start pipeline");
    return data.operationId || data.id;
  }

  async exportCurrentProject({ format, pages, outputDir, baseUrl }) {
    const body = { format };
    if (pages && pages.length > 0) {
      body.pages = pages;
    }

    const res = await apiFetch(ENDPOINTS.EXPORT, {
      method: "POST",
      baseUrl: this.resolveBaseUrl(baseUrl),
      body,
    });

    if (!res.ok) {
      const text = await readTextSafe(res);
      throw new Error(`Export failed (${res.status}): ${text}`);
    }

    const targetDir = path.resolve(outputDir);
    fs.mkdirSync(targetDir, { recursive: true });

    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") || "";
    const ext = format === "khr"
      ? "khr"
      : contentType.includes("image/png")
        ? "png"
        : contentType.includes("image/")
          ? "jpg"
          : "zip";
    const filePath = path.join(targetDir, `export_${Date.now()}.${ext}`);
    fs.writeFileSync(filePath, buffer);

    return {
      path: filePath,
      size: buffer.length,
      format,
    };
  }

  async applyHistoryBatch({ ops, label = "post_edit_apply", baseUrl }) {
    const res = await apiFetch(ENDPOINTS.HISTORY_APPLY, {
      method: "POST",
      baseUrl: this.resolveBaseUrl(baseUrl),
      body: {
        batch: {
          ops,
          label,
        },
      },
    });
    return ensureJson(res, "Apply history batch");
  }

  async closeCurrentProject(baseUrl) {
    const res = await apiFetch(ENDPOINTS.PROJECTS_CURRENT, {
      method: "DELETE",
      baseUrl: this.resolveBaseUrl(baseUrl),
    });

    if (!res.ok && res.status !== 204) {
      const text = await readTextSafe(res);
      throw new Error(`Close project failed (${res.status}): ${text}`);
    }

    return { success: true };
  }

  async listProjects(baseUrl) {
    const res = await apiFetch(ENDPOINTS.PROJECTS, {
      baseUrl: this.resolveBaseUrl(baseUrl),
    });
    const data = await ensureJson(res, "List projects");
    return data.projects || [];
  }
}

module.exports = {
  ENDPOINTS,
  KoharuClient,
  apiFetch,
  buildUrl,
};
