const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

class JobStore {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.initialize();
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        error_text TEXT,
        retry_of TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        execution_kind TEXT NOT NULL DEFAULT 'job',
        workflow_id TEXT,
        parent_job_id TEXT,
        dependency_ids_json TEXT NOT NULL DEFAULT '[]',
        lane_key TEXT,
        sequence_number INTEGER,
        blocked_reason TEXT
      );

      CREATE TABLE IF NOT EXISTS job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        error_text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge_revisions (
        id TEXT PRIMARY KEY,
        manga_id TEXT NOT NULL,
        translator_id TEXT,
        chapter_id TEXT NOT NULL,
        sequence_number INTEGER,
        workflow_id TEXT NOT NULL,
        reference_set_id TEXT,
        reference_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        before_snapshot_path TEXT NOT NULL,
        after_snapshot_path TEXT NOT NULL,
        analysis_artifact_path TEXT,
        payload_json TEXT NOT NULL,
        supersedes_revision_id TEXT,
        created_at TEXT NOT NULL,
        stale_at TEXT
      );
    `);

    const jobColumns = this.db.prepare(`PRAGMA table_info(jobs)`).all();
    const migrations = [
      ["deleted_at", "ALTER TABLE jobs ADD COLUMN deleted_at TEXT"],
      ["execution_kind", "ALTER TABLE jobs ADD COLUMN execution_kind TEXT NOT NULL DEFAULT 'job'"],
      ["workflow_id", "ALTER TABLE jobs ADD COLUMN workflow_id TEXT"],
      ["parent_job_id", "ALTER TABLE jobs ADD COLUMN parent_job_id TEXT"],
      ["dependency_ids_json", "ALTER TABLE jobs ADD COLUMN dependency_ids_json TEXT NOT NULL DEFAULT '[]'"],
      ["lane_key", "ALTER TABLE jobs ADD COLUMN lane_key TEXT"],
      ["sequence_number", "ALTER TABLE jobs ADD COLUMN sequence_number INTEGER"],
      ["blocked_reason", "ALTER TABLE jobs ADD COLUMN blocked_reason TEXT"],
    ];
    for (const [columnName, sql] of migrations) {
      if (!jobColumns.some((column) => column.name === columnName)) {
        this.db.exec(sql);
      }
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_jobs_workflow_id ON jobs(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_parent_job_id ON jobs(parent_job_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_lane_sequence ON jobs(lane_key, sequence_number);
      CREATE INDEX IF NOT EXISTS idx_knowledge_revisions_scope
        ON knowledge_revisions(manga_id, translator_id, sequence_number, created_at);
      CREATE INDEX IF NOT EXISTS idx_knowledge_revisions_workflow
        ON knowledge_revisions(workflow_id);
    `);
  }

  createJob({
    id,
    type,
    status,
    stage,
    payload,
    retryOf = null,
    executionKind = "job",
    workflowId = null,
    parentJobId = null,
    dependencyIds = [],
    laneKey = null,
    sequenceNumber = null,
    blockedReason = null,
  }) {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO jobs (
          id, type, status, stage, payload_json, retry_of, created_at, updated_at,
          execution_kind, workflow_id, parent_job_id, dependency_ids_json,
          lane_key, sequence_number, blocked_reason
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id, type, status, stage, JSON.stringify(payload), retryOf, now, now,
        executionKind, workflowId, parentJobId, JSON.stringify(dependencyIds || []),
        laneKey, sequenceNumber, blockedReason
      );
  }

  updateJob({ id, status, stage, result, error, blockedReason }) {
    const current = this.getJob(id);
    const nextStatus = status || current.status;
    const nextStage = stage || current.stage;
    const nextResult = result === undefined ? current.result : result;
    const nextError = error === undefined ? current.error : error;
    const nextBlockedReason = blockedReason === undefined ? current.blockedReason : blockedReason;

    this.db
      .prepare(`
        UPDATE jobs
        SET status = ?, stage = ?, result_json = ?, error_text = ?, blocked_reason = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        nextStatus,
        nextStage,
        nextResult == null ? null : JSON.stringify(nextResult),
        nextError || null,
        nextBlockedReason || null,
        new Date().toISOString(),
        id
      );
  }

  addEvent(jobId, eventType, payload, createdAt = new Date().toISOString()) {
    this.db
      .prepare(`
        INSERT INTO job_events (job_id, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(jobId, eventType, JSON.stringify(payload), createdAt);

    this.db
      .prepare(`
        UPDATE jobs
        SET updated_at = ?
        WHERE id = ?
      `)
      .run(createdAt, jobId);
  }

  addArtifact(jobId, kind, artifactPath, metadata) {
    this.db
      .prepare(`
        INSERT INTO job_artifacts (job_id, kind, path, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        jobId,
        kind,
        artifactPath,
        metadata == null ? null : JSON.stringify(metadata),
        new Date().toISOString()
      );
  }

  addError(jobId, stage, errorText) {
    this.db
      .prepare(`
        INSERT INTO job_errors (job_id, stage, error_text, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(jobId, stage, errorText, new Date().toISOString());
  }

  getJob(id) {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
    if (!row) {
      return null;
    }

    return this.mapJobRow(row);
  }

  mapJobRow(row) {
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      stage: row.stage,
      payload: JSON.parse(row.payload_json),
      result: row.result_json ? JSON.parse(row.result_json) : null,
      error: row.error_text,
      retryOf: row.retry_of,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      executionKind: row.execution_kind || "job",
      workflowId: row.workflow_id || null,
      parentJobId: row.parent_job_id || null,
      dependencyIds: row.dependency_ids_json ? JSON.parse(row.dependency_ids_json) : [],
      laneKey: row.lane_key || null,
      sequenceNumber: row.sequence_number == null ? null : row.sequence_number,
      blockedReason: row.blocked_reason || null,
    };
  }

  listJobs({ includeDeleted = false, onlyDeleted = false } = {}) {
    let statement;
    if (onlyDeleted) {
      statement = this.db.prepare(`SELECT * FROM jobs WHERE deleted_at IS NOT NULL ORDER BY created_at DESC, id DESC`);
    } else if (includeDeleted) {
      statement = this.db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC, id DESC`);
    } else {
      statement = this.db.prepare(`SELECT * FROM jobs WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC`);
    }

    return statement
      .all()
      .map((row) => this.mapJobRow(row));
  }

  listChildJobs(parentJobId) {
    return this.db
      .prepare(`SELECT * FROM jobs WHERE parent_job_id = ? ORDER BY sequence_number ASC, created_at ASC`)
      .all(parentJobId)
      .map((row) => this.mapJobRow(row));
  }

  createKnowledgeRevision(revision) {
    this.db.prepare(`
      INSERT INTO knowledge_revisions (
        id, manga_id, translator_id, chapter_id, sequence_number, workflow_id,
        reference_set_id, reference_kind, status, before_snapshot_path,
        after_snapshot_path, analysis_artifact_path, payload_json,
        supersedes_revision_id, created_at, stale_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      revision.id,
      revision.mangaId,
      revision.translatorId || null,
      revision.chapterId,
      revision.sequenceNumber ?? null,
      revision.workflowId,
      revision.referenceSetId || null,
      revision.referenceKind || "source",
      revision.status || "active",
      revision.beforeSnapshotPath,
      revision.afterSnapshotPath,
      revision.analysisArtifactPath || null,
      JSON.stringify(revision.payload || {}),
      revision.supersedesRevisionId || null,
      revision.createdAt || new Date().toISOString(),
      revision.staleAt || null
    );
    return this.getKnowledgeRevision(revision.id);
  }

  getKnowledgeRevision(revisionId) {
    const row = this.db.prepare(`SELECT * FROM knowledge_revisions WHERE id = ?`).get(revisionId);
    return row ? this.mapKnowledgeRevisionRow(row) : null;
  }

  listKnowledgeRevisions({ mangaId, translatorId = null, includeStale = true }) {
    const rows = translatorId
      ? this.db.prepare(`
          SELECT * FROM knowledge_revisions
          WHERE manga_id = ? AND translator_id = ?
          ORDER BY sequence_number ASC, created_at ASC
        `).all(mangaId, translatorId)
      : this.db.prepare(`
          SELECT * FROM knowledge_revisions
          WHERE manga_id = ? AND translator_id IS NULL
          ORDER BY sequence_number ASC, created_at ASC
        `).all(mangaId);
    return rows
      .map((row) => this.mapKnowledgeRevisionRow(row))
      .filter((revision) => includeStale || revision.status === "active");
  }

  markKnowledgeRevisionsStale(revisionIds, staleAt = new Date().toISOString()) {
    const update = this.db.prepare(`
      UPDATE knowledge_revisions SET status = 'stale', stale_at = ? WHERE id = ?
    `);
    for (const revisionId of revisionIds) {
      update.run(staleAt, revisionId);
    }
  }

  deleteKnowledgeRevisions({ mangaId, translatorId, allTranslators = false }) {
    if (allTranslators) {
      return this.db.prepare(`DELETE FROM knowledge_revisions WHERE manga_id = ?`).run(mangaId).changes;
    }
    if (translatorId == null) {
      return this.db.prepare(`
        DELETE FROM knowledge_revisions WHERE manga_id = ? AND translator_id IS NULL
      `).run(mangaId).changes;
    }
    return this.db.prepare(`
      DELETE FROM knowledge_revisions WHERE manga_id = ? AND translator_id = ?
    `).run(mangaId, translatorId).changes;
  }

  mapKnowledgeRevisionRow(row) {
    return {
      id: row.id,
      mangaId: row.manga_id,
      translatorId: row.translator_id,
      chapterId: row.chapter_id,
      sequenceNumber: row.sequence_number == null ? null : row.sequence_number,
      workflowId: row.workflow_id,
      referenceSetId: row.reference_set_id,
      referenceKind: row.reference_kind,
      status: row.status,
      beforeSnapshotPath: row.before_snapshot_path,
      afterSnapshotPath: row.after_snapshot_path,
      analysisArtifactPath: row.analysis_artifact_path,
      payload: JSON.parse(row.payload_json),
      supersedesRevisionId: row.supersedes_revision_id,
      createdAt: row.created_at,
      staleAt: row.stale_at,
    };
  }

  getEvents(jobId) {
    return this.db
      .prepare(`SELECT * FROM job_events WHERE job_id = ? ORDER BY id ASC`)
      .all(jobId)
      .map((row) => ({
        id: row.id,
        type: row.event_type,
        payload: JSON.parse(row.payload_json),
        createdAt: row.created_at,
      }));
  }

  getArtifacts(jobId) {
    return this.db
      .prepare(`SELECT * FROM job_artifacts WHERE job_id = ? ORDER BY id ASC`)
      .all(jobId)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        path: row.path,
        metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
        createdAt: row.created_at,
      }));
  }

  softDeleteJob(jobId) {
    const existing = this.getJob(jobId);
    if (!existing) {
      return null;
    }
    if (existing.deletedAt) {
      return existing;
    }

    const deletedAt = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE jobs
        SET deleted_at = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(deletedAt, deletedAt, jobId);
    return this.getJob(jobId);
  }

  restoreJob(jobId) {
    const existing = this.getJob(jobId);
    if (!existing) {
      return null;
    }
    if (!existing.deletedAt) {
      return existing;
    }

    this.db
      .prepare(`
        UPDATE jobs
        SET deleted_at = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(new Date().toISOString(), jobId);
    return this.getJob(jobId);
  }

  deleteJob(jobId) {
    const existing = this.getJob(jobId);
    if (!existing) {
      return null;
    }

    const deleteEvents = this.db.prepare(`DELETE FROM job_events WHERE job_id = ?`);
    const deleteArtifacts = this.db.prepare(`DELETE FROM job_artifacts WHERE job_id = ?`);
    const deleteErrors = this.db.prepare(`DELETE FROM job_errors WHERE job_id = ?`);
    const deleteJob = this.db.prepare(`DELETE FROM jobs WHERE id = ?`);

    try {
      this.db.exec("BEGIN");
      deleteEvents.run(jobId);
      deleteArtifacts.run(jobId);
      deleteErrors.run(jobId);
      deleteJob.run(jobId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return existing;
  }

  purgeDeletedBefore(cutoffIso) {
    const rows = this.db
      .prepare(`SELECT id FROM jobs WHERE deleted_at IS NOT NULL AND deleted_at < ?`)
      .all(cutoffIso);

    const purgedIds = [];
    for (const row of rows) {
      this.deleteJob(row.id);
      purgedIds.push(row.id);
    }
    return purgedIds;
  }
}

module.exports = {
  JobStore,
};
