function stringifyTaskInput(input) {
  return JSON.stringify(input, null, 2);
}

function buildPromptSections(definition, input) {
  const lines = [];
  lines.push(`Primary task: ${definition.primaryTask}`);
  lines.push(`Required specialist file: ${definition.requiredSpecialistFile}`);
  if (definition.supportingSpecialistFiles.length > 0) {
    lines.push("Supporting specialist files:");
    for (const filePath of definition.supportingSpecialistFiles) {
      lines.push(`- ${filePath}`);
    }
  }
  if (definition.requiredOutputContract.length > 0) {
    lines.push("Required output contract:");
    for (const contractPath of definition.requiredOutputContract) {
      lines.push(`- ${contractPath}`);
    }
  }
  if (definition.forbiddenBehavior.length > 0) {
    lines.push("Forbidden behavior:");
    for (const item of definition.forbiddenBehavior) {
      lines.push(`- ${item}`);
    }
  }
  if (definition.taskInstructions.length > 0) {
    lines.push("Task instructions:");
    for (const item of definition.taskInstructions) {
      lines.push(`- ${item}`);
    }
  }
  lines.push("Task input shape:");
  for (const item of definition.taskInputShape) {
    lines.push(`- ${item}`);
  }
  lines.push("Authoritative structured input:");
  lines.push("- Read input/task_input.json before producing output.");
  lines.push("- If file access fails, use the exact JSON embedded later in this message.");
  lines.push("Embedded task_input.json:");
  lines.push(stringifyTaskInput(input));
  return lines;
}

function buildTaskRequestPayload(definition) {
  return {
    taskType: definition.stage,
    primaryTask: definition.primaryTask,
    requiredSpecialistFile: definition.requiredSpecialistFile,
    supportingSpecialistFiles: definition.supportingSpecialistFiles,
    requiredOutputContract: definition.requiredOutputContract,
    forbiddenBehavior: definition.forbiddenBehavior,
    taskInstructions: definition.taskInstructions,
    taskInputShape: definition.taskInputShape,
    outputMode: definition.outputMode,
  };
}

