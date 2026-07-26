const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createZipBuffer,
  ensureAoAssetFolders,
  listAgentFiles,
  listSkillArchives,
} = require("../../backend/src/ao_assets");

describe("ao assets", () => {
  test("ensureAoAssetFolders creates required directories", () => {
    expect(() => ensureAoAssetFolders()).not.toThrow();
  });

  test("createZipBuffer produces a non-empty archive for skill files", () => {
    const zip = createZipBuffer([
      { name: "SKILL.md", content: "# skill" },
      { name: "references/schema.json", content: "{}" },
    ]);

    expect(Buffer.isBuffer(zip)).toBe(true);
    expect(zip.length).toBeGreaterThan(50);
    expect(zip.slice(0, 4).toString("hex")).toBe("504b0304");
  });

  test("listAgentFiles strips markdown extensions for AO upload names", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ao-agents-"));
    fs.writeFileSync(path.join(tempRoot, "quality-optimizer.md"), "# quality");
    fs.writeFileSync(path.join(tempRoot, "knowledge-builder.md"), "# knowledge");

    const files = listAgentFiles(tempRoot);

    expect(files).toEqual([
      expect.objectContaining({ name: "knowledge-builder" }),
      expect.objectContaining({ name: "quality-optimizer" }),
    ]);
  });

  test("listSkillArchives ignores empty removed-skill directories", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ao-skills-"));
    fs.mkdirSync(path.join(tempRoot, "removed-skill"));
    fs.mkdirSync(path.join(tempRoot, "active-skill"));
    fs.writeFileSync(path.join(tempRoot, "active-skill", "SKILL.md"), "# active");

    const skills = listSkillArchives(tempRoot);

    expect(skills.map((skill) => skill.name)).toEqual(["active-skill"]);
  });

  test("listSkillArchives still rejects non-empty malformed skills", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ao-skills-"));
    fs.mkdirSync(path.join(tempRoot, "broken-skill"));
    fs.writeFileSync(path.join(tempRoot, "broken-skill", "notes.md"), "missing contract");

    expect(() => listSkillArchives(tempRoot)).toThrow(
      "AO skill broken-skill must contain SKILL.md at the root."
    );
  });
});
