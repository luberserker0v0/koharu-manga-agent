const fs = require("fs");
const os = require("os");
const path = require("path");
const { TranslationDeepAuditModule } = require("../../backend/src/modules/translation_deep_audit");

describe("translation deep audit", () => {
  test("reuses completed checkpoints for the same final snapshot", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-audit-"));
    const finalPath = path.join(dir, "final.json");
    const memoryPath = path.join(dir, "memory.json");
    fs.writeFileSync(finalPath, JSON.stringify({ translations: [{ id: "n1", original: "a", translation: "b", pageName: "1" }], translationMemoryFingerprint: "m" }));
    fs.writeFileSync(memoryPath, JSON.stringify({ fingerprint: "m", effective: { glossary: [], story: null, style: null, localKnowledge: null } }));
    const runTranslationDeepAuditWindow = jest.fn().mockResolvedValue({ windowId: "quality_001", findings: [], proposals: [] });
    const module = new TranslationDeepAuditModule({ runTranslationDeepAuditWindow });
    const payload = { sourceTranslationJobId: `source_${Date.now()}`, finalTranslationSnapshotPath: finalPath, translationMemorySnapshotPath: memoryPath };
    const hooks = { jobId: "audit1", setStage: jest.fn(), emit: jest.fn(), isCanceled: jest.fn(() => false) };
    const first = await module.run(payload, hooks);
    const second = await module.run(payload, { ...hooks, jobId: "audit2" });
    expect(first.windowCount).toBe(1);
    expect(second.reusedWindows).toBe(1);
    expect(runTranslationDeepAuditWindow).toHaveBeenCalledTimes(1);
  });
});
