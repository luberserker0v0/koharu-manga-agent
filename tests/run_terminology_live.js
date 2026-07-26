const fs = require("fs");
const path = require("path");
const {
  AOClient,
} = require("../backend/src/ao_client");
const {
  AOTaskRunner,
} = require("../backend/src/ao_tasks");
const {
  config,
} = require("../backend/src/config");
const {
  buildQualityContextProjection,
  buildQualityWindowInput,
} = require("../backend/src/modules/quality_projection");
const {
  buildSceneFromTranslationPairs,
  evaluateMergedKnowledge,
  evaluateTerminologyEnforcement,
  evaluateTerminologyExtraction,
  loadTerminologyFixtures,
} = require("./helpers/terminology_case_assertions");

function createKnowledgeBaseSeed(seedKnowledgeBase, translationPairs, chapterId, caseId) {
  return (
    seedKnowledgeBase || {
      metadata: {
        schema_version: "2.0",
        manga_id: "fixture_series",
        chapter_ids: chapterId ? [chapterId] : [],
        project_name: caseId,
        source: "self",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_enriched_at: new Date().toISOString(),
        enrichment_mode: "ao",
        source_projects: [caseId],
      },
      translation_pairs: translationPairs.map((pair, index) => ({
        id: `seed_${index + 1}`,
        original: pair.original,
        translation: pair.translation,
        pageName: pair.pageName,
        nodeId: pair.nodeId,
        chapterId,
        sourceReference: "self",
        updatedAt: new Date().toISOString(),
      })),
      terminology: [],
      characters: [],
      style_profile: {
        tone: null,
        register: "mixed",
        honorific_policy: [],
        punctuation_policy: [],
        preferred_patterns: [],
        forbidden_patterns: [],
        notes: [],
      },
      style_examples: [],
    }
  );
}

function buildQualityGlossary(extractionResult) {
  const terminologyEntries = extractionResult.terminologyEntries || [];
  const characterEntries = extractionResult.characterEntries || [];
  return {
    entries: [
      ...terminologyEntries.map((entry, index) => ({
        term_id: `term_${index + 1}`,
        canonical_translation: entry.translation,
        aliases: [],
        category: entry.category || "general_term",
        locked: false,
      })),
      ...characterEntries.map((entry, index) => ({
        term_id: `char_${index + 1}`,
        canonical_translation: entry.name,
        aliases: entry.aliases || [],
        category: "character_name",
        locked: false,
      })),
    ],
  };
}

function buildStoryContext(extractionResult, chapterId) {
  return {
    chapters: {
      [chapterId]: {
        characters: (extractionResult.characterEntries || []).map((entry) => ({
          name: entry.name,
        })),
        terminology: (extractionResult.terminologyEntries || []).map((entry) => ({
          term: entry.translation,
        })),
        keyLines: [],
      },
    },
  };
}

async function run() {
  const fixtureSet = loadTerminologyFixtures();
  const allCases = [...fixtureSet.cases, ...fixtureSet.negativeCases];
  const requestedCaseId = process.argv[2] || null;
  const requestedPhase = process.argv[3] || "full";
  const cases = requestedCaseId
    ? allCases.filter((caseData) => caseData.caseId === requestedCaseId)
    : allCases;

  if (requestedCaseId && cases.length === 0) {
    throw new Error(`Unknown terminology fixture caseId: ${requestedCaseId}`);
  }
  if (!["full", "extraction"].includes(requestedPhase)) {
    throw new Error(`Unknown terminology phase: ${requestedPhase}`);
  }

  const opencodeConfigPath = path.join(
    __dirname,
    "..",
    "backend",
    "ao",
    "opencode",
    "opencode.json"
  );
  if (!fs.existsSync(opencodeConfigPath)) {
    throw new Error(
      `AO live terminology runner requires ${opencodeConfigPath}.`
    );
  }

  const client = new AOClient({
    baseUrl: config.agent.baseUrl,
    apiKey: config.agent.apiKey,
    readyPollIntervalMs: config.agent.readyPollIntervalMs,
    readyTimeoutMs: config.agent.readyTimeoutMs,
  });
  const runner = new AOTaskRunner({ client });

  const summary = [];
  for (const caseData of cases) {
    const runtime = caseData.context.runtime;
    const chapterId = runtime.chapterId || `${caseData.caseId}_chapter`;
    const extractionInput = {
      jobId: `${caseData.caseId}_extract`,
      mangaId: "fixture_series",
      chapterId,
      translationPairs: runtime.knowledgeTranslationPairs,
      knowledgeBase: createKnowledgeBaseSeed(
        runtime.seedKnowledgeBase,
        runtime.knowledgeTranslationPairs,
        chapterId,
        caseData.caseId
      ),
    };

    const extractionResult = await runner.runTerminologyExtraction(extractionInput);
    const extractionEvaluation = evaluateTerminologyExtraction(caseData, extractionResult);

    if (requestedPhase === "extraction") {
      summary.push({
        caseId: caseData.caseId,
        extraction: extractionEvaluation.passed,
        extractionDetails: extractionEvaluation,
        extractionResult,
      });
      continue;
    }

    const glossary = buildQualityGlossary(extractionResult);
    const storyContext = buildStoryContext(extractionResult, chapterId);
    const knowledgeBase = createKnowledgeBaseSeed(
      runtime.seedKnowledgeBase,
      runtime.knowledgeTranslationPairs,
      chapterId,
      caseData.caseId
    );
    knowledgeBase.terminology = extractionResult.terminologyEntries || [];
    knowledgeBase.characters = extractionResult.characterEntries || [];

    const projection = buildQualityContextProjection({
      translations: runtime.qualityTranslations,
      translationMemory: {
        fingerprint: `fixture_${caseData.caseId}`,
        effective: { glossary: glossary.entries, story: null, style: null, localKnowledge: null },
      },
    });
    const windowResults = [];
    for (const window of projection.windows) {
      windowResults.push(await runner.runQualityReviewAndOptimization({
        ...buildQualityWindowInput(projection, window),
        jobId: `${caseData.caseId}_enforce`,
      }));
    }
    const enforcementResult = {
      proposedTranslations: windowResults.flatMap((result) => result.revisions || []),
    };
    const enforcementEvaluation = evaluateTerminologyEnforcement(caseData, enforcementResult);

    const mergeScene = buildSceneFromTranslationPairs(
      runtime.knowledgeTranslationPairs,
      caseData.caseId
    );
    const mergedKnowledgeBase = createKnowledgeBaseSeed(
      runtime.seedKnowledgeBase,
      runtime.knowledgeTranslationPairs,
      chapterId,
      caseData.caseId
    );
    mergedKnowledgeBase.translation_pairs = mergeScene.scene.pages
      ? mergedKnowledgeBase.translation_pairs
      : [];
    mergedKnowledgeBase.terminology = extractionResult.terminologyEntries || [];
    mergedKnowledgeBase.characters = extractionResult.characterEntries || [];
    const mergeEvaluation = evaluateMergedKnowledge(caseData, mergedKnowledgeBase);

    summary.push({
      caseId: caseData.caseId,
      extraction: extractionEvaluation.passed,
      enforcement: enforcementEvaluation.passed,
      merge: mergeEvaluation.passed,
      extractionDetails: extractionEvaluation,
      enforcementDetails: enforcementEvaluation,
      mergeDetails: mergeEvaluation,
      extractionResult,
      enforcementResult,
    });
  }

  console.log(
    JSON.stringify(
      {
        baseUrl: config.agent.baseUrl,
        requestedCaseId,
        requestedPhase,
        caseCount: cases.length,
        summary,
      },
      null,
      2
    )
  );
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