function createTerminologyExtractionDefinition(input, outputFilePath) {
  const referenceKind = input.referenceKind === "source" ? "source" : "translator";
  const alignmentMode = input.alignmentMode || (
    referenceKind === "source"
      ? "source_only"
      : Array.isArray(input.translationPairs) && input.translationPairs.length > 0
        ? "confirmed_pairs"
        : "target_only"
  );
  const modeSpecificInstructions =
    referenceKind === "source"
      ? [
          "Reference mode: source",
          "This input is original-language reference material, not a translated glossary sample.",
          "Infer source-side canonical forms from sourceLines and source-side evidence first.",
          "Use targetLines only as supporting evidence when the reference explicitly contains a trusted rendering.",
          "If no reliable target rendering exists, repeat the source term in the canonical field and explain uncertainty in NOTES.",
        ]
      : [
          "Reference mode: translator",
          "This input includes translator-facing reference evidence.",
          alignmentMode === "confirmed_pairs"
            ? "Preserve source-side identity from sourceLines, then align it to the preferred target rendering from confirmed translationPairs."
            : "This is target-only translator evidence. Extract target-language observations, but do not invent a source-language identity or claim an original/translation mapping.",
          "Use translated text to infer the canonical Traditional Chinese rendering only when the reference already supports it.",
          "When alignmentMode is target_only, leave unsupported source-side fields empty and explain that the rendering still requires source-side matching.",
        ];

  return {
    stage: "terminology_extraction",
    primaryTask: "terminology extraction from manga reference material",
    requiredSpecialistFile: "workspace/.opencode/agents/terminology-extractor.md",
    supportingSpecialistFiles: [
      "workspace/.opencode/agents/terminology-normalizer.md",
    ],
    requiredOutputContract: [],
    forbiddenBehavior: [
      "do not perform quality rewriting",
      "do not invent aliases or unsupported title forms",
      "do not promote one-off phrases into durable canonical terms",
      "do not output markdown",
      "do not output JSON",
    ],
    taskInstructions: [
      "Use conservative evidence-based extraction.",
      "Treat original/source text as the primary evidence for entity identity.",
      "When sourceNodes are provided, treat their textRole, styleChannel, and speaker fields as authoritative classification evidence.",
      "Do not turn label_or_system, sfx_like, mixed, or uncertain nodes into story evidence; they may still be considered conservatively for terminology identity when appropriate.",
      "A monologue can support character motivation or relationships, but must not be presented as publicly spoken dialogue or an externally confirmed event.",
      "Language metadata in the task input is authoritative. Do not guess a different language when contentLanguage, sourceLanguage, or targetLanguage is provided.",
      "Keep keys and enum values in English only.",
      "Keep evidenceLine and surfaceForm in contentLanguage.",
      "Keep canonicalForm and source-side identity fields in sourceLanguage unless the fieldLanguagePolicy explicitly says contentLanguage.",
      "Keep EVENT summaries in contentLanguage. If you cannot produce a trustworthy summary in that language, reuse the strongest evidence line instead of switching to English.",
      "Use targetLanguage only for targetRendering or canonical Traditional Chinese renderings when the reference already supports them.",
      "Do not translate evidence text into English just to satisfy formatting.",
      "Prefer repeated terms, explicit names, stable title forms, and terms already supported by locked/manual/reference knowledge.",
      "Return at most 6 terminologyEntries and at most 4 characterEntries.",
      "Character names belong only in characterEntries, not in terminologyEntries.",
      "If nothing is strong enough, return no TERM or CHARACTER lines and explain why in NOTES.",
      "Reject common nouns, punctuation reactions, websites, and credits.",
      "Do not reject a candidate only because it is not a person name. Named worldbuilding vocabulary is valid terminology.",
      "Treat named schools, techniques, devices, ports, ships, factions, noble houses, and institutions as valid terminology when the text supports them.",
      "A once-mentioned term can still be extracted when it is clearly presented as a named entity or named concept rather than a generic noun.",
      "Do not invent new record names or JSON keys.",
      "Use empty aliases/title_forms when there is no evidence.",
      "Use Traditional Chinese canonical forms when reliable translator evidence exists.",
      ...modeSpecificInstructions,
      `Write the final line-format result to ${outputFilePath}. Overwrite the file completely.`,
      "After writing the file successfully, reply with only: DONE",
      "Output only plain text lines in exactly one of these formats:",
      "TERM|<source_term>|<canonical_translation>|<category>|<confidence 0-1>|<reason>",
      "CHARACTER|<source_name>|<canonical_name>|aliases=a,b;title_forms=x,y|<confidence 0-1>|<reason>",
      "MAYBE|<candidate>|<kind>|<confidence 0-1>|<reason>",
      "REJECT|<candidate>|<kind>|<confidence 0-1>|<reason>",
      "NOTES|<free text>",
    ],
    taskInputShape: [
      "referenceKind, alignmentMode, sourceLines, sourceNodes, targetLines, translationPairs",
      "contentLanguage, sourceLanguage, targetLanguage, fieldLanguagePolicy",
      "lockedTerms, canonicalGlossary, candidateTerms, existingKnowledge",
      "jobId, chapterId, chapterTitle, mangaId, translatorId",
    ],
    outputMode: {
      type: "line_file",
      outputFilePath,
      completionReply: "DONE",
    },
  };
}

