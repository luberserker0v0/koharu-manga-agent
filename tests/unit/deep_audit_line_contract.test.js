const { parseDeepAuditWindowOutput } = require("../../backend/src/integrations/ao/contracts/deep_audit_line_contract");

describe("deep audit line contract", () => {
  const input = { windowId: "quality_001", candidates: [{ nodeId: "n1", pageName: "1", original: "a", currentTranslation: "b" }] };
  test("reports unobserved nodes without failing the audit", () => {
    const partial = parseDeepAuditWindowOutput("WINDOW_DONE|quality_001", input);
    expect(partial.unobservedNodeIds).toEqual(["n1"]);
    expect(partial.semanticResult.outcome).toBe("partial");
    expect(parseDeepAuditWindowOutput("AUDIT_KEEP|n1|acceptable\nWINDOW_DONE|quality_001", input).proposals).toEqual([]);
  });
});
