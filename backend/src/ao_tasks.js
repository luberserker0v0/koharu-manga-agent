const fs = require("fs");
const path = require("path");
const { config, paths } = require("./config");
const { loadAoAssets } = require("./ao_assets");
const {
  validateKnowledgeEnrichmentResult,
} = require("./ao_contracts");
const {
  parseLineBasedStoryDelta,
  validateStoryDeltaResult,
} = require("./story_delta_contract");
const {
  collectExpectedNodes: collectObservationNodes,
  parseLineBasedChapterObservation,
  validateChapterObservation,
} = require("./chapter_observation_contract");
const {
  parseBilingualEvidenceWindow,
  validateBilingualEvidenceWindow,
} = require("./bilingual_evidence_contract");
const {
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
} = require("./ao_prompt_templates");
const { parseQualityWindowOutput } = require("./quality_line_contract");
const { parseTranslationQualityObservationOutput } = require("./translation_quality_observation_contract");
const { parseDeepAuditWindowOutput } = require("./deep_audit_line_contract");
const { parseKnowledgeEnrichmentOutput } = require("./knowledge_line_contract");
const { parseReferenceLocaleProjectionOutput } = require("./reference_locale_projection_contract");

const QUALITY_OBSERVATION_RISK_ALIASES = new Map([
  ["mistranslation", "meaning_change"],
  ["semantic_drift", "meaning_change"],
  ["role_agency", "meaning_change"],
  ["terminology_consistency", "terminology"],
  ["inconsistency", "terminology"],
  ["character_voice", "style"],
]);

function canonicalizeTranslationQualityObservationOutput(text) {
  return String(text || "").split(/\r?\n/).map((line) => {
    const match = line.match(/^(NODE\|[^|]+\|[^|]+\|(?:clean|suspect)\|)([^|]+)(\|.*)$/);
    if (!match) return line;
    const risks = [...new Set(match[2].split(",").map((risk) => {
      const normalized = risk.trim();
      return QUALITY_OBSERVATION_RISK_ALIASES.get(normalized) || normalized;
    }).filter(Boolean))];
    return `${match[1]}${risks.join(",")}${match[3]}`;
  }).join("\n");
}

function uniqueStringList(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function sanitizePathSegment(value, fallback = "adhoc") {
  const normalized = String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return normalized || fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function awaitWithTimeout(promise, timeoutMs) {
  let timer = null;
  try {
    const result = await Promise.race([
      promise.then((value) => ({ timedOut: false, value })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true, value: null }), timeoutMs);
      }),
    ]);
    return result;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function buildStageRoot(jobId, stage) {
  return path.join(
    paths.workspaceRoot,
    sanitizePathSegment(jobId, "adhoc"),
    sanitizePathSegment(stage, "stage")
  );
}

