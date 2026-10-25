const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

function jobCreationValues(input, now) {
  const params = {
    retryOf: null, executionKind: "job", workflowId: null, parentJobId: null,
    dependencyIds: [], laneKey: null, sequenceNumber: null, blockedReason: null,
    ...input,
  };
  return [
    params.id, params.type, params.status, params.stage, JSON.stringify(params.payload),
    params.retryOf, now, now, params.executionKind, params.workflowId, params.parentJobId,
    JSON.stringify(params.dependencyIds || []), params.laneKey, params.sequenceNumber, params.blockedReason,
  ];
}

function jobUpdateValues(current, input) {
  const value = (field) => input[field] === undefined ? current[field] : input[field];
  return {
    status: input.status || current.status,
    stage: input.stage || current.stage,
    result: value("result"),
    error: value("error"),
    blockedReason: value("blockedReason"),
    outcome: value("outcome"),
    diagnostics: value("diagnostics"),
    resumeMetadata: value("resumeMetadata"),
  };
}

function knowledgeRevisionValues(revision) {
  return [
    revision.id, revision.mangaId, revision.translatorId || null, revision.chapterId,
    revision.sequenceNumber ?? null, revision.workflowId, revision.referenceSetId || null,
    revision.referenceKind || "source", revision.status || "active", revision.beforeSnapshotPath,
    revision.afterSnapshotPath, revision.analysisArtifactPath || null, JSON.stringify(revision.payload || {}),
    revision.supersedesRevisionId || null, revision.createdAt || new Date().toISOString(), revision.staleAt || null,
  ];
}

function knowledgeRevisionDeleteQuery(input) {
  const { mangaId, translatorId, chapterId = null, allTranslators = false } = input;
  if (chapterId && allTranslators)
    return { sql: "DELETE FROM knowledge_revisions WHERE manga_id = ? AND chapter_id = ?", args: [mangaId, chapterId] };
  if (chapterId && translatorId == null)
    return { sql: "DELETE FROM knowledge_revisions WHERE manga_id = ? AND translator_id IS NULL AND chapter_id = ?", args: [mangaId, chapterId] };
  if (chapterId)
    return { sql: "DELETE FROM knowledge_revisions WHERE manga_id = ? AND translator_id = ? AND chapter_id = ?", args: [mangaId, translatorId, chapterId] };
  if (allTranslators)
    return { sql: "DELETE FROM knowledge_revisions WHERE manga_id = ?", args: [mangaId] };
  if (translatorId == null)
    return { sql: "DELETE FROM knowledge_revisions WHERE manga_id = ? AND translator_id IS NULL", args: [mangaId] };
  return { sql: "DELETE FROM knowledge_revisions WHERE manga_id = ? AND translator_id = ?", args: [mangaId, translatorId] };
}

