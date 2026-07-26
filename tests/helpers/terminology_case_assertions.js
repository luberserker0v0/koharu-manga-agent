const fs = require("fs");
const path = require("path");
const {
  validateKnowledgeEnrichmentResult,
} = require("../../backend/src/ao_contracts");

const FIXTURE_PATH = path.join(__dirname, "..", "fixtures", "terminology_cases.json");

function validateLegacyQualityFixture(result) {
  if (!result || !Array.isArray(result.proposedTranslations)) {
    throw new Error("Fixture quality output requires proposedTranslations[].");
  }
  return result;
}

function loadTerminologyFixtures(filePath = FIXTURE_PATH) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function asArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === null || value === undefined) {
    return [];
  }
  return [value];
}

function normalizeExpectedTerm(entry) {
  if (typeof entry === "string") {
    return { canonical: entry, category: null };
  }
  return {
    canonical: entry.canonical,
    category: entry.category || null,
  };
}

function normalizeExpectedCharacter(entry) {
  if (typeof entry === "string") {
    return { name: entry, aliases: [] };
  }
  return {
    name: entry.name,
    aliases: asArray(entry.aliases),
  };
}

function validateExpectedShape(expected, caseId) {
  for (const fieldName of [
    "mustExtractTerms",
    "mustExtractCharacters",
    "mustUseCanonical",
    "mustNotUse",
    "allowedVariants",
  ]) {
    if (!Array.isArray(expected[fieldName])) {
      throw new Error(`${caseId}: expected.${fieldName} must be an array.`);
    }
  }
}

function validateTerminologyCaseContract(caseData) {
  if (!caseData || typeof caseData !== "object") {
    throw new Error("terminology case must be an object.");
  }
  if (typeof caseData.caseId !== "string" || caseData.caseId.length === 0) {
    throw new Error("terminology case must include a non-empty caseId.");
  }
  if (
    !(
      typeof caseData.sourceSnippet === "string" ||
      (Array.isArray(caseData.sourceSnippet) && caseData.sourceSnippet.length > 0)
    )
  ) {
    throw new Error(`${caseData.caseId}: sourceSnippet must be a string or non-empty array.`);
  }
  if (!caseData.context || typeof caseData.context !== "object") {
    throw new Error(`${caseData.caseId}: context must be an object.`);
  }
  if (!caseData.expected || typeof caseData.expected !== "object") {
    throw new Error(`${caseData.caseId}: expected must be present for hard-evaluation fixtures.`);
  }

  validateExpectedShape(caseData.expected, caseData.caseId);

  if (caseData.sampleKnowledgeOutput) {
    validateKnowledgeEnrichmentResult(caseData.sampleKnowledgeOutput);
  }
  if (caseData.sampleQualityOutput) {
    validateLegacyQualityFixture(caseData.sampleQualityOutput);
  }
}

function collectSourceCorpus(caseData) {
  const parts = [];
  for (const line of asArray(caseData.sourceSnippet)) {
    parts.push(String(line));
  }
  const runtimePairs = caseData.context?.runtime?.knowledgeTranslationPairs || [];
  for (const pair of runtimePairs) {
    parts.push(pair.translation || "");
  }
  return parts.join("\n");
}

function getAllowedVariantUniverse(expected) {
  const map = new Map();
  for (const entry of expected.allowedVariants || []) {
    if (!entry || typeof entry.canonical !== "string") {
      continue;
    }
    map.set(entry.canonical, new Set(asArray(entry.variants)));
  }
  for (const character of expected.mustExtractCharacters || []) {
    const normalized = normalizeExpectedCharacter(character);
    const current = map.get(normalized.name) || new Set();
    normalized.aliases.forEach((alias) => current.add(alias));
    map.set(normalized.name, current);
  }
  return map;
}

function evaluateTerminologyExtraction(caseData, output) {
  const expected = caseData.expected;
  const normalized = validateKnowledgeEnrichmentResult(output);
  const observedTerms = normalized.terminologyEntries || [];
  const observedCharacters = normalized.characterEntries || [];
  const sourceCorpus = collectSourceCorpus(caseData);
  const allowedVariantUniverse = getAllowedVariantUniverse(expected);

  const missingTerms = [];
  const categoryMismatches = [];
  for (const expectedTerm of expected.mustExtractTerms.map(normalizeExpectedTerm)) {
    const observed = observedTerms.find(
      (entry) => entry.translation === expectedTerm.canonical || entry.term === expectedTerm.canonical
    );
    if (!observed) {
      missingTerms.push(expectedTerm.canonical);
      continue;
    }
    if (expectedTerm.category && observed.category !== expectedTerm.category) {
      categoryMismatches.push({
        canonical: expectedTerm.canonical,
        expectedCategory: expectedTerm.category,
        actualCategory: observed.category || null,
      });
    }
  }

  const missingCharacters = [];
  const aliasEvidenceIssues = [];
  for (const expectedCharacter of expected.mustExtractCharacters.map(normalizeExpectedCharacter)) {
    const observed = observedCharacters.find((entry) => entry.name === expectedCharacter.name);
    if (!observed) {
      missingCharacters.push(expectedCharacter.name);
      continue;
    }
    for (const alias of observed.aliases || []) {
      const allowed = allowedVariantUniverse.get(expectedCharacter.name) || new Set();
      const hasSourceEvidence = sourceCorpus.includes(alias);
      if (!allowed.has(alias) && !hasSourceEvidence) {
        aliasEvidenceIssues.push({
          character: expectedCharacter.name,
          alias,
        });
      }
    }
  }

  const forbiddenHits = [];
  const extractedStrings = [
    ...observedTerms.flatMap((entry) => [entry.translation, entry.term]),
    ...observedCharacters.flatMap((entry) => [entry.name, ...(entry.aliases || [])]),
  ].filter(Boolean);
  for (const forbidden of expected.mustNotUse || []) {
    if (extractedStrings.includes(forbidden)) {
      forbiddenHits.push(forbidden);
    }
  }

  return {
    passed:
      missingTerms.length === 0 &&
      missingCharacters.length === 0 &&
      categoryMismatches.length === 0 &&
      aliasEvidenceIssues.length === 0 &&
      forbiddenHits.length === 0,
    missingTerms,
    missingCharacters,
    categoryMismatches,
    aliasEvidenceIssues,
    forbiddenHits,
    output: normalized,
  };
}

