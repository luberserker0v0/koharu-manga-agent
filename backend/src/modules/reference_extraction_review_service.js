const crypto = require("crypto");

const { config } = require("../config");
const {
  confirmExtractionReview,
  discardReviewDraft,
  ensureLegacyReviewMetadata,
  getReviewDocument,
  saveOrderDraft,
  saveReviewMetadata,
  syncDraftFromScene,
} = require("./reference_extraction_review");

class ReferenceExtractionReviewService {
  constructor({ client, jobManager, baseUrl = config.api.baseUrl }) {
    this.client = client;
    this.jobManager = jobManager;
    this.baseUrl = String(baseUrl || config.api.baseUrl).replace(/\/+$/, "");
    this.activeSession = null;
  }

  get(referenceSetId) {
    const metadata = ensureLegacyReviewMetadata(referenceSetId);
    const review = getReviewDocument(referenceSetId);
    if (
      review?.status === "editing" &&
      (!this.activeSession || this.activeSession.referenceSetId !== referenceSetId)
    ) {
      saveReviewMetadata(referenceSetId, {
        ...metadata,
        status: "awaiting_review",
        activeSessionId: null,
      });
      return getReviewDocument(referenceSetId);
    }
    return review;
  }

  async resolveProject(referenceSetId, metadata) {
    const projects = await this.client.listProjects(this.baseUrl);
    let project = metadata.projectId
      ? projects.find((entry) => entry.id === metadata.projectId)
      : null;
    if (!project && metadata.projectName) {
      project = projects.find((entry) => entry.name === metadata.projectName) || null;
    }
    if (!project) {
      const prefix = `reference_${referenceSetId}_`;
      project = projects
        .filter((entry) => String(entry.name || "").startsWith(prefix))
        .sort((left, right) => Number(right.updatedAtMs || 0) - Number(left.updatedAtMs || 0))[0] || null;
    }
    if (!project) {
      saveReviewMetadata(referenceSetId, { ...metadata, status: "project_missing", projectId: null });
      const error = new Error(`Koharu project for ${referenceSetId} was not found. Run Extraction again.`);
      error.statusCode = 409;
      throw error;
    }
    return project;
  }

  assertSession(referenceSetId, sessionId) {
    if (
      !this.activeSession ||
      this.activeSession.referenceSetId !== referenceSetId ||
      this.activeSession.sessionId !== sessionId
    ) {
      const error = new Error("Extraction review session is not active or no longer owns Koharu.");
      error.statusCode = 409;
      throw error;
    }
    return this.activeSession;
  }

  async start(referenceSetId) {
    const metadata = ensureLegacyReviewMetadata(referenceSetId);
    if (!metadata) {
      const error = new Error("Run Extraction before starting review.");
      error.statusCode = 409;
      throw error;
    }
    const sessionId = crypto.randomUUID();
    this.jobManager.acquireKoharuReviewLease({ sessionId, referenceSetId });
    try {
      const project = await this.resolveProject(referenceSetId, metadata);
      await this.client.openProject(project.id, this.baseUrl);
      this.activeSession = {
        sessionId,
        referenceSetId,
        projectId: project.id,
        previousStatus: metadata.status === "reviewed" ? "reviewed" : "awaiting_review",
        startedAt: new Date().toISOString(),
      };
      const next = saveReviewMetadata(referenceSetId, {
        ...metadata,
        status: "editing",
        projectId: project.id,
        projectName: project.name,
        activeSessionId: sessionId,
      });
      return {
        ...(getReviewDocument(referenceSetId) || next),
        sessionId,
        editorUrl: `${this.baseUrl}/`,
      };
    } catch (error) {
      this.jobManager.releaseKoharuReviewLease(sessionId);
      throw error;
    }
  }

  async sync(referenceSetId, sessionId) {
    this.assertSession(referenceSetId, sessionId);
    const scene = await this.client.getScene(this.baseUrl);
    syncDraftFromScene(referenceSetId, scene);
    return getReviewDocument(referenceSetId);
  }

  async finish(referenceSetId, sessionId) {
    this.assertSession(referenceSetId, sessionId);
    await this.sync(referenceSetId, sessionId);
    const synced = ensureLegacyReviewMetadata(referenceSetId);
    const next = saveReviewMetadata(referenceSetId, {
      ...synced,
      status: "awaiting_order_review",
      activeSessionId: null,
      editorFinishedAt: new Date().toISOString(),
    });
    try {
      await this.client.closeCurrentProject(this.baseUrl);
    } finally {
      this.activeSession = null;
      this.jobManager.releaseKoharuReviewLease(sessionId);
    }
    return getReviewDocument(referenceSetId) || next;
  }

  async cancel(referenceSetId, sessionId) {
    const session = this.assertSession(referenceSetId, sessionId);
    const next = discardReviewDraft(referenceSetId, session.previousStatus);
    try {
      await this.client.closeCurrentProject(this.baseUrl);
    } finally {
      this.activeSession = null;
      this.jobManager.releaseKoharuReviewLease(sessionId);
    }
    return getReviewDocument(referenceSetId) || next;
  }

  saveOrder(referenceSetId, pages) {
    const next = saveOrderDraft(referenceSetId, pages);
    return getReviewDocument(referenceSetId) || next;
  }

  confirm(referenceSetId) {
    const next = confirmExtractionReview(referenceSetId);
    return getReviewDocument(referenceSetId) || next;
  }
}

module.exports = { ReferenceExtractionReviewService };