function buildConversationId(stage, jobId) {
  const base = `${stage}-${jobId || "adhoc"}`.replace(/[^a-zA-Z0-9:_-]/g, "_");
  return `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeStageArtifacts(stageRoot, {
  taskType,
  taskInput,
  taskOutput,
  rawOutput = null,
  metadata = {},
  rejectedReason = null,
}) {
  ensureDir(path.join(stageRoot, "artifacts"));
  ensureDir(path.join(stageRoot, "output"));
  const taskInputPath = path.join(stageRoot, "artifacts", "task_input.json");
  fs.writeFileSync(taskInputPath, JSON.stringify(taskInput, null, 2), "utf8");
  const importManifestPath = path.join(stageRoot, "artifacts", "import_manifest.json");
  fs.writeFileSync(
    importManifestPath,
    JSON.stringify(
      {
        metadata: {
          stage: taskType,
          createdAt: new Date().toISOString(),
        },
        inputs: [
          {
            key: "task_input",
            type: "json",
            bytes: Buffer.byteLength(JSON.stringify(taskInput), "utf8"),
            path: taskInputPath,
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );

  const exportManifestPath = path.join(stageRoot, "artifacts", "export_manifest.json");
  const exportPayload = {
    metadata: {
      stage: taskType,
      createdAt: new Date().toISOString(),
      ...metadata,
    },
    accepted: [],
    rejected: [],
  };

  let rawOutputPath = null;
  if (rawOutput !== null && rawOutput !== undefined) {
    rawOutputPath = path.join(stageRoot, "artifacts", "raw_response.json");
    fs.writeFileSync(rawOutputPath, JSON.stringify(rawOutput, null, 2), "utf8");
    exportPayload.accepted.push({
      file: "artifacts/raw_response.json",
      path: rawOutputPath,
    });
  }

  if (rejectedReason) {
    exportPayload.rejected.push({
      file: "output/result.json",
      reason: rejectedReason,
    });
  } else {
    const resultPath = path.join(stageRoot, "output", "result.json");
    fs.writeFileSync(resultPath, JSON.stringify(taskOutput, null, 2), "utf8");
    exportPayload.accepted.push({
      file: "output/result.json",
      path: resultPath,
    });
  }

  fs.writeFileSync(exportManifestPath, JSON.stringify(exportPayload, null, 2), "utf8");
  return {
    taskInputPath,
    importManifestPath,
    exportManifestPath,
    rawOutputPath,
    resultPath: rejectedReason ? null : path.join(stageRoot, "output", "result.json"),
  };
}

function normalizeAoFileContent(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

function findFirstDiffIndex(left, right) {
  const max = Math.min(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    if (left[index] !== right[index]) {
      return index;
    }
  }
  return left.length === right.length ? -1 : max;
}

function buildAoFileMismatchError(filePath, expected, actual) {
  const normalizedExpected = normalizeAoFileContent(expected);
  const normalizedActual = normalizeAoFileContent(actual);
  const diffIndex = findFirstDiffIndex(normalizedExpected, normalizedActual);
  const start = Math.max(0, diffIndex - 40);
  const end = diffIndex < 0 ? 80 : diffIndex + 80;
  const expectedSlice = normalizedExpected.slice(start, end);
  const actualSlice = normalizedActual.slice(start, end);
  return new Error(
    [
      `AO file round-trip mismatch for ${filePath}.`,
      `First diff index: ${diffIndex}.`,
      `Expected slice: ${JSON.stringify(expectedSlice)}`,
      `Actual slice: ${JSON.stringify(actualSlice)}`,
    ].join(" ")
  );
}

function normalizeAoPayload(messageResponse) {
  function parseJsonCandidate(text) {
    return JSON.parse(text);
  }

  function collectJsonCandidates(text) {
    const candidates = [];
    const fencedMatches = text.match(/```(?:json)?\s*([\s\S]*?)```/gi) || [];
    for (const block of fencedMatches) {
      const inner = block.replace(/```(?:json)?\s*/i, "").replace(/```$/, "").trim();
      if (inner) {
        candidates.push(inner);
      }
    }

    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.push(text.slice(firstBrace, lastBrace + 1).trim());
    }

    candidates.push(text.trim());
    return [...new Set(candidates.filter(Boolean))];
  }

  function parseJsonText(text) {
    const candidates = collectJsonCandidates(text);
    for (const candidate of candidates) {
      try {
        return parseJsonCandidate(candidate);
      } catch {}
    }
    throw new Error("AO message response text is not valid JSON.");
  }

  if (messageResponse && typeof messageResponse === "object") {
    if (messageResponse.message && typeof messageResponse.message === "object") {
      return normalizeAoPayload(messageResponse.message);
    }
    if (Array.isArray(messageResponse.parts)) {
      const textPart = messageResponse.parts.find((part) => part.type === "text" && typeof part.text === "string");
      if (textPart) {
        return parseJsonText(textPart.text);
      }
    }
    if (typeof messageResponse.text === "string") {
      return parseJsonText(messageResponse.text);
    }
  }
  throw new Error("AO message response does not contain a JSON text payload.");
}

function extractAoText(messageResponse) {
  if (!messageResponse || typeof messageResponse !== "object") {
    return "";
  }
  if (messageResponse.message && typeof messageResponse.message === "object") {
    return extractAoText(messageResponse.message);
  }
  if (Array.isArray(messageResponse.parts)) {
    const textParts = messageResponse.parts
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text);
    if (textParts.length > 0) {
      return textParts.join("\n").trim();
    }
    const reasoningParts = messageResponse.parts
      .filter((part) => part && part.type === "reasoning" && typeof part.text === "string")
      .map((part) => part.text);
    if (reasoningParts.length > 0) {
      return reasoningParts.join("\n").trim();
    }
  }
  if (typeof messageResponse.text === "string") {
    return messageResponse.text.trim();
  }
  return "";
}

function normalizeAoTerminologyCategory(category, fallback = "general_term") {
  const normalized = String(category || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  const aliasMap = {
    character: "character_name",
    character_name: "character_name",
    person: "character_name",
    family: "family_name",
    family_name: "family_name",
    noble_house: "family_name",
    house: "family_name",
    clan: "family_name",
    school: "sword_school",
    sword_school: "sword_school",
    style: "sword_school",
    technique: "technique",
    move: "technique",
    skill: "technique",
    attack: "technique",
    technology: "device",
    tech: "device",
    machine: "device",
    gadget: "device",
    device: "device",
    item: "device",
    artifact: "device",
    faction: "organization",
    group: "organization",
    organization: "organization",
    institution: "organization",
    location: "location",
    place: "location",
    worldbuilding: "worldbuilding",
    setting: "worldbuilding",
    concept: "worldbuilding",
    relationship_term: "relationship_term",
    general_term: "general_term",
  };

  return aliasMap[normalized] || fallback;
}

function normalizeAoTerminologyCategoryForTerm(term, category, fallback = "general_term") {
  const normalizedCategory = normalizeAoTerminologyCategory(category, fallback);
  if (normalizedCategory !== "general_term") {
    return normalizedCategory;
  }

  const normalizedTerm = String(term || "").trim();
  if (!normalizedTerm) {
    return normalizedCategory;
  }

  if (
    /(文明|帝国|王国|国家|皇国|連邦|共和国|公国|王朝|宗教|神殿|魔法|呪術|呪法|技術|文化|歴史|種族|世界|宇宙|銀河|星間|時代)$/u.test(
      normalizedTerm
    )
  ) {
    return "worldbuilding";
  }

  return normalizedCategory;
}

function parseLineBasedTerminologyOutput(text) {
  const terminologyEntries = [];
  const characterEntries = [];
  const candidateEntries = [];
  const rejectedEntries = [];
  const observedMentions = [];
  const observedRelations = [];
  const observedEvents = [];
  const keyLines = [];
  const notes = [];

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("NOTES|")) {
      notes.push(line.slice("NOTES|".length).trim());
      continue;
    }

    const parts = line.split("|").map((part) => part.trim());
    const kind = parts[0];

    if (kind === "TERM" && parts.length >= 6) {
      const [, sourceTerm, canonical, category, confidenceText, reason] = parts;
      terminologyEntries.push({
        term: sourceTerm || canonical,
        source_term: sourceTerm || canonical,
        translation: canonical || sourceTerm,
        category: normalizeAoTerminologyCategoryForTerm(
          sourceTerm || canonical,
          category,
          "general_term"
        ),
        confidence: Number.parseFloat(confidenceText) || 0.6,
        notes: reason || "",
      });
      continue;
    }

    if (kind === "TERM" && parts.length >= 5) {
      const [, canonical, category, confidenceText, reason] = parts;
      terminologyEntries.push({
        term: canonical,
        source_term: canonical,
        translation: canonical,
        category: normalizeAoTerminologyCategoryForTerm(canonical, category, "general_term"),
        confidence: Number.parseFloat(confidenceText) || 0.6,
        notes: reason || "",
      });
      continue;
    }

    if (kind === "CHARACTER" && parts.length >= 6) {
      const [, sourceName, name, aliasAndTitle, confidenceText, reason] = parts;
      const aliasMatch = aliasAndTitle.match(/aliases=([^;]*)/i);
      const titleMatch = aliasAndTitle.match(/title_forms=([^;]*)/i);
      const aliases = aliasMatch
        ? aliasMatch[1]
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : [];
      const title_forms = titleMatch
        ? titleMatch[1]
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : [];
      characterEntries.push({
        name,
        source_name: sourceName || name,
        aliases,
        title_forms,
        confidence: Number.parseFloat(confidenceText) || 0.6,
        example_lines: [],
        speech_style: [],
      });
      if (reason) {
        notes.push(`CHARACTER ${name}: ${reason}`);
      }
      continue;
    }

    if (kind === "CHARACTER" && parts.length >= 5) {
      const [, name, aliasAndTitle, confidenceText, reason] = parts;
      const aliasMatch = aliasAndTitle.match(/aliases=([^;]*)/i);
      const titleMatch = aliasAndTitle.match(/title_forms=([^;]*)/i);
      const aliases = aliasMatch
        ? aliasMatch[1]
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : [];
      const title_forms = titleMatch
        ? titleMatch[1]
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : [];
      characterEntries.push({
        name,
        source_name: name,
        aliases,
        title_forms,
        confidence: Number.parseFloat(confidenceText) || 0.6,
        example_lines: [],
        speech_style: [],
      });
      if (reason) {
        notes.push(`CHARACTER ${name}: ${reason}`);
      }
      continue;
    }

    if (kind === "MENTION" && parts.length >= 8) {
      const [, entityType, surfaceForm, canonicalForm, pageName, nodeId, confidenceText, evidenceLine] = parts;
      observedMentions.push({
        entityType: String(entityType || "").trim() || "term",
        surfaceForm: surfaceForm || canonicalForm || "",
        canonicalForm: canonicalForm || surfaceForm || "",
        pageName: pageName || null,
        nodeId: nodeId || null,
        confidence: Number.parseFloat(confidenceText) || 0.6,
        evidenceLine: evidenceLine || "",
      });
      continue;
    }

    if (kind === "RELATION" && parts.length >= 9) {
      const [
        ,
        relationType,
        subject,
        object,
        pageName,
        nodeId,
        confidenceText,
        evidenceLine,
        relationNotes,
      ] = parts;
      observedRelations.push({
        relationType: relationType || "related_to",
        subject: subject || "",
        object: object || "",
        pageName: pageName || null,
        nodeId: nodeId || null,
        confidence: Number.parseFloat(confidenceText) || 0.6,
        evidenceLine: evidenceLine || "",
        notes: relationNotes || "",
      });
      continue;
    }

    if (kind === "EVENT" && parts.length >= 6) {
      const [, summary, pageName, nodeId, confidenceText, evidenceLine] = parts;
      observedEvents.push({
        summary: summary || "",
        pageName: pageName || null,
        nodeId: nodeId || null,
        confidence: Number.parseFloat(confidenceText) || 0.6,
        evidenceLine: evidenceLine || "",
      });
      continue;
    }

    if (kind === "KEYLINE" && parts.length >= 7) {
      const [, lineKind, textValue, pageName, nodeId, confidenceText, lineNotes] = parts;
      keyLines.push({
        kind: lineKind || "terminology",
        text: textValue || "",
        pageName: pageName || null,
        nodeId: nodeId || null,
        confidence: Number.parseFloat(confidenceText) || 0.6,
        notes: lineNotes || "",
      });
      continue;
    }

    if ((kind === "MAYBE" || kind === "REJECT") && parts.length >= 5) {
      const [, candidate, category, confidenceText, reason] = parts;
      const normalized = {
        kind: normalizeAoTerminologyCategory(category, "general_term") === "character_name" ? "character" : "term",
        status: kind === "REJECT" ? "rejected" : "candidate",
        candidate,
        source_term: candidate,
        canonical_translation: candidate,
        category: normalizeAoTerminologyCategoryForTerm(candidate, category, "general_term"),
        confidence_score: Number.parseFloat(confidenceText) || (kind === "REJECT" ? 0.2 : 0.55),
        reason: reason || "",
      };
      if (kind === "REJECT") {
        rejectedEntries.push(normalized);
      } else {
        candidateEntries.push(normalized);
      }
      notes.push(parts.join(" | "));
    }
  }

  return {
    enrichmentMode: "ao_line_format",
    translationPairs: 0,
    characters: characterEntries.length,
    terminology: terminologyEntries.length,
    styleExamples: 0,
    terminologyEntries,
    characterEntries,
    candidateEntries,
    rejectedEntries,
    observedMentions,
    observedRelations,
    observedEvents,
    keyLines,
    styleProfile: null,
    styleExampleEntries: [],
    notes: notes.join("\n"),
  };
}

function countCandidateMentions(candidate, translationPairs) {
  const needle = String(candidate || "").trim();
  if (!needle) {
    return 0;
  }
  return (translationPairs || []).filter((pair) =>
    String(pair.translation || pair.original || "").includes(needle)
  ).length;
}

function normalizeCandidateShape(value) {
  return String(value || "")
    .replace(/[【】*"']/g, "")
    .replace(/[．・]/g, "·")
    .replace(/耳/g, "爾")
    .replace(/費/g, "菲")
    .replace(/得/g, "德")
    .replace(/里的/g, "里爾")
    .replace(/賽菈/g, "塞拉")
    .replace(/\s+/g, "")
    .trim();
}

function collectSourceCanonicalCandidates(translationPairs) {
  const sourceText = (translationPairs || [])
    .map((pair) => String(pair.translation || pair.original || ""))
    .join("\n");
  const rawMatches = [
    ...(sourceText.match(/[\u4E00-\u9FFF]{2,12}家/g) || []),
    ...(sourceText.match(/[\u4E00-\u9FFF]{1,8}[·・．][\u4E00-\u9FFF·・．]{1,20}/g) || []),
    ...(sourceText.match(/[\u4E00-\u9FFF]{2,12}人/g) || []),
  ];
  return [...new Set(rawMatches.map((value) => value.trim()).filter(Boolean))];
}

function findBestSourceCandidate(candidate, translationPairs) {
  const normalizedCandidate = normalizeCandidateShape(candidate);
  const sourceCandidates = collectSourceCanonicalCandidates(translationPairs);
  let best = null;
  let bestScore = 0;

  for (const sourceCandidate of sourceCandidates) {
    const normalizedSource = normalizeCandidateShape(sourceCandidate);
    let score = 0;
    for (const char of normalizedCandidate) {
      if (normalizedSource.includes(char)) {
        score += 1;
      }
    }
    if (
      normalizedSource.includes(normalizedCandidate) ||
      normalizedCandidate.includes(normalizedSource)
    ) {
      score += 3;
    }
    if (score > bestScore) {
      best = sourceCandidate;
      bestScore = score;
    }
  }

  return bestScore >= 3 ? best : null;
}

function salvageTerminologyExtractionPayload(rawText, input) {
  const quotedValues = [...rawText.matchAll(/"([^"\n]{2,40})"/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  const cjkCandidates = [...new Set(
    quotedValues.filter((value) => /[\u4E00-\u9FFF]/.test(value))
  )];
  const bannedTerms = new Set([
    "爵位",
    "領地",
    "礼物",
    "禮物",
    "支援",
    "父親",
    "喜欢",
    "喜歡",
    "挑",
    "全部",
    "機器人",
    "女僕機器人",
    "??",
    "父親這是？",
  ]);
  const seenTerminology = new Set();
  const seenCharacters = new Set();

  const terminologyEntries = [];
  const characterEntries = [];

  for (const candidate of cjkCandidates) {
    if (bannedTerms.has(candidate)) {
      continue;
    }
    const canonical = findBestSourceCandidate(candidate, input.translationPairs || []) || candidate;
    const mentions = countCandidateMentions(canonical, input.translationPairs || []);
    if (canonical.includes("家") && mentions >= 2) {
      if (seenTerminology.has(canonical)) {
        continue;
      }
      seenTerminology.add(canonical);
      terminologyEntries.push({
        term: canonical,
        translation: canonical,
        category: "organization",
        confidence: 0.72,
        notes: "Salvaged from malformed AO output; repeated in the reference snippet.",
      });
      continue;
    }
    if (
      (/[·・．]/.test(canonical) || canonical.length >= 4) &&
      mentions >= 1 &&
      !/[？?！!。]/.test(canonical)
    ) {
      const cleanedName = canonical.replace(/[【】]/g, "");
      if (seenCharacters.has(cleanedName)) {
        continue;
      }
      seenCharacters.add(cleanedName);
      characterEntries.push({
        name: cleanedName,
        aliases: [],
        title_forms: [],
        confidence: mentions >= 1 ? 0.68 : 0.62,
      });
    }
  }

  return {
    enrichmentMode: "ao_salvaged",
    translationPairs: Array.isArray(input.translationPairs) ? input.translationPairs.length : 0,
    characters: characterEntries.slice(0, 3).length,
    terminology: terminologyEntries.slice(0, 3).length,
    styleExamples: 0,
    terminologyEntries: terminologyEntries.slice(0, 3),
    characterEntries: characterEntries.slice(0, 3),
    styleProfile: null,
    styleExampleEntries: [],
    notes: "Recovered conservative candidates from malformed AO JSON output.",
  };
}

function countStructuredLines(input) {
  return {
    translationPairs: Array.isArray(input.translationPairs) ? input.translationPairs.length : 0,
    sourceLines: Array.isArray(input.sourceLines) ? input.sourceLines.length : 0,
    targetLines: Array.isArray(input.targetLines) ? input.targetLines.length : 0,
  };
}

function buildTaskWorkspaceFiles(stage, input, outputFilePath = null) {
  const stagePrompt = buildTaskRequest(stage, input, {
    outputFilePath:
      outputFilePath ||
        (stage === "terminology_extraction"
          ? "output/terminology_result.txt"
          : stage === "story_context_update"
              ? "output/story_delta_result.txt"
              : null),
  });

  return [
    {
      path: "input/task_input.json",
      content: JSON.stringify(input, null, 2),
    },
    {
      path: "input/task_request.json",
      content: JSON.stringify(stagePrompt, null, 2),
    },
  ];
}

class AOTaskRunner {
  constructor({ client, assetsLoader = loadAoAssets, settings = config.agent } = {}) {
    this.client = client;
    this.assetsLoader = assetsLoader;
    this.settings = settings;
  }

  async initializeConversation(conversationId, workspaceFiles = []) {
    const created = await this.client.createConversation(conversationId);
    const assets = this.assetsLoader();

    await this.client.writeConfig(created.id, assets.opencodeConfig);
    if (assets.agentsMd) {
      await this.client.writeAgentsMd(created.id, assets.agentsMd);
    }
    for (const agentFile of assets.agentFiles) {
      await this.client.writeAgentFile(created.id, agentFile.name, agentFile.content);
    }
    for (const docFile of assets.docFiles || []) {
      await this.client.writeFile(
        created.id,
        `.opencode/docs/${docFile.path}`,
        docFile.content
      );
    }
    for (const skill of assets.skillArchives) {
      await this.client.uploadSkillZip(created.id, skill.name, skill.zipBuffer);
    }
    for (const file of workspaceFiles) {
      await this.client.writeFile(created.id, file.path, file.content);
      const roundTripFile = await this.client.readFile(created.id, file.path);
      const actualContent =
        roundTripFile && typeof roundTripFile.content === "string" ? roundTripFile.content : "";
      if (normalizeAoFileContent(actualContent) !== normalizeAoFileContent(file.content)) {
        throw buildAoFileMismatchError(file.path, file.content, actualContent);
      }
    }
    await this.client.startConversation(created.id);
    await this.client.waitUntilReady(created.id, {
      readyPollIntervalMs: this.settings.readyPollIntervalMs,
      readyTimeoutMs: this.settings.readyTimeoutMs,
    });
    return created.id;
  }

  async createTaskSession(jobId, stage = "reference_ingestion") {
    return this.initializeConversation(buildConversationId(stage, jobId));
  }

  async closeTaskSession(conversationId) {
    if (conversationId) {
      await this.client.deleteConversation(conversationId).catch(() => {});
    }
  }

  async waitForOutputFile(conversationId, outputFilePath, {
    timeoutMs = this.settings.messageTimeoutMs || 300000,
    pollIntervalMs = 1500,
    isCanceled = null,
    onProgress = null,
    heartbeatIntervalMs = 10000,
    completionPromise = null,
    completionGraceMs = 3000,
    modelSilenceTimeoutMs = Math.min(timeoutMs, 60000),
    sessionCheckIntervalMs = Math.min(10000, Math.max(1, modelSilenceTimeoutMs)),
  } = {}) {
    const startedAt = Date.now();
    let lastHeartbeatAt = 0;
    let lastError = null;
    let lastSessionCheckAt = 0;
    const completion = { settled: false, rejected: false, value: null, error: null, settledAt: 0 };
    if (completionPromise) {
      Promise.resolve(completionPromise).then((value) => {
        Object.assign(completion, { settled: true, value, settledAt: Date.now() });
      }, (error) => {
        Object.assign(completion, { settled: true, rejected: true, error, settledAt: Date.now() });
      });
    }

    while (Date.now() - startedAt < timeoutMs) {
      if (typeof isCanceled === "function" && isCanceled()) {
        throw new Error("AO task canceled by user.");
      }
      try {
        const file = await this.client.readFile(conversationId, outputFilePath);
        if (file && typeof file.content === "string" && file.content.trim().length > 0) {
          return file.content;
        }
      } catch (error) {
        lastError = error;
      }
      if (completion.rejected) {
        const messageError = new Error(`AO message failed before producing ${outputFilePath}: ${completion.error?.message || completion.error}`);
        messageError.code = "AO_MESSAGE_FAILED";
        messageError.cause = completion.error;
        throw messageError;
      }
      if (completion.settled && Date.now() - completion.settledAt >= completionGraceMs) {
        const missingError = new Error(`AO completed without writing ${outputFilePath}.`);
        missingError.code = "AO_OUTPUT_MISSING";
        missingError.messageResponse = completion.value;
        missingError.cause = lastError;
        throw missingError;
      }
      const conversation = await this.client.getConversation(conversationId);
      if (conversation.status !== "running") {
        throw new Error(
          `AO conversation ${conversationId} stopped before producing ${outputFilePath} ` +
          `(status=${conversation.status || "unknown"}, needsRestart=${conversation.needsRestart === true}).`
        );
      }
      const now = Date.now();
      if (
        typeof this.client.listSessionMessages === "function" &&
        conversation.sessionId &&
        now - lastSessionCheckAt >= sessionCheckIntervalMs
      ) {
        lastSessionCheckAt = now;
        try {
          const messagePayload = await this.client.listSessionMessages(conversationId, conversation.sessionId);
          const messages = Array.isArray(messagePayload) ? messagePayload : (messagePayload?.messages || []);
          const assistant = [...messages].reverse().find((entry) => entry?.info?.role === "assistant");
          const tokens = assistant?.info?.tokens || {};
          const tokenCount = Number(tokens.input || 0) + Number(tokens.output || 0) + Number(tokens.reasoning || 0);
          const hasParts = Array.isArray(assistant?.parts) && assistant.parts.length > 0;
          if (assistant && !hasParts && tokenCount === 0 && now - startedAt >= modelSilenceTimeoutMs) {
            const silenceError = new Error(
              `AO model produced no tokens or message parts for ${modelSilenceTimeoutMs}ms ` +
              `(conversation=${conversationId}, session=${conversation.sessionId}).`
            );
            silenceError.code = "AO_MODEL_NO_OUTPUT";
            throw silenceError;
          }
        } catch (error) {
          if (error?.code === "AO_MODEL_NO_OUTPUT") throw error;
        }
      }
      if (typeof onProgress === "function" && now - lastHeartbeatAt >= heartbeatIntervalMs) {
        lastHeartbeatAt = now;
        onProgress({
          activity: "waiting_ao_output",
          elapsedMs: now - startedAt,
          conversationStatus: conversation.status,
          ready: conversation.ready === true,
          needsRestart: conversation.needsRestart === true,
          outputFilePath,
          heartbeatAt: new Date(now).toISOString(),
        });
      }
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs > 0) await sleep(Math.min(pollIntervalMs, remainingMs));
    }

    const timeoutError = new Error(`AO did not produce ${outputFilePath} within ${timeoutMs}ms.`);
    timeoutError.code = "AO_OUTPUT_TIMEOUT";
    timeoutError.cause = lastError;
    throw timeoutError;
  }

  async repairStrictOutputFile({
    conversationId,
    stage,
    outputFilePath,
    validationError,
    invalidContent,
    input,
    validator,
    outputFileParser,
    agentName,
    isCanceled,
    onProgress,
    outputTimeoutMs = null,
  }) {
    const invalidFilePath = `${outputFilePath}.invalid`;
    await this.client.writeFile(conversationId, invalidFilePath, invalidContent || "");
    await this.client.writeFile(conversationId, outputFilePath, "");
    const stageRepairRules = stage === "bilingual_evidence_window"
      ? [
          `The only valid windowId is: ${String(input?.windowId || "")}`,
          `TERM_LINK|${String(input?.windowId || "")}|sourceMentionId|targetSurface|targetNodeKey[,targetNodeKey]|category|confidence|reason`,
          `STYLE_PAIR|${String(input?.windowId || "")}|sourceNodeKey[,sourceNodeKey]|targetNodeKey[,targetNodeKey]|textRole|styleChannel|confidence|reason`,
          `NO_MATCH|${String(input?.windowId || "")}|anchorType|anchorId|reason`,
          `WINDOW_DONE|${String(input?.windowId || "")}`,
          "Do not omit, add, or reorder fields. Do not place sourceMentionId or anchorId in the windowId field.",
          "Every anchor must have exactly one disposition, followed by WINDOW_DONE as the final non-empty line.",
        ]
      : stage.startsWith("quality_review_")
        ? [
            `The only valid windowId is: ${String(input?.windowId || "")}`,
            "Do not emit a WINDOW header or any JSON/markdown.",
            "Write real Unicode characters directly. Do not emit \\uXXXX escape sequences.",
            "Allowed records are ISSUE, WARNING, REVISION, ACCEPT, PASS, FAIL, NOTES, and WINDOW_DONE only.",
            "Every translation_missing or source_target_identity candidate requires REVISION or ACCEPT.",
            "ACCEPT|nodeId|translation_completeness|concrete reason",
            "Emit ACCEPT only for a completeness candidate; do not emit ACCEPT for representative_sample or other ordinary candidates.",
            "A keep disposition cannot be followed by REVISION for the same node.",
            `WINDOW_DONE|${String(input?.windowId || "")}`,
          ]
        : stage.startsWith("translation_quality_observation_")
          ? [
              `The only valid windowId is: ${String(input?.windowId || "")}`,
              `NODE|${String(input?.windowId || "")}|nodeId|clean|none|confidence|reason`,
              `NODE|${String(input?.windowId || "")}|nodeId|suspect|riskType[,riskType...]|confidence|reason`,
              `SEQUENCE_RISK|${String(input?.windowId || "")}|pageName|startNodeId|endNodeId|confidence|sequence_shift|reason`,
              `WINDOW_DONE|${String(input?.windowId || "")}`,
              "Allowed records are NODE, SEQUENCE_RISK, and WINDOW_DONE only. ISSUE, WARNING, REVISION, JSON, and markdown are forbidden.",
              "Allowed risk types are exactly: none, empty_translation, sequence_shift, meaning_change, locked_term_violation, terminology, style, story_context, fluency.",
              "Canonicalize semantic aliases: mistranslation and semantic_drift and role_agency become meaning_change; terminology_consistency and inconsistency become terminology; character_voice becomes style.",
              "Do not invent any other risk type. A clean NODE must use only none; a suspect NODE must not use none.",
              "Emit exactly one NODE record for every supplied node in supplied order.",
            ]
        : stage === "knowledge_enrichment"
          ? [
              "Use only records defined by the knowledge-line-contract skill.",
              "Do not emit JSON, markdown, or a completion wrapper.",
              "Only pipe, backslash, and line break may be escaped as \\|, \\\\, and \\n.",
              "Do not escape commas, semicolons, quotes, or ordinary punctuation.",
              "Write real Unicode characters directly; do not emit \\uXXXX escape sequences.",
              "The final non-empty line must be KNOWLEDGE_DONE.",
            ]
        : [];
    const repairPrompt = [
      `The ${stage} output file failed strict backend validation.`,
      `Validation error: ${validationError.message}`,
      "Repair only the contract formatting or invalid enum/value identified by the error.",
      "Do not reread the chapter, add new analysis, remove supported records, or change semantic decisions unnecessarily.",
      "Use input/task_input.json and the already uploaded specialist and SKILL.md contract as authoritative.",
      `The previous invalid output is preserved at ${invalidFilePath}.`,
      ...stageRepairRules,
      `Overwrite ${outputFilePath} completely with the corrected fixed-line output.`,
      "After writing the corrected file, reply with only: DONE",
    ].join("\n");
    const repairMessagePromise = this.client.sendMessage(conversationId, {
      text: repairPrompt,
      model: this.settings.model || null,
      agent: agentName || this.settings.agentName || null,
    });
    repairMessagePromise.catch(() => {});
    const repairedContent = await this.waitForOutputFile(conversationId, outputFilePath, {
      timeoutMs: outputTimeoutMs || this.settings.messageTimeoutMs || 300000,
      isCanceled,
      onProgress: typeof onProgress === "function"
        ? (progress) => onProgress({ ...progress, activity: "repairing_ao_output" })
        : null,
    });
    let payload;
    try {
      payload = validator(outputFileParser(repairedContent, input));
    } catch (error) {
      error.outputFileContent = repairedContent;
      throw error;
    }
    const repairCompletion = await awaitWithTimeout(
      repairMessagePromise,
      Math.min(this.settings.messageTimeoutMs || 300000, 15000)
    );
    if (repairCompletion.timedOut && typeof this.client.abortSession === "function") {
      await this.client.abortSession(conversationId).catch(() => {});
    }
    return {
      payload,
      content: repairedContent,
      message: repairCompletion.timedOut
        ? { pending: true, note: "Corrected AO output file validated before repair reply completed." }
        : repairCompletion.value,
    };
  }

  async runTask({
    jobId,
    stage,
    prompt,
    input,
    validator,
    agentName = null,
    outputFilePath = null,
    outputFileParser = null,
    conversationId = null,
    isCanceled = null,
    onProgress = null,
    outputTimeoutMs = null,
  }) {
    const requestedConversationId = conversationId || buildConversationId(stage, jobId);
    const stageRoot = buildStageRoot(jobId, stage);
    ensureDir(stageRoot);

    let activeConversationId = null;
    const ownsConversation = !conversationId;
    let rawResponse = null;
    let lastOutputFileContent = null;
    try {
      const workspaceFiles = buildTaskWorkspaceFiles(stage, input, outputFilePath);
      activeConversationId = ownsConversation
        ? await this.initializeConversation(requestedConversationId, workspaceFiles)
        : requestedConversationId;
      if (typeof isCanceled === "function" && isCanceled()) {
        throw new Error("AO task canceled by user.");
      }
      if (!ownsConversation) {
        for (const file of workspaceFiles) {
          await this.client.writeFile(activeConversationId, file.path, file.content);
          const roundTripFile = await this.client.readFile(activeConversationId, file.path);
          const actualContent =
            roundTripFile && typeof roundTripFile.content === "string" ? roundTripFile.content : "";
          if (normalizeAoFileContent(actualContent) !== normalizeAoFileContent(file.content)) {
            throw buildAoFileMismatchError(file.path, file.content, actualContent);
          }
        }
      }
      const messagePromise = this.client.sendMessage(activeConversationId, {
        text: prompt,
        model: this.settings.model || null,
        agent: agentName || this.settings.agentName || null,
      });
      messagePromise.catch(() => {});
      let payload;
      if (outputFilePath && typeof outputFileParser === "function") {
        try {
          const outputFileContent = await this.waitForOutputFile(
            activeConversationId,
            outputFilePath,
            {
              timeoutMs: outputTimeoutMs || this.settings.messageTimeoutMs || 300000,
              isCanceled,
              onProgress,
              completionPromise: messagePromise,
            }
          );
          lastOutputFileContent = outputFileContent;
          payload = validator(outputFileParser(outputFileContent, input));
          const messageCompletion = await awaitWithTimeout(
            messagePromise,
            Math.min(this.settings.messageTimeoutMs || 300000, 15000)
          );
          if (messageCompletion.timedOut && typeof this.client.abortSession === "function") {
            await this.client.abortSession(activeConversationId).catch(() => {});
          }
          rawResponse = messageCompletion.timedOut
            ? {
                pending: true,
                aborted: typeof this.client.abortSession === "function",
                note: "AO output file was valid before the message response completed.",
              }
            : messageCompletion.value;
          writeStageArtifacts(stageRoot, {
            taskType: stage,
            taskInput: input,
            taskOutput: payload,
            rawOutput: {
              message: rawResponse,
              file: {
                path: outputFilePath,
                content: outputFileContent,
              },
            },
            metadata: {
              conversationId: activeConversationId,
              normalizedBy: "output_file",
            },
          });
          return { ...payload, stageRoot, conversationId: activeConversationId };
        } catch (fileError) {
          if (typeof isCanceled === "function" && isCanceled()) {
            throw fileError;
          }
          const strictFileStages = new Set([
            "chapter_observation",
            "reference_deep_review",
            "bilingual_evidence_window",
            "story_context_update",
            "knowledge_enrichment",
          ]);
          const isStrictFileStage = strictFileStages.has(stage) ||
            stage.startsWith("quality_review_") ||
            stage.startsWith("translation_quality_observation_");
          const strictOutputStage = isStrictFileStage || stage === "reference_locale_projection";
          if (strictOutputStage) {
            if (/conversation .* stopped before producing|needsRestart=true/i.test(fileError.message || "")) {
              throw fileError;
            }
            const initialFailure = {
              outputFileError: fileError.message,
              file: outputFilePath && lastOutputFileContent != null
                ? { path: outputFilePath, content: lastOutputFileContent }
                : null,
            };
            let initialCompletion;
            try {
              initialCompletion = await awaitWithTimeout(
                messagePromise,
                Math.min(this.settings.messageTimeoutMs || 300000, 15000)
              );
            } catch (messageError) {
              initialCompletion = { timedOut: false, value: { error: messageError.message } };
            }
            if (initialCompletion.timedOut && typeof this.client.abortSession === "function") {
              await this.client.abortSession(activeConversationId).catch(() => {});
            }
            if (lastOutputFileContent == null) {
              const completedMessage = initialCompletion.timedOut ? null : initialCompletion.value;
              const responseText = extractAoText(completedMessage);
              if (responseText) {
                try {
                  payload = validator(outputFileParser(responseText, input));
                  rawResponse = {
                    message: completedMessage,
                    outputFileError: fileError.message,
                  };
                  writeStageArtifacts(stageRoot, {
                    taskType: stage,
                    taskInput: input,
                    taskOutput: payload,
                    rawOutput: rawResponse,
                    metadata: {
                      conversationId: activeConversationId,
                      normalizedBy: "message_line_fallback",
                    },
                  });
                  return { ...payload, stageRoot, conversationId: activeConversationId };
                } catch {}
              }
              rawResponse = {
                message: completedMessage,
                messagePending: initialCompletion.timedOut,
                outputFileError: fileError.message,
              };
              const missingOutputError = new Error(
                responseText
                  ? `AO completed without a valid ${outputFilePath}. Response: ${responseText.slice(0, 500)}`
                  : fileError.message
              );
              missingOutputError.code = initialCompletion.timedOut
                ? (fileError.code || "AO_OUTPUT_TIMEOUT")
                : "AO_OUTPUT_MISSING";
              throw missingOutputError;
            }
            try {
              const repaired = await this.repairStrictOutputFile({
                conversationId: activeConversationId,
                stage,
                outputFilePath,
                validationError: fileError,
                invalidContent: lastOutputFileContent,
                input,
                validator,
                outputFileParser,
                agentName,
                isCanceled,
                onProgress,
                outputTimeoutMs,
              });
              payload = repaired.payload;
              rawResponse = {
                initial: initialFailure,
                repaired: {
                  message: repaired.message,
                  file: { path: outputFilePath, content: repaired.content },
                },
              };
              writeStageArtifacts(stageRoot, {
                taskType: stage,
                taskInput: input,
                taskOutput: payload,
                rawOutput: rawResponse,
                metadata: {
                  conversationId: activeConversationId,
                  normalizedBy: "strict_output_file_repair",
                },
              });
              return { ...payload, stageRoot, conversationId: activeConversationId };
            } catch (repairError) {
              rawResponse = {
                initial: initialFailure,
                repaired: repairError.outputFileContent != null
                  ? { file: { path: outputFilePath, content: repairError.outputFileContent } }
                  : null,
                repairError: repairError.message,
              };
              throw repairError;
            }
          }
          rawResponse = await messagePromise;
          rawResponse = {
            message: rawResponse,
            outputFileError: fileError.message,
            file: outputFilePath && lastOutputFileContent != null
              ? { path: outputFilePath, content: lastOutputFileContent }
              : null,
          };
        }
      } else {
        rawResponse = await messagePromise;
      }
      try {
        payload = validator(normalizeAoPayload(rawResponse));
      } catch (firstError) {
        const rawText = extractAoText(rawResponse);
        if (stage === "terminology_extraction" && rawText) {
          try {
            const linePayload = parseLineBasedTerminologyOutput(rawText);
            Object.assign(linePayload, countStructuredLines(input));
            payload = validator(linePayload);
            writeStageArtifacts(stageRoot, {
              taskType: stage,
              taskInput: input,
              taskOutput: payload,
              rawOutput: rawResponse,
              metadata: {
                conversationId: activeConversationId,
                normalizedBy: "line_parser",
              },
            });
            return { ...payload, stageRoot, conversationId: activeConversationId };
          } catch {}
        }
        if (!rawText) {
          throw firstError;
        }
        const repairPrompt = [
          "Rewrite the previous assistant answer so it satisfies the backend JSON contract.",
          `Backend validation failure: ${firstError.message}`,
          "Do not add commentary, markdown fences, headings, or explanations.",
          "Preserve only items directly supported by the previous answer.",
          "Correct the exact invalid field names and value types identified by the validation failure.",
          "Do not preserve an invalid value merely because the JSON syntax is valid.",
          "If an optional field is uncertain, omit it or use the contract's permitted empty value instead of guessing.",
          "Return exactly one JSON object.",
          "Broken answer to repair:",
          rawText,
        ].join("\n");
        const repairedResponse = await this.client.sendMessage(activeConversationId, {
          text: repairPrompt,
          model: this.settings.model || null,
          agent: agentName || this.settings.agentName || null,
        });
        rawResponse = {
          initial: rawResponse,
          repaired: repairedResponse,
        };
        try {
          payload = validator(normalizeAoPayload(repairedResponse));
        } catch (repairError) {
          if (stage === "terminology_extraction") {
            const repairedText = extractAoText(repairedResponse);
            try {
              const linePayload = parseLineBasedTerminologyOutput(repairedText || rawText);
              Object.assign(linePayload, countStructuredLines(input));
              payload = validator(linePayload);
            } catch {
              payload = validator(
                salvageTerminologyExtractionPayload(
                  repairedText || rawText,
                  input
                )
              );
            }
          } else {
            throw repairError;
          }
        }
      }
      writeStageArtifacts(stageRoot, {
        taskType: stage,
        taskInput: input,
        taskOutput: payload,
        rawOutput: rawResponse,
        metadata: {
          conversationId: activeConversationId,
        },
      });
      return { ...payload, stageRoot, conversationId: activeConversationId };
    } catch (error) {
      writeStageArtifacts(stageRoot, {
        taskType: stage,
        taskInput: input,
        taskOutput: null,
        rawOutput: rawResponse,
        rejectedReason: error.message,
      });
      throw error;
    } finally {
      if (activeConversationId && ownsConversation) {
        await this.client.deleteConversation(activeConversationId).catch(() => {});
      }
    }
  }

  async runQualityReviewAndOptimization(input, options = {}) {
    const outputFilePath = options.outputFilePath || `output/${input.windowId || "quality"}_result.txt`;
    const prompt = buildQualityReviewPrompt(input, outputFilePath);

    return this.runTask({
      jobId: input.jobId,
      stage: `quality_review_${input.windowId || "window"}`,
      prompt,
      input,
      validator: (value) => value,
      agentName: this.settings.qualityAgentName || null,
      outputFilePath,
      outputFileParser: parseQualityWindowOutput,
      isCanceled: options.isCanceled || null,
      onProgress: options.onProgress || null,
      outputTimeoutMs: options.outputTimeoutMs || Math.min(this.settings.messageTimeoutMs || 300000, 240000),
    });
  }

  async runTranslationQualityObservationWindow(input, options = {}) {
    const outputFilePath = options.outputFilePath || `output/${input.windowId}_quality_observation.txt`;
    return this.runTask({
      jobId: input.jobId,
      stage: `translation_quality_observation_${input.windowId}`,
      prompt: buildTranslationQualityObservationPrompt(input, outputFilePath),
      input,
      validator: (value) => value,
      agentName: this.settings.qualityAgentName || null,
      outputFilePath,
      outputFileParser: (text, taskInput) => parseTranslationQualityObservationOutput(
        canonicalizeTranslationQualityObservationOutput(text),
        taskInput
      ),
      isCanceled: options.isCanceled || null,
      onProgress: options.onProgress || null,
      outputTimeoutMs: options.outputTimeoutMs || Math.min(this.settings.messageTimeoutMs || 300000, 240000),
    });
  }

  async runReferenceLocaleProjection(input, options = {}) {
    const outputFilePath = options.outputFilePath || "output/reference_locale_projection.txt";
    return this.runTask({
      jobId: input.jobId,
      stage: "reference_locale_projection",
      prompt: buildReferenceLocaleProjectionPrompt(input, outputFilePath),
      input,
      validator: (value) => value,
      agentName: this.settings.qualityAgentName || null,
      outputFilePath,
      outputFileParser: parseReferenceLocaleProjectionOutput,
      isCanceled: options.isCanceled || null,
    });
  }

  async runKnowledgeEnrichment(input) {
    const outputFilePath = "output/knowledge_result.txt";
    const prompt = buildKnowledgeEnrichmentPrompt(input, outputFilePath);

    return this.runTask({
      jobId: input.jobId,
      stage: "knowledge_enrichment",
      prompt,
      input,
      validator: validateKnowledgeEnrichmentResult,
      agentName: this.settings.knowledgeAgentName || null,
      outputFilePath,
      outputFileParser: parseKnowledgeEnrichmentOutput,
    });
  }

  async runTranslationDeepAuditWindow(input, options = {}) {
    const outputFilePath = options.outputFilePath || `output/${input.windowId}_deep_audit.txt`;
    return this.runTask({
      jobId: input.jobId,
      stage: `translation_deep_audit_${input.windowId}`,
      prompt: buildTranslationDeepAuditPrompt(input, outputFilePath),
      input,
      validator: (value) => value,
      agentName: this.settings.qualityAgentName || null,
      outputFilePath,
      outputFileParser: parseDeepAuditWindowOutput,
      isCanceled: options.isCanceled || null,
      onProgress: options.onProgress || null,
    });
  }

  async runTerminologyExtraction(input, options = {}) {
    const outputFilePath = options.outputFilePath || "output/terminology_result.txt";
    const prompt = buildTerminologyExtractionPrompt(input, outputFilePath);

    return this.runTask({
      jobId: input.jobId,
      stage: "terminology_extraction",
      prompt,
      input,
      validator: validateKnowledgeEnrichmentResult,
      agentName: this.settings.terminologyAgentName || null,
      outputFilePath,
      conversationId: options.conversationId || null,
      isCanceled: options.isCanceled || null,
      onProgress: options.onProgress || null,
      outputFileParser: (content, currentInput) => {
        const parsed = parseLineBasedTerminologyOutput(content);
        Object.assign(parsed, countStructuredLines(currentInput));
        return parsed;
      },
    });
  }

  async runChapterObservation(input, options = {}) {
    if (collectObservationNodes(input).size === 0) {
      throw new Error("Chapter observation requires at least one valid text node.");
    }
    const outputFilePath = options.outputFilePath || "output/chapter_observation.txt";
    return this.runTask({
      jobId: input.jobId,
      stage: "chapter_observation",
      prompt: buildChapterObservationPrompt(input, outputFilePath),
      input,
      validator: validateChapterObservation,
      agentName: this.settings.chapterObserverAgentName || "chapter-observer",
      outputFilePath,
      outputFileParser: parseLineBasedChapterObservation,
      conversationId: options.conversationId || null,
      isCanceled: options.isCanceled || null,
      onProgress: options.onProgress || null,
    });
  }

  async runBilingualEvidenceWindow(input, options = {}) {
    const outputFilePath = options.outputFilePath || "output/bilingual_evidence.txt";
    return this.runTask({
      jobId: input.jobId || input.windowId,
      stage: "bilingual_evidence_window",
      prompt: buildBilingualEvidenceWindowPrompt(input, outputFilePath),
      input,
      validator: validateBilingualEvidenceWindow,
      agentName: this.settings.bilingualEvidenceAgentName || "bilingual-evidence-builder",
      outputFilePath,
      outputFileParser: parseBilingualEvidenceWindow,
      conversationId: options.conversationId || null,
      isCanceled: options.isCanceled || null,
      onProgress: options.onProgress || null,
    });
  }

  async runReferenceDeepReview(input, options = {}) {
    if (collectObservationNodes(input).size === 0) {
      throw new Error("Reference deep review requires a bounded local node window.");
    }
    const outputFilePath = options.outputFilePath || "output/reference_deep_review.txt";
    return this.runTask({
      jobId: input.jobId,
      stage: "reference_deep_review",
      prompt: buildReferenceDeepReviewPrompt(input, outputFilePath),
      input,
      validator: validateChapterObservation,
      agentName: this.settings.referenceDeepReviewerAgentName || "reference-deep-reviewer",
      outputFilePath,
      outputFileParser: parseLineBasedChapterObservation,
      isCanceled: options.isCanceled || null,
      onProgress: options.onProgress || null,
    });
  }

  async runStoryContextUpdate(input, options = {}) {
    const outputFilePath = options.outputFilePath || "output/story_delta_result.txt";
    const prompt = buildStoryContextUpdatePrompt(input, outputFilePath);
    return this.runTask({
      jobId: input.jobId,
      stage: "story_context_update",
      prompt,
      input,
      validator: validateStoryDeltaResult,
      agentName: this.settings.storyContextAgentName || "story-context-builder",
      outputFilePath,
      outputFileParser: parseLineBasedStoryDelta,
      conversationId: options.conversationId || null,
      isCanceled: options.isCanceled || null,
      onProgress: options.onProgress || null,
    });
  }
}

module.exports = {
  AOTaskRunner,
  buildBilingualEvidenceWindowPrompt,
  buildChapterObservationPrompt,
  buildStageRoot,
  buildTerminologyExtractionPrompt,
  buildStoryContextUpdatePrompt,
  canonicalizeTranslationQualityObservationOutput,
  buildTaskWorkspaceFiles,
  countStructuredLines,
  uniqueStringList,
  writeStageArtifacts,
};