function createStoryContextUpdateDefinition(outputFilePath) {
  return {
    stage: "story_context_update",
    primaryTask: "produce a conservative translation-relevant story-memory delta",
    requiredSpecialistFile: "workspace/.opencode/agents/story-context-builder.md",
    supportingSpecialistFiles: [],
    requiredOutputContract: [
      "workspace/.opencode/skills/story-delta-contract/SKILL.md",
    ],
    forbiddenBehavior: [
      "do not summarize the whole chapter",
      "do not repeat unchanged memory",
      "do not infer facts from labels, sound effects, mixed OCR, or uncertain nodes",
      "do not invent subjects, objects, speakers, causality, or translation impact",
      "do not output JSON or markdown",
    ],
    taskInstructions: [
      "Read the specialist file and story-delta-contract skill before producing output.",
      "Treat storyCues, sourceNodes, and existingMemory as authoritative structured input.",
      "Chapter Observer already performed the complete first reading. Read only the supplied high-confidence cue nodes and their small local windows.",
      "Use the supplied textRole, speaker, styleChannel, and selectedStoryCue fields. Do not reclassify the chapter or request omitted nodes.",
      "Emit only new or materially changed facts that can prevent a later translation ambiguity.",
      "Use the fixed line records. Every record must cite every exact nodeId evidence anchor needed for its claims and state its translation impact; the backend resolves pageName from sourceNodes.",
      "Do not emit EVIDENCE_ROLE records; role evidence belongs to chapter_observation.json.",
      "Write every confidence as a decimal number from 0 through 1; never use labels, percentages, or empty values.",
      "Split or narrow multi-fact summaries when the cited anchors do not support every claim.",
      "Use participants, subject, and object only for explicitly grounded character identities; never use ?, unknown, a pronoun, or an unsupported title as an identity.",
      "A relationship endpoint is one character. Split one-to-many relationships into separate records instead of combining names into one endpoint.",
      "relationType is a closed enum defined by the story-delta contract. Never invent synonyms or alternate casing.",
      "Without page images, a standalone name, chapter title, credit, role card, or character-introduction label is not narration evidence and must not receive EVIDENCE_ROLE.",
      "Ordinary dialogue, emotions, wishes, threats, jokes, atmosphere, and repeated facts are not durable updates.",
      "A monologue may support motivation, character state, or a grounded relationship, but not an external event.",
      "Returning NO_UPDATE is correct when no durable translation-relevant change is supported.",
      "Keep summaries and values in contentLanguage. Keep enum-like relationType and attribute identifiers in English.",
      "For ja-JP, summaries and character-state values must be Japanese prose, never English prose. If uncertain, narrow the fact or reuse an evidence line.",
      "Emit at most 1 event, 2 relationships, 1 character state, and 1 open thread; this is an incremental memory update, not a chapter report.",
      `Write the final line-format result to ${outputFilePath}. Overwrite the file completely.`,
      "After writing the file successfully, reply with only: DONE",
    ],
    taskInputShape: [
      "chapterId, chapterTitle, contentLanguage, storyCues",
      "sourceNodes[].pageName, nodeId, text, textRole, styleChannel, speakerRef",
      "existingMemory.characters, terminology, relationships, events, characterStates, openThreads",
      "chapterTerminology, chapterCharacters",
    ],
    outputMode: {
      type: "line_file",
      outputFilePath,
      completionReply: "DONE",
    },
  };
}

