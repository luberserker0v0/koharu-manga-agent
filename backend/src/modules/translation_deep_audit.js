const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { paths } = require("../config");
const { buildQualityContextProjection, buildQualityWindowInput } = require("./quality_projection");

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function contractHash() {
  return hash([
    fs.readFileSync(path.join(__dirname, "..", "deep_audit_line_contract.js"), "utf8"),
    fs.readFileSync(path.join(__dirname, "..", "..", "ao", "skills", "translation-deep-audit-contract", "SKILL.md"), "utf8"),
    fs.readFileSync(path.join(__dirname, "..", "..", "ao", "agents", "quality-optimizer.md"), "utf8"),
  ].join("\n---\n"));
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, filePath);
}

class TranslationDeepAuditModule {
  constructor(aoTaskRunner) {
    this.aoTaskRunner = aoTaskRunner;
  }

  async run(payload, hooks) {
    const snapshotText = fs.readFileSync(payload.finalTranslationSnapshotPath, "utf8");
    const snapshot = JSON.parse(snapshotText);
    const memory = payload.translationMemorySnapshotPath
      ? JSON.parse(fs.readFileSync(payload.translationMemorySnapshotPath, "utf8"))
      : { fingerprint: snapshot.translationMemoryFingerprint, effective: {} };
    const snapshotFingerprint = hash(snapshotText);
    const auditContractHash = contractHash();
    const model = this.aoTaskRunner.settings?.model || null;
    const projection = buildQualityContextProjection({
      translations: snapshot.translations,
      translationMemory: memory,
      includeAll: true,
      representativeLimit: 0,
    });
    const planHash = hash(JSON.stringify({ snapshotFingerprint, projectionFingerprint: projection.fingerprint, auditContractHash, model }));
    const runRoot = path.join(paths.workspaceRoot, payload.sourceTranslationJobId, "deep_audit", planHash);
    const results = [];
    let reusedWindows = 0;
    for (let index = 0; index < projection.windows.length; index += 1) {
      const window = projection.windows[index];
      const checkpointPath = path.join(runRoot, "checkpoints", `${window.windowId}.json`);
      let checkpoint = null;
      let reused = false;
      if (fs.existsSync(checkpointPath)) {
        const existing = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
        if (existing.planHash === planHash) {
          checkpoint = existing;
          reusedWindows += 1;
          reused = true;
        }
      }
      if (!checkpoint) {
        hooks.setStage("running", `deep_audit_${index + 1}_of_${projection.windows.length}`);
        const input = {
          ...buildQualityWindowInput(projection, window),
          jobId: hooks.jobId,
          snapshotFingerprint,
        };
        const startedAt = Date.now();
        const result = await this.aoTaskRunner.runTranslationDeepAuditWindow(input, {
          isCanceled: hooks.isCanceled,
        });
        checkpoint = {
          schemaVersion: 1,
          snapshotFingerprint,
          projectionFingerprint: projection.fingerprint,
          auditContractHash,
          model,
          planHash,
          windowId: window.windowId,
          inputBytes: window.inputBytes,
          elapsedMs: Date.now() - startedAt,
          completedAt: new Date().toISOString(),
          result,
        };
        writeJsonAtomic(checkpointPath, checkpoint);
      }
      results.push(checkpoint.result);
      hooks.emit("deep_audit.window.completed", {
        completedWindows: index + 1,
        totalWindows: projection.windows.length,
        reusedWindows,
        reused,
        windowId: window.windowId,
        checkpointPath,
      });
    }
    const report = {
      schemaVersion: 1,
      sourceTranslationJobId: payload.sourceTranslationJobId,
      snapshotFingerprint,
      projectionFingerprint: projection.fingerprint,
      auditContractHash,
      model,
      planHash,
      generatedAt: new Date().toISOString(),
      totalTranslations: snapshot.translations.length,
      windowCount: projection.windows.length,
      reusedWindows,
      findings: results.flatMap((entry) => entry.findings || []),
      proposedTranslations: results.flatMap((entry) => entry.proposals || []),
    };
    const reportPath = path.join(runRoot, "translation_deep_audit_report.json");
    writeJsonAtomic(reportPath, report);
    const findingById = new Map(report.findings.map((entry) => [entry.nodeId, entry]));
    const proposalById = new Map(report.proposedTranslations.map((entry) => [entry.nodeId, entry]));
    const reviewNodeIds = new Set([...findingById.keys(), ...proposalById.keys()]);
    const pages = new Map();
    for (const translation of snapshot.translations || []) {
      const nodeId = translation.id || translation.nodeId;
      if (!reviewNodeIds.has(nodeId)) continue;
      const finding = findingById.get(nodeId);
      const proposal = proposalById.get(nodeId);
      const pageName = translation.pageName || proposal?.pageName || "unknown";
      const page = pages.get(pageName) || { pageId: translation.pageId || null, pageName, items: [], sequenceRisks: [] };
      page.items.push({
        nodeId,
        original: translation.original,
        currentTranslation: translation.translation,
        proposedTranslation: proposal?.revisedTranslation || null,
        riskTypes: [finding?.type || proposal?.reasonType || "translation_accuracy"],
        confidence: finding?.confidence ?? proposal?.confidence ?? null,
        reason: finding?.message || proposal?.reason || null,
        bbox: translation.bbox || null,
        blocking: false,
        allowedDecisions: ["accept_proposal", "manual_edit", "confirm_current", "ignore_and_publish"],
      });
      pages.set(pageName, page);
    }
    const reviewPackage = {
      schemaVersion: 1,
      source: "translation_deep_audit",
      status: "waiting_user_review",
      generatedAt: new Date().toISOString(),
      pages: [...pages.values()],
      summary: { blocking: 0, warnings: report.findings.length, pages: pages.size },
    };
    const qualityReviewPackagePath = path.join(runRoot, "quality_review_package.json");
    writeJsonAtomic(qualityReviewPackagePath, reviewPackage);
    return { ...report, reportPath, qualityReviewPackagePath };
  }
}

module.exports = { TranslationDeepAuditModule };
