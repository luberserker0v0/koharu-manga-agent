const fs = require("fs");
const os = require("os");
const path = require("path");
jest.mock("../../backend/src/modules/knowledge_paths", () => ({
  ...jest.requireActual("../../backend/src/modules/knowledge_paths"),
  upsertKnowledgeIndexEntry: jest.fn((entry) => entry),
}));
const {
  KnowledgeModule,
} = require("../../backend/src/modules/knowledge");
const {
  buildSceneFromTranslationPairs,
  evaluateMergedKnowledge,
  evaluateTerminologyEnforcement,
  evaluateTerminologyExtraction,
  loadTerminologyFixtures,
  validateTerminologyCaseContract,
} = require("../helpers/terminology_case_assertions");

function createTempFilePath(fileName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminology-kb-"));
  return path.join(dir, fileName);
}

function writeLearningEvidence(caseId, chapterId, pairs) {
  const filePath = createTempFilePath(`${caseId}_learning.json`);
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 2,
    sourceTranslationJobId: caseId,
    evidence: pairs.map((pair, index) => ({
      id: pair.id || `e${index}`,
      evidenceId: `evidence_${index}`,
      nodeId: pair.nodeId || `e${index}`,
      pageName: pair.pageName || "fixture.txt",
      original: pair.original,
      translation: pair.translation,
      reasons: ["quality_revision"],
      confidence: 0.9,
    })),
  }));
  return filePath;
}

describe("terminology fixture contract", () => {
  const fixtureSet = loadTerminologyFixtures();
  const allCases = [...fixtureSet.cases, ...fixtureSet.negativeCases];

  test("all terminology fixtures satisfy the shared contract", () => {
    expect(allCases.length).toBeGreaterThanOrEqual(10);
    for (const caseData of allCases) {
      expect(() => validateTerminologyCaseContract(caseData)).not.toThrow();
    }
  });
});

describe("terminology extraction evaluation", () => {
  const fixtureSet = loadTerminologyFixtures();
  const allCases = [...fixtureSet.cases, ...fixtureSet.negativeCases];

  test.each(allCases)("$caseId extraction output matches expected terminology behavior", (caseData) => {
    const evaluation = evaluateTerminologyExtraction(caseData, caseData.sampleKnowledgeOutput);
    expect(evaluation).toEqual(
      expect.objectContaining({
        passed: true,
        missingTerms: [],
        missingCharacters: [],
        categoryMismatches: [],
        aliasEvidenceIssues: [],
        forbiddenHits: [],
      })
    );
  });
});

describe("terminology enforcement evaluation", () => {
  const fixtureSet = loadTerminologyFixtures();
  const allCases = [...fixtureSet.cases, ...fixtureSet.negativeCases];

  test.each(allCases)("$caseId quality output keeps canonical terminology stable", (caseData) => {
    const evaluation = evaluateTerminologyEnforcement(caseData, caseData.sampleQualityOutput);
    expect(evaluation).toEqual(
      expect.objectContaining({
        passed: true,
        missingCanonicals: [],
        forbiddenHits: [],
      })
    );
  });
});

describe("knowledge merge evaluation", () => {
  const fixtureSet = loadTerminologyFixtures();
  const allCases = [...fixtureSet.cases, ...fixtureSet.negativeCases];

  test.each(allCases)("$caseId merge keeps a single canonical interpretation", async (caseData) => {
    const knowledgeBasePath = createTempFilePath(`${caseData.caseId}_knowledge.json`);
    const reportPath = createTempFilePath(`${caseData.caseId}_extract_report.json`);
    const runtime = caseData.context.runtime;

    fs.writeFileSync(
      knowledgeBasePath,
      JSON.stringify(runtime.seedKnowledgeBase || null, null, 2)
    );

    const moduleInstance = new KnowledgeModule(
      {
        getScene: jest.fn().mockResolvedValue(
          buildSceneFromTranslationPairs(runtime.knowledgeTranslationPairs, caseData.caseId)
        ),
      },
      {
        runKnowledgeEnrichment: jest.fn().mockResolvedValue(caseData.sampleKnowledgeOutput),
      }
    );

    await moduleInstance.run({
      baseUrl: "http://127.0.0.1:9999",
      mangaId: "fixture_series",
      chapterId: runtime.chapterId,
      knowledgeBasePath,
      reportPath,
      jobId: caseData.caseId,
      learningEvidenceSnapshotPath: writeLearningEvidence(caseData.caseId, runtime.chapterId, runtime.knowledgeTranslationPairs),
    });

    const knowledgeBase = JSON.parse(fs.readFileSync(knowledgeBasePath, "utf8"));
    const evaluation = evaluateMergedKnowledge(caseData, knowledgeBase);

    expect(evaluation).toEqual(
      expect.objectContaining({
        passed: true,
        missingCanonicals: [],
        forbiddenHits: [],
        duplicateCanonicals: [],
        aliasOverflow: [],
      })
    );
  });
});