function createChapterObservationDefinition(outputFilePath) {
  return {
    stage: "chapter_observation",
    primaryTask: "observe one complete extracted manga chapter once for reusable evidence",
    requiredSpecialistFile: "workspace/.opencode/agents/chapter-observer.md",
    supportingSpecialistFiles: [],
    requiredOutputContract: [
      "workspace/.opencode/skills/chapter-observation-contract/SKILL.md",
    ],
    forbiddenBehavior: [
      "do not translate or rewrite text",
      "do not summarize the chapter",
      "do not decide canonical terminology or durable story facts",
      "do not output JSON or markdown",
      "do not invent node ids, speakers, entities, or story cues",
    ],
    taskInstructions: [
      "Read the complete chapter input exactly once and classify every supplied node exactly once.",
      "Produce reusable structural evidence rather than separate task-specific analyses.",
      "Preserve entity surface forms exactly and cite every mention and story cue with existing pageName::nodeId keys.",
      "Use uncertain when page-image evidence would be required.",
      "Keep keys and enum values in English. Write reason in contentLanguage.",
      "Write every confidence as a decimal number from 0 through 1; never use high, medium, low, none, unknown, or percentages.",
      "speakerConfidence is numeric even when speakerType is none; it measures confidence that no speaker exists.",
      "Only emit named entities as mentions; ordinary repeated nouns are not named entities.",
      "Only emit translation-relevant story cues, not a chapter summary.",
      "Use cueType worldbuilding only for grounded setting structures or rules that can affect later translation.",
      "Emit at most 12 STORY_CUE records; this is not a chapter summary.",
      "For monologue use speakerType character or uncertain, never narrator; leave speakerRef empty unless identity is grounded.",
      `Write the final line-format result to ${outputFilePath}. Overwrite the file completely.`,
      "After writing the file successfully, reply with only: DONE",
    ],
    taskInputShape: [
      "referenceSetId, referenceKind, chapterId, chapterTitle, contentLanguage",
      "pages[].pageName, pageId, width, height",
      "pages[].nodes[].nodeId, text, readingOrder, bbox, ocrConfidence, fontHints",
      "knownCharacters, compactStoryContext",
    ],
    outputMode: {
      type: "line_file",
      outputFilePath,
      completionReply: "DONE",
    },
  };
}

function createBilingualEvidenceWindowDefinition(outputFilePath) {
  return {
    stage: "bilingual_evidence_window",
    primaryTask: "link bounded terminology or representative style evidence",
    requiredSpecialistFile: "workspace/.opencode/agents/bilingual-evidence-builder.md",
    supportingSpecialistFiles: [],
    requiredOutputContract: ["workspace/.opencode/skills/bilingual-evidence-contract/SKILL.md"],
    forbiddenBehavior: [
      "do not attempt complete dialogue alignment",
      "do not dispose context-only target candidates",
      "do not invent text or node keys",
      "do not output JSON or markdown",
    ],
    taskInstructions: [
      "Emit exactly one disposition for every supplied anchor.",
      "Use TERM_LINK for terminology anchors and STYLE_PAIR for style anchors only when evidence is direct.",
      "Use NO_MATCH conservatively when candidate text does not support the anchor.",
      "targetSurface must occur verbatim in the referenced target nodes.",
      "Write confidence as a decimal number from 0 through 1; never use labels, percentages, or empty values.",
      `Write the final result to ${outputFilePath}, then reply only DONE.`,
    ],
    taskInputShape: [
      "windowId",
      "purpose",
      "anchors[].anchorId, purpose, sourceMentionId, sourceNodeKeys, textRole, styleChannel",
      "sourceNodes[].nodeKey, text, textRole, chapterId, pageName",
      "targetNodes[].nodeKey, text, textRole, chapterId, pageName",
    ],
    outputMode: { type: "line_file", outputFilePath, completionReply: "DONE" },
  };
}

function createReferenceDeepReviewDefinition(outputFilePath) {
  return {
    stage: "reference_deep_review",
    primaryTask: "re-examine one bounded local Reference evidence window",
    requiredSpecialistFile: "workspace/.opencode/agents/reference-deep-reviewer.md",
    supportingSpecialistFiles: [],
    requiredOutputContract: ["workspace/.opencode/skills/chapter-observation-contract/SKILL.md"],
    forbiddenBehavior: [
      "do not request, infer, or reread the complete chapter",
      "do not overwrite manual or locked knowledge",
      "do not output JSON or markdown",
    ],
    taskInstructions: [
      "Address only reviewReason using supplied local nodes and compact memory.",
      "Classify every supplied node exactly once using NODE records.",
      "Cite only supplied pageName::nodeId keys in MENTION and STORY_CUE records.",
      `Write the final result to ${outputFilePath}, then reply only DONE.`,
    ],
    taskInputShape: [
      "referenceSetId, chapterId, contentLanguage, reviewReason",
      "pages[].nodes[].nodeId, text, readingOrder, existingObservation",
      "compactMemory",
    ],
    outputMode: { type: "line_file", outputFilePath, completionReply: "DONE" },
  };
}

