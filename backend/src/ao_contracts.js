function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertOptionalString(value, fieldName) {
  if (value !== null && value !== undefined) {
    assertCondition(typeof value === "string", `${fieldName} must be a string when provided.`);
  }
}

function assertArray(value, fieldName) {
  assertCondition(Array.isArray(value), `${fieldName} must be an array.`);
}

function assertPlainObject(value, fieldName) {
  assertCondition(isPlainObject(value), `${fieldName} must be an object.`);
}

function validateNamedStringArray(value, fieldName) {
  assertArray(value, fieldName);
  value.forEach((entry, index) => {
    assertCondition(
      typeof entry === "string" && entry.length > 0,
      `${fieldName}[${index}] must be a non-empty string.`
    );
  });
}

function normalizeNamedStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).filter((entry) => entry.length > 0);
  }
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  return [];
}

function normalizeQualityFindingArray(value, defaultType) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    if (isPlainObject(entry)) {
      return entry;
    }
    if (typeof entry === "string" && entry.length > 0) {
      return {
        type: defaultType,
        message: entry,
      };
    }
    return {
      type: defaultType,
      message: String(entry),
    };
  });
}

function validateQualityFinding(finding, index, fieldName) {
  assertPlainObject(finding, `${fieldName}[${index}]`);
  assertCondition(
    typeof finding.type === "string" && finding.type.length > 0,
    `${fieldName}[${index}].type must be a non-empty string.`
  );
  assertCondition(
    typeof finding.message === "string" && finding.message.length > 0,
    `${fieldName}[${index}].message must be a non-empty string.`
  );
  assertOptionalString(finding.severity, `${fieldName}[${index}].severity`);
  assertOptionalString(finding.pageName, `${fieldName}[${index}].pageName`);
  assertOptionalString(finding.nodeId, `${fieldName}[${index}].nodeId`);
  assertOptionalString(finding.termId, `${fieldName}[${index}].termId`);
}

function validateQualityFindingArray(value, fieldName) {
  assertArray(value, fieldName);
  value.forEach((finding, index) => validateQualityFinding(finding, index, fieldName));
}

function validateQualityChecksSummary(checks, fieldName) {
  assertPlainObject(checks, fieldName);
  validateNamedStringArray(checks.passed, `${fieldName}.passed`);
  validateNamedStringArray(checks.failed, `${fieldName}.failed`);
  assertPlainObject(checks.totals, `${fieldName}.totals`);
  assertCondition(
    typeof checks.totals.passed === "number" && Number.isFinite(checks.totals.passed),
    `${fieldName}.totals.passed must be a finite number.`
  );
  assertCondition(
    typeof checks.totals.failed === "number" && Number.isFinite(checks.totals.failed),
    `${fieldName}.totals.failed must be a finite number.`
  );
}

function arraysMatch(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }

  return left.every((entry, index) => entry === right[index]);
}

function validateQualityValidationReport(result, fieldName = "quality_validation_report") {
  assertPlainObject(result, fieldName);
  assertCondition(
    typeof result.overall === "string" && result.overall.length > 0,
    `${fieldName}.overall must be a non-empty string.`
  );
  assertCondition(
    typeof result.score === "number" && Number.isFinite(result.score),
    `${fieldName}.score must be a finite number.`
  );
  assertCondition(
    typeof result.totalTranslations === "number" && Number.isFinite(result.totalTranslations),
    `${fieldName}.totalTranslations must be a finite number.`
  );
  validateQualityChecksSummary(result.checks, `${fieldName}.checks`);
  validateQualityFindingArray(result.issues, `${fieldName}.issues`);
  validateQualityFindingArray(result.warnings, `${fieldName}.warnings`);
  validateNamedStringArray(result.passedChecks, `${fieldName}.passedChecks`);
  validateNamedStringArray(result.failedChecks, `${fieldName}.failedChecks`);
  assertCondition(
    arraysMatch(result.passedChecks, result.checks.passed),
    `${fieldName}.passedChecks must match ${fieldName}.checks.passed.`
  );
  assertCondition(
    arraysMatch(result.failedChecks, result.checks.failed),
    `${fieldName}.failedChecks must match ${fieldName}.checks.failed.`
  );
  if (result.usedKnowledgeSources !== undefined) {
    validateNamedStringArray(result.usedKnowledgeSources, `${fieldName}.usedKnowledgeSources`);
  }
  assertOptionalString(result.notes, `${fieldName}.notes`);
  return result;
}

function validateTerminologyEntry(entry, index) {
  assertPlainObject(entry, `knowledge_enrichment.terminologyEntries[${index}]`);
  assertCondition(
    typeof entry.term === "string" && entry.term.length > 0,
    `knowledge_enrichment.terminologyEntries[${index}].term must be a non-empty string.`
  );
  assertCondition(
    typeof entry.translation === "string" && entry.translation.length > 0,
    `knowledge_enrichment.terminologyEntries[${index}].translation must be a non-empty string.`
  );
  assertOptionalString(entry.category, `knowledge_enrichment.terminologyEntries[${index}].category`);
  assertOptionalString(entry.notes, `knowledge_enrichment.terminologyEntries[${index}].notes`);
  if (entry.confidence !== undefined && entry.confidence !== null) {
    assertCondition(
      typeof entry.confidence === "number" && Number.isFinite(entry.confidence),
      `knowledge_enrichment.terminologyEntries[${index}].confidence must be a finite number.`
    );
  }
}