class JobStore {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.initialize();
  }

  initialize() {
    this.createSchema();
    this.migrateJobColumns();
    this.createIndexes();
  }

  createSchema() {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL, payload_json TEXT NOT NULL, result_json TEXT, error_text TEXT, retry_of TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, execution_kind TEXT NOT NULL DEFAULT 'job', workflow_id TEXT, parent_job_id TEXT, dependency_ids_json TEXT NOT NULL DEFAULT '[]', lane_key TEXT, sequence_number INTEGER, blocked_reason TEXT, outcome TEXT, diagnostics_json TEXT, resume_metadata_json TEXT);",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS job_events (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS job_artifacts (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, metadata_json TEXT, created_at TEXT NOT NULL);",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS job_errors (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, stage TEXT NOT NULL, error_text TEXT NOT NULL, created_at TEXT NOT NULL);",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS knowledge_revisions (id TEXT PRIMARY KEY, manga_id TEXT NOT NULL, translator_id TEXT, chapter_id TEXT NOT NULL, sequence_number INTEGER, workflow_id TEXT NOT NULL, reference_set_id TEXT, reference_kind TEXT NOT NULL, status TEXT NOT NULL, before_snapshot_path TEXT NOT NULL, after_snapshot_path TEXT NOT NULL, analysis_artifact_path TEXT, payload_json TEXT NOT NULL, supersedes_revision_id TEXT, created_at TEXT NOT NULL, stale_at TEXT);",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS translation_page_revisions (revision_id TEXT PRIMARY KEY, root_job_id TEXT NOT NULL, parent_job_id TEXT, job_id TEXT NOT NULL, source_preflight_id TEXT NOT NULL, source_image_id TEXT NOT NULL, source_order_index INTEGER NOT NULL, job_image_id TEXT NOT NULL, job_image_index INTEGER NOT NULL, file_name TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL, revision_number INTEGER NOT NULL, translation_target_json TEXT, source_language TEXT, target_language TEXT, instructions TEXT, created_at TEXT NOT NULL, UNIQUE(root_job_id, source_image_id, revision_number), UNIQUE(job_id, source_image_id));",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS translation_page_active_revisions (root_job_id TEXT NOT NULL, source_image_id TEXT NOT NULL, revision_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(root_job_id, source_image_id));",
    );
  }

  migrateJobColumns() {
    const jobColumns = this.db.prepare("PRAGMA table_info(jobs)").all();
    const migrations = [
      ["deleted_at", "ALTER TABLE jobs ADD COLUMN deleted_at TEXT"],
      ["execution_kind", "ALTER TABLE jobs ADD COLUMN execution_kind TEXT NOT NULL DEFAULT 'job'"],
      ["workflow_id", "ALTER TABLE jobs ADD COLUMN workflow_id TEXT"],
      ["parent_job_id", "ALTER TABLE jobs ADD COLUMN parent_job_id TEXT"],
      ["dependency_ids_json", "ALTER TABLE jobs ADD COLUMN dependency_ids_json TEXT NOT NULL DEFAULT '[]'"],
      ["lane_key", "ALTER TABLE jobs ADD COLUMN lane_key TEXT"],
      ["sequence_number", "ALTER TABLE jobs ADD COLUMN sequence_number INTEGER"],
      ["blocked_reason", "ALTER TABLE jobs ADD COLUMN blocked_reason TEXT"],
      ["outcome", "ALTER TABLE jobs ADD COLUMN outcome TEXT"],
      ["diagnostics_json", "ALTER TABLE jobs ADD COLUMN diagnostics_json TEXT"],
      ["resume_metadata_json", "ALTER TABLE jobs ADD COLUMN resume_metadata_json TEXT"],
    ];
    for (const [columnName, sql] of migrations) {
      if (!jobColumns.some((column) => column.name === columnName)) {
        this.db.exec(sql);
      }
    }
  }

  createIndexes() {
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_workflow_id ON jobs(workflow_id);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_parent_job_id ON jobs(parent_job_id);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_lane_sequence ON jobs(lane_key, sequence_number);");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_knowledge_revisions_scope ON knowledge_revisions(manga_id, translator_id, sequence_number, created_at);",
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_knowledge_revisions_workflow ON knowledge_revisions(workflow_id);");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_translation_page_revisions_root ON translation_page_revisions(root_job_id, source_order_index, revision_number);",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_translation_page_revisions_job ON translation_page_revisions(job_id);",
    );
  }

  createJob(input) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO jobs (
          id, type, status, stage, payload_json, retry_of, created_at, updated_at,
          execution_kind, workflow_id, parent_job_id, dependency_ids_json,
          lane_key, sequence_number, blocked_reason
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(...jobCreationValues(input, now));
  }

  updateJob(input) {
    const next = jobUpdateValues(this.getJob(input.id), input);
    this.db
      .prepare(
        `
        UPDATE jobs
        SET status = ?, stage = ?, result_json = ?, error_text = ?, blocked_reason = ?,
            outcome = ?, diagnostics_json = ?, resume_metadata_json = ?, updated_at = ?
        WHERE id = ?
      `,
      )
      .run(
        next.status,
        next.stage,
        next.result == null ? null : JSON.stringify(next.result),
        next.error || null,
        next.blockedReason || null,
        next.outcome || null,
        next.diagnostics == null ? null : JSON.stringify(next.diagnostics),
        next.resumeMetadata == null ? null : JSON.stringify(next.resumeMetadata),
        new Date().toISOString(),
        input.id,
      );
  }

  addEvent(jobId, eventType, payload, createdAt = new Date().toISOString()) {
    this.db
      .prepare(
        `
        INSERT INTO job_events (job_id, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?)
      `,
      )
      .run(jobId, eventType, JSON.stringify(payload), createdAt);

    this.db
      .prepare(
        `
        UPDATE jobs
        SET updated_at = ?
        WHERE id = ?
      `,
      )
      .run(createdAt, jobId);
  }

  addArtifact(jobId, kind, artifactPath, metadata) {
    this.db
      .prepare(
        `
        INSERT INTO job_artifacts (job_id, kind, path, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      )
      .run(jobId, kind, artifactPath, metadata == null ? null : JSON.stringify(metadata), new Date().toISOString());
  }

  addError(jobId, stage, errorText) {
    this.db
      .prepare(
        `
        INSERT INTO job_errors (job_id, stage, error_text, created_at)
        VALUES (?, ?, ?, ?)
      `,
      )
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
    const payload = JSON.parse(row.payload_json);
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      stage: row.stage,
      payload,
      revision: payload?.revision || null,
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
      outcome: row.outcome || null,
      diagnostics: row.diagnostics_json ? JSON.parse(row.diagnostics_json) : null,
      resumeMetadata: row.resume_metadata_json ? JSON.parse(row.resume_metadata_json) : null,
    };
  }

  upsertTranslationPageRevision(revision) {
    this.db
      .prepare(
        "INSERT INTO translation_page_revisions (revision_id, root_job_id, parent_job_id, job_id, source_preflight_id, source_image_id, source_order_index, job_image_id, job_image_index, file_name, media_type, size, revision_number, translation_target_json, source_language, target_language, instructions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(revision_id) DO NOTHING",
      )
      .run(
        revision.revisionId,
        revision.rootJobId,
        revision.parentJobId || null,
        revision.jobId,
        revision.sourcePreflightId,
        revision.sourceImageId,
        revision.sourceOrderIndex,
        revision.jobImageId,
        revision.jobImageIndex,
        revision.fileName,
        revision.mediaType,
        revision.size,
        revision.revisionNumber,
        revision.translationTarget == null ? null : JSON.stringify(revision.translationTarget),
        revision.sourceLanguage || null,
        revision.targetLanguage || null,
        revision.instructions || null,
        revision.createdAt || new Date().toISOString(),
      );
    return this.getTranslationPageRevision(revision.revisionId);
  }

  mapTranslationPageRevisionRow(row) {
    return {
      revisionId: row.revision_id,
      rootJobId: row.root_job_id,
      parentJobId: row.parent_job_id,
      jobId: row.job_id,
      sourcePreflightId: row.source_preflight_id,
      sourceImageId: row.source_image_id,
      sourceOrderIndex: row.source_order_index,
      jobImageId: row.job_image_id,
      jobImageIndex: row.job_image_index,
      fileName: row.file_name,
      mediaType: row.media_type,
      size: row.size,
      revisionNumber: row.revision_number,
      translationTarget: row.translation_target_json ? JSON.parse(row.translation_target_json) : null,
      sourceLanguage: row.source_language,
      targetLanguage: row.target_language,
      instructions: row.instructions,
      createdAt: row.created_at,
    };
  }

  getTranslationPageRevision(revisionId) {
    const row = this.db
      .prepare(
        `
      SELECT * FROM translation_page_revisions WHERE revision_id = ?
    `,
      )
      .get(revisionId);
    return row ? this.mapTranslationPageRevisionRow(row) : null;
  }

  listTranslationPageRevisions(rootJobId) {
    return this.db
      .prepare(
        `
      SELECT * FROM translation_page_revisions
      WHERE root_job_id = ?
      ORDER BY source_order_index ASC, revision_number ASC, created_at ASC
    `,
      )
      .all(rootJobId)
      .map((row) => this.mapTranslationPageRevisionRow(row));
  }

  listActiveTranslationPageRevisions(rootJobId) {
    return this.db
      .prepare(
        `
      SELECT root_job_id, source_image_id, revision_id, updated_at
      FROM translation_page_active_revisions
      WHERE root_job_id = ?
      ORDER BY source_image_id ASC
    `,
      )
      .all(rootJobId)
      .map((row) => ({
        rootJobId: row.root_job_id,
        sourceImageId: row.source_image_id,
        revisionId: row.revision_id,
        updatedAt: row.updated_at,
      }));
  }

  activateTranslationPageRevisions(rootJobId, selections) {
    const validated = this.validatePageRevisionSelections(rootJobId, selections);
    const update = this.db.prepare(
      "INSERT INTO translation_page_active_revisions (root_job_id, source_image_id, revision_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(root_job_id, source_image_id) DO UPDATE SET revision_id = excluded.revision_id, updated_at = excluded.updated_at",
    );
    const now = new Date().toISOString();
    try {
      this.db.exec("BEGIN");
      for (const selection of validated) {
        update.run(rootJobId, selection.sourceImageId, selection.revisionId, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listActiveTranslationPageRevisions(rootJobId);
  }

  validatePageRevisionSelections(rootJobId, selections) {
    const lookup = this.db.prepare(
      "SELECT revision_id, root_job_id, source_image_id FROM translation_page_revisions WHERE revision_id = ?",
    );
    return selections.map((selection) => {
      const row = lookup.get(selection.revisionId);
      if (!row || row.root_job_id !== rootJobId || row.source_image_id !== selection.sourceImageId) {
        const error = new Error(
          `Revision ${selection.revisionId} does not belong to source image ${selection.sourceImageId} in root Job ${rootJobId}.`,
        );
        error.statusCode = 409;
        error.code = "page_revision_mismatch";
        throw error;
      }
      return selection;
    });
  }

  initializeActiveTranslationPageRevision(rootJobId, sourceImageId, revisionId, updatedAt = new Date().toISOString()) {
    this.db
      .prepare(
        `
      INSERT INTO translation_page_active_revisions (
        root_job_id, source_image_id, revision_id, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(root_job_id, source_image_id) DO NOTHING
    `,
      )
      .run(rootJobId, sourceImageId, revisionId, updatedAt);
  }

  registerTranslationPageRevisions(revisions, { initializeActive = false } = {}) {
    try {
      this.db.exec("BEGIN");
      const registered = revisions.map((revision) => {
        const entry = this.upsertTranslationPageRevision(revision);
        if (initializeActive) {
          this.initializeActiveTranslationPageRevision(
            revision.rootJobId,
            revision.sourceImageId,
            revision.revisionId,
            revision.createdAt,
          );
        }
        return entry;
      });
      this.db.exec("COMMIT");
      return registered;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteTranslationPageRevisionsForJob(jobId) {
    try {
      this.db.exec("BEGIN");
      this.db
        .prepare(
          `
        DELETE FROM translation_page_active_revisions
        WHERE revision_id IN (
          SELECT revision_id FROM translation_page_revisions WHERE job_id = ?
        )
      `,
        )
        .run(jobId);
      const changes = this.db
        .prepare(
          `
        DELETE FROM translation_page_revisions WHERE job_id = ?
      `,
        )
        .run(jobId).changes;
      this.db.exec("COMMIT");
      return changes;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

    return statement.all().map((row) => this.mapJobRow(row));
  }

  listChildJobs(parentJobId) {
    return this.db
      .prepare(`SELECT * FROM jobs WHERE parent_job_id = ? ORDER BY sequence_number ASC, created_at ASC`)
      .all(parentJobId)
      .map((row) => this.mapJobRow(row));
  }

  createKnowledgeRevision(revision) {
    this.db
      .prepare(
        `
      INSERT INTO knowledge_revisions (
        id, manga_id, translator_id, chapter_id, sequence_number, workflow_id,
        reference_set_id, reference_kind, status, before_snapshot_path,
        after_snapshot_path, analysis_artifact_path, payload_json,
        supersedes_revision_id, created_at, stale_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(...knowledgeRevisionValues(revision));
    return this.getKnowledgeRevision(revision.id);
  }

  getKnowledgeRevision(revisionId) {
    const row = this.db.prepare(`SELECT * FROM knowledge_revisions WHERE id = ?`).get(revisionId);
    return row ? this.mapKnowledgeRevisionRow(row) : null;
  }

  listKnowledgeRevisions({ mangaId, translatorId = null, includeStale = true }) {
    const rows = translatorId
      ? this.db
          .prepare(
            `
          SELECT * FROM knowledge_revisions
          WHERE manga_id = ? AND translator_id = ?
          ORDER BY sequence_number ASC, created_at ASC
        `,
          )
          .all(mangaId, translatorId)
      : this.db
          .prepare(
            `
          SELECT * FROM knowledge_revisions
          WHERE manga_id = ? AND translator_id IS NULL
          ORDER BY sequence_number ASC, created_at ASC
        `,
          )
          .all(mangaId);
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

  deleteKnowledgeRevisions(input) {
    const query = knowledgeRevisionDeleteQuery(input);
    return this.db.prepare(query.sql).run(...query.args).changes;
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
      .prepare(
        `
        UPDATE jobs
        SET deleted_at = ?, updated_at = ?
        WHERE id = ?
      `,
      )
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
      .prepare(
        `
        UPDATE jobs
        SET deleted_at = NULL, updated_at = ?
        WHERE id = ?
      `,
      )
      .run(new Date().toISOString(), jobId);
    return this.getJob(jobId);
  }

  deleteJob(jobId) {
    const existing = this.getJob(jobId);
    if (!existing) {
      return null;
    }
    this.deleteJobRows(jobId);
    return existing;
  }

  deleteJobRows(jobId) {
    try {
      this.db.exec("BEGIN");
      this.db.prepare("DELETE FROM job_events WHERE job_id = ?").run(jobId);
      this.db.prepare("DELETE FROM job_artifacts WHERE job_id = ?").run(jobId);
      this.db.prepare("DELETE FROM job_errors WHERE job_id = ?").run(jobId);
      this.db
        .prepare(
          "DELETE FROM translation_page_active_revisions WHERE revision_id IN (SELECT revision_id FROM translation_page_revisions WHERE job_id = ?)",
        )
        .run(jobId);
      this.db.prepare("DELETE FROM translation_page_revisions WHERE job_id = ?").run(jobId);
      this.db.prepare("DELETE FROM translation_page_active_revisions WHERE root_job_id = ?").run(jobId);
      this.db.prepare("DELETE FROM translation_page_revisions WHERE root_job_id = ?").run(jobId);
      this.db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  purgeDeletedBefore(cutoffIso) {
    const rows = this.db.prepare(`SELECT id FROM jobs WHERE deleted_at IS NOT NULL AND deleted_at < ?`).all(cutoffIso);

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