function createQualityReviewDefinition(outputFilePath) {
  return {
    stage: "quality_review",
    primaryTask: "translation quality review and revision proposals",
    requiredSpecialistFile: "workspace/.opencode/agents/quality-optimizer.md",
    supportingSpecialistFiles: [],
    requiredOutputContract: [
      "workspace/.opencode/skills/quality-line-contract/SKILL.md",
      "workspace/.opencode/skills/quality-decision-framework/SKILL.md",
    ],
    forbiddenBehavior: [
      "do not output markdown",
      "do not emit backend actions or file-operation plans",
      "do not rewrite every line without evidence",
      "do not break locked or canonical terminology",
      "do not output JSON",
    ],
    taskInstructions: [
      "Review only the supplied candidates against the compact projected context.",
      "Complete only the supplied window purpose. Do not expand into other omitted checks or chapter-wide analysis.",
      "A candidate reason explains why a line was selected; it is not proof that the line is wrong.",
      "Use one disposition per issue or warning and at most one REVISION per node.",
      "Emit only records defined by the quality line contract. Do not emit a WINDOW header.",
      "Every translation_missing or source_target_identity candidate must end in REVISION or explicit ACCEPT|nodeId|translation_completeness|reason.",
      "Do not emit ACCEPT for representative_sample or any other non-completeness candidate.",
      "Treat sourceLanguage and targetLanguage as authoritative; ACCEPT is only for a concrete intentional retention such as a proper name, symbol, or sound effect.",
      "Preserve narration, dialogue, and monologue voices when supplied evidence supports the distinction.",
      "Escape pipe as \\|, backslash as \\\\, and line break as \\n in field values.",
      "Write Unicode characters directly; do not emit \\uXXXX escape sequences.",
      `Write the final line-format result to ${outputFilePath}. Overwrite the file completely.`,
      "After writing the file successfully, reply with only: DONE",
    ],
    taskInputShape: [
      "windowId, purpose, projectionFingerprint, translationMemoryFingerprint, languages.sourceLanguage, languages.targetLanguage",
      "context.glossary, context.story, context.style, context.localPairs, context.sequencePages[].orderedPairs",
      "candidates[].nodeId, original, currentTranslation, reasons, neighbors, textRole, styleChannel, speakerRef",
    ],
    outputMode: {
      type: "line_file",
      outputFilePath,
      completionReply: "DONE",
    },
  };
}

function createTranslationQualityObservationDefinition(outputFilePath) {
  return {
    stage: "translation_quality_observation",
    primaryTask: "fast complete source-to-target quality observation for one ordered window",
    requiredSpecialistFile: "workspace/.opencode/agents/translation-quality-observer.md",
    supportingSpecialistFiles: [],
    requiredOutputContract: [
      "workspace/.opencode/skills/translation-quality-observation-contract/SKILL.md",
    ],
    forbiddenBehavior: [
      "do not output JSON or markdown",
      "do not propose revised translations",
      "do not omit, duplicate, or reorder nodes",
      "do not perform deep analysis outside the supplied window",
    ],
    taskInstructions: [
      "Compare every ordered source and target pair exactly once.",
      "Classify only clean or suspect and use the fixed risk enums.",
      "When consecutive targets are shifted, classify every affected node and emit one SEQUENCE_RISK range.",
      "Use compactMemory only as evidence; do not expand into omitted chapter context.",
      `Write the final fixed-line result to ${outputFilePath}, then reply only DONE.`,
    ],
    taskInputShape: [
      "windowId, snapshotFingerprint, sourceLanguage, targetLanguage",
      "nodes[].nodeId, pageId, pageName, source, target, readingOrder",
      "compactMemory.glossary, compactMemory.story, compactMemory.style",
    ],
    outputMode: { type: "line_file", outputFilePath, completionReply: "DONE" },
  };
}