function validateCharacterExample(example, index, parentIndex) {
  assertPlainObject(example, `knowledge_enrichment.characterEntries[${parentIndex}].example_lines[${index}]`);
  assertOptionalString(
    example.pageName,
    `knowledge_enrichment.characterEntries[${parentIndex}].example_lines[${index}].pageName`
  );
  assertOptionalString(
    example.nodeId,
    `knowledge_enrichment.characterEntries[${parentIndex}].example_lines[${index}].nodeId`
  );
  assertCondition(
    typeof example.translation === "string" && example.translation.length > 0,
    `knowledge_enrichment.characterEntries[${parentIndex}].example_lines[${index}].translation must be a non-empty string.`
  );
}

function validateCharacterEntry(entry, index) {
  assertPlainObject(entry, `knowledge_enrichment.characterEntries[${index}]`);
  assertCondition(
    typeof entry.name === "string" && entry.name.length > 0,
    `knowledge_enrichment.characterEntries[${index}].name must be a non-empty string.`
  );
  if (entry.aliases !== undefined) {
    assertArray(entry.aliases, `knowledge_enrichment.characterEntries[${index}].aliases`);
  }
  if (entry.title_forms !== undefined) {
    assertArray(entry.title_forms, `knowledge_enrichment.characterEntries[${index}].title_forms`);
  }
  if (entry.speech_style !== undefined) {
    assertArray(entry.speech_style, `knowledge_enrichment.characterEntries[${index}].speech_style`);
  }
  if (entry.sentence_ending_patterns !== undefined) {
    assertArray(
      entry.sentence_ending_patterns,
      `knowledge_enrichment.characterEntries[${index}].sentence_ending_patterns`
    );
  }
  if (entry.addressing_patterns !== undefined) {
    assertArray(
      entry.addressing_patterns,
      `knowledge_enrichment.characterEntries[${index}].addressing_patterns`
    );
  }
  assertOptionalString(
    entry.first_seen_chapter,
    `knowledge_enrichment.characterEntries[${index}].first_seen_chapter`
  );
  if (entry.example_lines !== undefined) {
    assertArray(entry.example_lines, `knowledge_enrichment.characterEntries[${index}].example_lines`);
    entry.example_lines.forEach((example, exampleIndex) =>
      validateCharacterExample(example, exampleIndex, index)
    );
  }
  if (entry.confidence !== undefined && entry.confidence !== null) {
    assertCondition(
      typeof entry.confidence === "number" && Number.isFinite(entry.confidence),
      `knowledge_enrichment.characterEntries[${index}].confidence must be a finite number.`
    );
  }
}

function validateCharacterSpeechEvidenceEntry(entry, index) {
  assertPlainObject(entry, `knowledge_enrichment.characterSpeechEvidence[${index}]`);
  assertCondition(
    typeof entry.name === "string" && entry.name.length > 0,
    `knowledge_enrichment.characterSpeechEvidence[${index}].name must be a non-empty string.`
  );
  if (entry.speech_style !== undefined) {
    assertArray(entry.speech_style, `knowledge_enrichment.characterSpeechEvidence[${index}].speech_style`);
  }
  if (entry.sentence_ending_patterns !== undefined) {
    assertArray(
      entry.sentence_ending_patterns,
      `knowledge_enrichment.characterSpeechEvidence[${index}].sentence_ending_patterns`
    );
  }
  if (entry.addressing_patterns !== undefined) {
    assertArray(
      entry.addressing_patterns,
      `knowledge_enrichment.characterSpeechEvidence[${index}].addressing_patterns`
    );
  }
  if (entry.example_lines !== undefined) {
    assertArray(entry.example_lines, `knowledge_enrichment.characterSpeechEvidence[${index}].example_lines`);
    entry.example_lines.forEach((example, exampleIndex) =>
      validateCharacterExample(example, exampleIndex, index)
    );
  }
  if (entry.notes !== undefined) {
    assertArray(entry.notes, `knowledge_enrichment.characterSpeechEvidence[${index}].notes`);
  }
  if (entry.confidence !== undefined && entry.confidence !== null) {
    assertCondition(
      typeof entry.confidence === "number" && Number.isFinite(entry.confidence),
      `knowledge_enrichment.characterSpeechEvidence[${index}].confidence must be a finite number.`
    );
  }
}

