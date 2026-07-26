const { parseDeepAuditWindowOutput } = require("../../backend/src/deep_audit_line_contract");

describe("deep audit line contract", () => {
  const input = { windowId: "quality_001", candidates: [{ nodeId: "n1", pageName: "1", original: "a", currentTranslation: "b" }] };
  test("requires a disposition for every node", () => {
    expect(() => parseDeepAuditWindowOutput("WINDOW_DONE|quality_001", input)).toThrow(/omitted node/);
    expect(parseDeepAuditWindowOutput("AUDIT_KEEP|n1|acceptable\nWINDOW_DONE|quality_001", input).proposals).toEqual([]);
  });
});