function createReferenceLocaleProjectionDefinition(outputFilePath) {
  return {
    stage: "reference_locale_projection",
    primaryTask: "adapt inferred Reference target renderings to the requested target locale",
    requiredSpecialistFile: "workspace/.opencode/agents/reference-locale-projector.md",
    supportingSpecialistFiles: [],
    requiredOutputContract: ["workspace/.opencode/skills/reference-locale-projection-contract/SKILL.md"],
    forbiddenBehavior: ["do not output JSON or markdown", "do not invent IDs", "do not add or remove entries"],
    taskInstructions: [
      "Project every supplied term and style example exactly once.",
      "Preserve semantic meaning and adapt only target-locale rendering.",
      `Write the fixed-line result to ${outputFilePath}, then reply only DONE.`,
    ],
    taskInputShape: ["projectionId, referenceLanguage, targetLanguage", "terms[]", "styleExamples[]"],
    outputMode: { type: "line_file", outputFilePath, completionReply: "DONE" },
  };
}

function createKnowledgeEnrichmentDefinition(outputFilePath) {
  return {
    stage: "knowledge_enrichment",
    primaryTask: "incremental long-term knowledge extraction from selected learning evidence",
    requiredSpecialistFile: "workspace/.opencode/agents/knowledge-builder.md",
    supportingSpecialistFiles: [
      "workspace/.opencode/agents/terminology-normalizer.md",
      "workspace/.opencode/agents/style-profiler.md",
    ],
    requiredOutputContract: [
      "workspace/.opencode/skills/knowledge-line-contract/SKILL.md",
      "workspace/.opencode/skills/knowledge-merge-policy/SKILL.md",
    ],
    forbiddenBehavior: [
      "do not overwrite manual or locked terminology",
      "do not convert one-off phrasing into durable global style rules",
      "do not output markdown",
      "do not output JSON",
      "do not guess unsupported character speech patterns",
    ],
    taskInstructions: [
      "Respect locked/manual glossary entries and use conservative inference.",
      "Use only learningEvidence and its selected translationPairs as the evidence layer.",
      "Do not request or infer omitted chapter text or the complete Translation Memory.",
      "Do not overwrite the existing style profile wholesale. Produce only evidence-backed incremental style conclusions.",
      "If style evidence is weak, keep styleProfile fields conservative and explain uncertainty in notes.",
      "Character speech inferences must be grounded in repeated evidence, not one-off lines.",
      "Separate dialogue style from narration style. Put narration-specific conclusions under styleProfile.narration.",
      "If narration-specific evidence exists, return it under narrationEvidence and mark narration examples with type=narration.",
      "Every confidence must be a decimal number from 0 through 1, never a label such as high, medium, or low.",
      "Escape pipe, backslash, and line breaks exactly as defined by the line contract.",
      `Write the complete fixed-line result to ${outputFilePath}, then reply only DONE.`,
    ],
    taskInputShape: [
      "learningEvidence, translationPairs, knowledgeBase",
      "existingStyleProfile, existingStyleExamples",
      "jobId, chapterId, mangaId, translatorId",
    ],
    outputMode: {
      type: "line_file",
      outputFilePath,
      completionReply: "DONE",
    },
  };
}