function evaluateTerminologyEnforcement(caseData, output) {
  const expected = caseData.expected;
  const normalized = validateLegacyQualityFixture(output);
  const revisedTranslations = (normalized.proposedTranslations || []).map(
    (entry) => entry.revisedTranslation
  );
  const joinedRevisions = revisedTranslations.join("\n");

  const missingCanonicals = [];
  for (const canonical of expected.mustUseCanonical || []) {
    if (!joinedRevisions.includes(canonical)) {
      missingCanonicals.push(canonical);
    }
  }

  const forbiddenHits = [];
  for (const forbidden of expected.mustNotUse || []) {
    if (joinedRevisions.includes(forbidden)) {
      forbiddenHits.push(forbidden);
    }
  }

  return {
    passed: missingCanonicals.length === 0 && forbiddenHits.length === 0,
    missingCanonicals,
    forbiddenHits,
    output: normalized,
  };
}

function buildSceneFromTranslationPairs(translationPairs, projectName = "fixture_project") {
  const pages = {};
  for (const pair of translationPairs || []) {
    const pageId = String(pair.pageName || "page_001").replace(/\W+/g, "_");
    if (!pages[pageId]) {
      pages[pageId] = {
        name: pair.pageName || "001.jpg",
        nodes: {},
      };
    }
    pages[pageId].nodes[pair.nodeId] = {
      kind: {
        text: {
          text: pair.original,
          translation: pair.translation,
        },
      },
    };
  }

  return {
    scene: {
      project: { name: projectName },
      pages,
    },
  };
}

function evaluateMergedKnowledge(caseData, knowledgeBase) {
  const expected = caseData.expected;
  const terminology = asArray(knowledgeBase.terminology);
  const characters = asArray(knowledgeBase.characters);

  const terminologyCanonicals = terminology.map((entry) => entry.translation || entry.term).filter(Boolean);
  const characterNames = characters.map((entry) => entry.name).filter(Boolean);

  const missingCanonicals = [];
  for (const canonical of expected.mustUseCanonical || []) {
    if (!terminologyCanonicals.includes(canonical) && !characterNames.includes(canonical)) {
      missingCanonicals.push(canonical);
    }
  }

  const forbiddenHits = [];
  for (const forbidden of expected.mustNotUse || []) {
    const inTerminology = terminologyCanonicals.includes(forbidden);
    const inCharacters = characters.some(
      (entry) =>
        entry.name === forbidden ||
        asArray(entry.aliases).includes(forbidden) ||
        asArray(entry.title_forms).includes(forbidden)
    );
    if (inTerminology || inCharacters) {
      forbiddenHits.push(forbidden);
    }
  }

  const duplicateCanonicals = terminologyCanonicals.filter(
    (entry, index) => terminologyCanonicals.indexOf(entry) !== index
  );

  const aliasOverflow = [];
  const allowedVariantUniverse = getAllowedVariantUniverse(expected);
  for (const character of characters) {
    const allowed = allowedVariantUniverse.get(character.name);
    if (!allowed) {
      continue;
    }
    for (const alias of asArray(character.aliases)) {
      if (!allowed.has(alias)) {
        aliasOverflow.push({
          character: character.name,
          alias,
        });
      }
    }
  }

  return {
    passed:
      missingCanonicals.length === 0 &&
      forbiddenHits.length === 0 &&
      duplicateCanonicals.length === 0 &&
      aliasOverflow.length === 0,
    missingCanonicals,
    forbiddenHits,
    duplicateCanonicals,
    aliasOverflow,
  };
}

module.exports = {
  FIXTURE_PATH,
  buildSceneFromTranslationPairs,
  evaluateMergedKnowledge,
  evaluateTerminologyEnforcement,
  evaluateTerminologyExtraction,
  loadTerminologyFixtures,
  validateTerminologyCaseContract,
};