function validateNarrationEvidenceEntry(entry, index) {
  assertPlainObject(entry, `knowledge_enrichment.narrationEvidence[${index}]`);
  assertOptionalString(entry.tone, `knowledge_enrichment.narrationEvidence[${index}].tone`);
  assertOptionalString(entry.register, `knowledge_enrichment.narrationEvidence[${index}].register`);
  if (entry.preferred_patterns !== undefined) {
    assertArray(
      entry.preferred_patterns,
      `knowledge_enrichment.narrationEvidence[${index}].preferred_patterns`
    );
  }
  if (entry.forbidden_patterns !== undefined) {
    assertArray(
      entry.forbidden_patterns,
      `knowledge_enrichment.narrationEvidence[${index}].forbidden_patterns`
    );
  }
  if (entry.example_lines !== undefined) {
    assertArray(entry.example_lines, `knowledge_enrichment.narrationEvidence[${index}].example_lines`);
    entry.example_lines.forEach((example, exampleIndex) =>
      validateCharacterExample(example, exampleIndex, index)
    );
  }
  if (entry.notes !== undefined) {
    assertArray(entry.notes, `knowledge_enrichment.narrationEvidence[${index}].notes`);
  }
  if (entry.confidence !== undefined && entry.confidence !== null) {
    assertCondition(
      typeof entry.confidence === "number" && Number.isFinite(entry.confidence),
      `knowledge_enrichment.narrationEvidence[${index}].confidence must be a finite number.`
    );
  }
}

function validateStyleProfile(profile) {
  if (profile === null || profile === undefined) {
    return;
  }

  assertPlainObject(profile, "knowledge_enrichment.styleProfile");
  assertOptionalString(profile.tone, "knowledge_enrichment.styleProfile.tone");
  assertOptionalString(profile.register, "knowledge_enrichment.styleProfile.register");

  for (const fieldName of [
    "honorific_policy",
    "punctuation_policy",
    "preferred_patterns",
    "forbidden_patterns",
    "notes",
  ]) {
    if (profile[fieldName] !== undefined) {
      assertArray(profile[fieldName], `knowledge_enrichment.styleProfile.${fieldName}`);
    }
  }

  if (profile.narration !== undefined && profile.narration !== null) {
    assertPlainObject(profile.narration, "knowledge_enrichment.styleProfile.narration");
    assertOptionalString(profile.narration.tone, "knowledge_enrichment.styleProfile.narration.tone");
    assertOptionalString(profile.narration.register, "knowledge_enrichment.styleProfile.narration.register");
    for (const fieldName of ["preferred_patterns", "forbidden_patterns", "notes"]) {
      if (profile.narration[fieldName] !== undefined) {
        assertArray(
          profile.narration[fieldName],
          `knowledge_enrichment.styleProfile.narration.${fieldName}`
        );
      }
    }
  }
}

function validateStyleExampleEntry(entry, index) {
  assertPlainObject(entry, `knowledge_enrichment.styleExampleEntries[${index}]`);
  assertOptionalString(entry.type, `knowledge_enrichment.styleExampleEntries[${index}].type`);
  if (entry.type !== undefined && entry.type !== null) {
    assertCondition(
      ["dialogue", "narration"].includes(entry.type),
      `knowledge_enrichment.styleExampleEntries[${index}].type must be dialogue or narration.`
    );
  }
  assertOptionalString(entry.pageName, `knowledge_enrichment.styleExampleEntries[${index}].pageName`);
  assertOptionalString(entry.nodeId, `knowledge_enrichment.styleExampleEntries[${index}].nodeId`);
  assertCondition(
    typeof entry.translation === "string" && entry.translation.length > 0,
    `knowledge_enrichment.styleExampleEntries[${index}].translation must be a non-empty string.`
  );
  assertOptionalString(entry.reason, `knowledge_enrichment.styleExampleEntries[${index}].reason`);
}

function validateKnowledgeEnrichmentResult(result) {
  assertPlainObject(result, "knowledge_enrichment result");
  assertCondition(
    typeof result.enrichmentMode === "string" && result.enrichmentMode.length > 0,
    "knowledge_enrichment.enrichmentMode must be a non-empty string."
  );

  for (const fieldName of ["translationPairs", "characters", "terminology", "styleExamples"]) {
    assertCondition(
      typeof result[fieldName] === "number" && Number.isFinite(result[fieldName]),
      `knowledge_enrichment.${fieldName} must be a finite number.`
    );
  }

  assertArray(result.terminologyEntries, "knowledge_enrichment.terminologyEntries");
  result.terminologyEntries.forEach(validateTerminologyEntry);

  assertArray(result.characterEntries, "knowledge_enrichment.characterEntries");
  result.characterEntries.forEach(validateCharacterEntry);

  validateStyleProfile(result.styleProfile);

  assertArray(result.styleExampleEntries, "knowledge_enrichment.styleExampleEntries");
  result.styleExampleEntries.forEach(validateStyleExampleEntry);

  if (result.characterSpeechEvidence !== undefined) {
    assertArray(result.characterSpeechEvidence, "knowledge_enrichment.characterSpeechEvidence");
    result.characterSpeechEvidence.forEach(validateCharacterSpeechEvidenceEntry);
  }
  if (result.narrationEvidence !== undefined) {
    assertArray(result.narrationEvidence, "knowledge_enrichment.narrationEvidence");
    result.narrationEvidence.forEach(validateNarrationEvidenceEntry);
  }

  assertOptionalString(result.notes, "knowledge_enrichment.notes");
  return result;
}

module.exports = {
  validateKnowledgeEnrichmentResult,
  validateQualityValidationReport,
};