function createTranslationDeepAuditDefinition(outputFilePath) {
  return {
    stage: "translation_deep_audit",
    primaryTask: "complete non-blocking translation audit for one bounded window",
    requiredSpecialistFile: "workspace/.opencode/agents/quality-optimizer.md",
    supportingSpecialistFiles: [],
    requiredOutputContract: ["workspace/.opencode/skills/translation-deep-audit-contract/SKILL.md"],
    forbiddenBehavior: ["do not output JSON or markdown", "do not invent nodes", "do not rewrite acceptable lines"],
    taskInstructions: [
      "Audit every supplied candidate and emit an explicit keep or finding disposition.",
      "This is a complete review window, unlike evidence-selected Standard Quality.",
      `Write the final result to ${outputFilePath}, then reply only DONE.`,
    ],
    taskInputShape: ["windowId, snapshotFingerprint", "context", "candidates[].nodeId, original, currentTranslation, neighbors"],
    outputMode: { type: "line_file", outputFilePath, completionReply: "DONE" },
  };
}

function buildTerminologyExtractionPrompt(input, outputFilePath) {
  return buildPromptSections(
    createTerminologyExtractionDefinition(input, outputFilePath),
    input
  ).join("\n");
}

function buildChapterObservationPrompt(input, outputFilePath) {
  return buildPromptSections(
    createChapterObservationDefinition(outputFilePath),
    input
  ).join("\n");
}

function buildBilingualEvidenceWindowPrompt(input, outputFilePath) {
  const windowId = String(input?.windowId || "");
  return [
    ...buildPromptSections(createBilingualEvidenceWindowDefinition(outputFilePath), input),
    "## Exact Output Grammar For This Window",
    `The only valid windowId is: ${windowId}`,
    `TERM_LINK|${windowId}|sourceMentionId|targetSurface|targetNodeKey[,targetNodeKey]|category|confidence|reason`,
    `STYLE_PAIR|${windowId}|sourceNodeKey[,sourceNodeKey]|targetNodeKey[,targetNodeKey]|textRole|styleChannel|confidence|reason`,
    `NO_MATCH|${windowId}|anchorType|anchorId|reason`,
    `WINDOW_DONE|${windowId}`,
    "Do not omit, add, or reorder fields. sourceMentionId and anchorId are not windowId values.",
    "The final non-empty line must be WINDOW_DONE with the exact windowId above.",
  ].join("\n");
}

function buildReferenceDeepReviewPrompt(input, outputFilePath) {
  return buildPromptSections(createReferenceDeepReviewDefinition(outputFilePath), input).join("\n");
}

function buildStoryContextUpdatePrompt(input, outputFilePath) {
  return buildPromptSections(
    createStoryContextUpdateDefinition(outputFilePath),
    input
  ).join("\n");
}

function buildQualityReviewPrompt(input, outputFilePath) {
  return buildPromptSections(createQualityReviewDefinition(outputFilePath), input).join("\n");
}

function buildTranslationQualityObservationPrompt(input, outputFilePath) {
  const windowId = String(input?.windowId || "");
  return [
    ...buildPromptSections(createTranslationQualityObservationDefinition(outputFilePath), input),
    "## Exact Output Grammar For This Window",
    `The only valid windowId is: ${windowId}`,
    `NODE|${windowId}|nodeId|clean|none|confidence|reason`,
    `NODE|${windowId}|nodeId|suspect|riskType[,riskType...]|confidence|reason`,
    `SEQUENCE_RISK|${windowId}|pageName|startNodeId|endNodeId|confidence|sequence_shift|reason`,
    `WINDOW_DONE|${windowId}`,
    "Allowed records are NODE, SEQUENCE_RISK, and WINDOW_DONE only.",
    "Allowed risk types are exactly: none, empty_translation, sequence_shift, meaning_change, locked_term_violation, terminology, style, story_context, fluency.",
    "Use meaning_change for mistranslation, semantic drift, reversed agency, or changed subject/object roles. Use terminology for terminology inconsistency. Use style for character voice or register drift.",
    "Do not invent aliases such as mistranslation, semantic_drift, terminology_consistency, inconsistency, role_agency, or character_voice.",
    "A clean NODE must use only none; a suspect NODE must use one or more non-none allowed risk types.",
    "Do not emit ISSUE, WARNING, REVISION, ACCEPT, PASS, FAIL, NOTES, JSON, or markdown.",
    "Emit exactly one NODE record for every supplied node in supplied order.",
  ].join("\n");
}

function buildReferenceLocaleProjectionPrompt(input, outputFilePath) {
  return buildPromptSections(createReferenceLocaleProjectionDefinition(outputFilePath), input).join("\n");
}

function buildKnowledgeEnrichmentPrompt(input, outputFilePath = "output/knowledge_result.txt") {
  return buildPromptSections(createKnowledgeEnrichmentDefinition(outputFilePath), input).join("\n");
}

function buildTranslationDeepAuditPrompt(input, outputFilePath) {
  return buildPromptSections(createTranslationDeepAuditDefinition(outputFilePath), input).join("\n");
}

function buildTaskRequest(stage, input, options = {}) {
  if (stage === "terminology_extraction") {
    return buildTaskRequestPayload(
      createTerminologyExtractionDefinition(input, options.outputFilePath || "output/terminology_result.txt")
    );
  }
  if (stage === "chapter_observation") {
    return buildTaskRequestPayload(
      createChapterObservationDefinition(
        options.outputFilePath || "output/chapter_observation.txt"
      )
    );
  }
  if (stage === "bilingual_evidence_window") {
    return buildTaskRequestPayload(createBilingualEvidenceWindowDefinition(
      options.outputFilePath || "output/bilingual_evidence.txt"
    ));
  }
  if (stage === "reference_deep_review") {
    return buildTaskRequestPayload(createReferenceDeepReviewDefinition(
      options.outputFilePath || "output/reference_deep_review.txt"
    ));
  }
  if (stage === "story_context_update") {
    return buildTaskRequestPayload(
      createStoryContextUpdateDefinition(
        options.outputFilePath || "output/story_delta_result.txt"
      )
    );
  }
  if (stage === "quality_review") {
    return buildTaskRequestPayload(createQualityReviewDefinition(options.outputFilePath || "output/quality_result.txt"));
  }
  if (stage === "translation_quality_observation") {
    return buildTaskRequestPayload(createTranslationQualityObservationDefinition(
      options.outputFilePath || "output/translation_quality_observation.txt"
    ));
  }
  if (stage === "reference_locale_projection") {
    return buildTaskRequestPayload(createReferenceLocaleProjectionDefinition(
      options.outputFilePath || "output/reference_locale_projection.txt"
    ));
  }
  if (stage === "knowledge_enrichment") {
    return buildTaskRequestPayload(createKnowledgeEnrichmentDefinition(options.outputFilePath || "output/knowledge_result.txt"));
  }
  if (stage === "translation_deep_audit") {
    return buildTaskRequestPayload(createTranslationDeepAuditDefinition(options.outputFilePath || "output/deep_audit.txt"));
  }
  return {
    taskType: stage,
    primaryTask: stage,
    requiredSpecialistFile: null,
    supportingSpecialistFiles: [],
    requiredOutputContract: [],
    forbiddenBehavior: [],
    taskInstructions: [
      "Use input/task_input.json as the authoritative structured task input.",
    ],
    taskInputShape: [],
    outputMode: {
      type: "json_message",
    },
  };
}

module.exports = {
  buildBilingualEvidenceWindowPrompt,
  buildChapterObservationPrompt,
  buildKnowledgeEnrichmentPrompt,
  buildQualityReviewPrompt,
  buildReferenceDeepReviewPrompt,
  buildTaskRequest,
  buildTerminologyExtractionPrompt,
  buildStoryContextUpdatePrompt,
  buildTranslationDeepAuditPrompt,
  buildTranslationQualityObservationPrompt,
  buildReferenceLocaleProjectionPrompt,
};
