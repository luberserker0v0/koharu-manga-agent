const { splitEscapedLine } = require("./quality_line_contract");
const {
  acceptRecord,
  createSemanticCollector,
  finalizeSemanticResult,
  quarantineRecord,
} = require("./semantic_result");

const STYLE_SCOPES = new Set(["global", "narration"]);
const STYLE_RULE_KINDS = new Set(["honorific", "punctuation", "preferred", "forbidden", "note"]);
const TERMINOLOGY_CATEGORIES = new Set([
  "character_name",
  "place_name",
  "organization_name",
  "title",
  "technique",
  "ability",
  "artifact",
  "worldbuilding",
  "technical_term",
]);

function parseConfidence(value, label) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${label} confidence must be between 0 and 1.`);
  }
  return parsed;
}

function createStyleProfile() {
  return {
    tone: null,
    register: null,
    honorific_policy: [],
    punctuation_policy: [],
    preferred_patterns: [],
    forbidden_patterns: [],
    narration: {
      tone: null,
      register: null,
      preferred_patterns: [],
      forbidden_patterns: [],
      notes: [],
    },
    notes: [],
  };
}

function createState(input) {
  const evidenceByNodeId = new Map((input.learningEvidence || []).map((entry) => [entry.nodeId, entry]));
  const knownNodeIds = new Set(evidenceByNodeId.keys());
  return {
    terminologyEntries: [],
    charactersByName: new Map(),
    styleProfile: createStyleProfile(),
    styleExampleEntries: [],
    notes: [],
    evidenceByNodeId,
    knownNodeIds,
    completed: false,
  };
}

function validateNodeIds(nodeIdsText, state, owner) {
  const nodeIds = [
    ...new Set(
      nodeIdsText
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (nodeIds.length === 0 || nodeIds.some((nodeId) => !state.knownNodeIds.has(nodeId))) {
    throw new Error(`${owner} must reference only supplied evidence nodes.`);
  }
  return nodeIds;
}

function handleTerm(parts, state) {
  if (parts.length !== 7) throw new Error("TERM must contain exactly 7 fields.");
  const [, term, translation, category, nodeIdsText, confidenceText, entryNotes] = parts;
  if (!term || !translation) throw new Error("TERM requires term and translation.");
  if (!TERMINOLOGY_CATEGORIES.has(category)) throw new Error(`TERM contains unknown durable category ${category}.`);
  const nodeIds = validateNodeIds(nodeIdsText, state, `TERM ${term}`);
  const termGrounded = nodeIds.some((nodeId) => {
    const evidence = state.evidenceByNodeId.get(nodeId);
    return evidence.original.includes(term) && evidence.translation.includes(translation);
  });
  if (!termGrounded) throw new Error(`TERM ${term} -> ${translation} is not grounded in its referenced evidence.`);
  state.terminologyEntries.push({
    term,
    translation,
    category: category || null,
    evidenceNodeIds: nodeIds,
    examples: nodeIds.map((nodeId) => {
      const evidence = state.evidenceByNodeId.get(nodeId);
      return {
        pageName: evidence.pageName || null,
        nodeId,
        original: evidence.original,
        translation: evidence.translation,
        confidence: evidence.confidence,
      };
    }),
    confidence: parseConfidence(confidenceText, "TERM"),
    notes: entryNotes || null,
  });
}

function handleCharacter(parts, state) {
  if (parts.length !== 7) throw new Error("CHARACTER must contain exactly 7 fields.");
  const [, sourceName, targetName, nodeIdsText, firstSeenChapter, confidenceText, entryNotes] = parts;
  if (!sourceName || !targetName || state.charactersByName.has(sourceName)) {
    throw new Error(`CHARACTER source name must be unique and both names must be non-empty: ${sourceName}.`);
  }
  const nodeIds = validateNodeIds(nodeIdsText, state, `CHARACTER ${sourceName}`);
  if (
    !nodeIds.some((nodeId) => {
      const evidence = state.evidenceByNodeId.get(nodeId);
      return evidence.original.includes(sourceName) && evidence.translation.includes(targetName);
    })
  ) {
    throw new Error(`CHARACTER ${sourceName} -> ${targetName} is not grounded in its referenced evidence.`);
  }
  state.charactersByName.set(sourceName, {
    identity_key: sourceName,
    name: targetName,
    aliases: sourceName === targetName ? [] : [sourceName],
    title_forms: [],
    speech_style: [],
    sentence_ending_patterns: [],
    addressing_patterns: [],
    first_seen_chapter: firstSeenChapter || null,
    example_lines: [],
    confidence: parseConfidence(confidenceText, "CHARACTER"),
    notes: entryNotes || null,
    evidenceNodeIds: nodeIds,
  });
}

const CHARACTER_DETAIL_FIELDS = {
  CHARACTER_ALIAS: "aliases",
  CHARACTER_TITLE: "title_forms",
  CHARACTER_SPEECH: "speech_style",
  CHARACTER_ENDING: "sentence_ending_patterns",
  CHARACTER_ADDRESS: "addressing_patterns",
};

function handleCharacterDetail(kind, parts, state) {
  if (parts.length !== 3) throw new Error(`${kind} must contain exactly 3 fields.`);
  const [, name, value] = parts;
  const character = state.charactersByName.get(name);
  if (!character) throw new Error(`${kind} references unknown character ${name}.`);
  if (!value) throw new Error(`${kind} value must not be empty.`);
  character[CHARACTER_DETAIL_FIELDS[kind]].push(value);
}

function handleCharacterExample(parts, state) {
  if (parts.length !== 3) throw new Error("CHARACTER_EXAMPLE must contain exactly 3 fields.");
  const [, name, nodeId] = parts;
  const character = state.charactersByName.get(name);
  if (!character) throw new Error(`CHARACTER_EXAMPLE references unknown character ${name}.`);
  if (!nodeId || !state.knownNodeIds.has(nodeId)) {
    throw new Error(`CHARACTER_EXAMPLE references unknown node ${nodeId}.`);
  }
  const evidence = state.evidenceByNodeId.get(nodeId);
  character.example_lines.push({
    pageName: evidence.pageName || null,
    nodeId,
    original: evidence.original,
    translation: evidence.translation,
    textRole: evidence.textRole || null,
    styleChannel: evidence.styleChannel || null,
    speakerRef: evidence.speakerRef || null,
    confidence: evidence.confidence,
  });
}

function handleStyleProfile(parts, state) {
  if (parts.length !== 3) throw new Error("STYLE_PROFILE must contain exactly 3 fields.");
  state.styleProfile.tone = parts[1] || null;
  state.styleProfile.register = parts[2] || null;
}

function handleStyleNarration(parts, state) {
  if (parts.length !== 3) throw new Error("STYLE_NARRATION must contain exactly 3 fields.");
  state.styleProfile.narration.tone = parts[1] || null;
  state.styleProfile.narration.register = parts[2] || null;
}

function handleStyleRule(parts, state) {
  if (parts.length !== 4) throw new Error("STYLE_RULE must contain exactly 4 fields.");
  const [, scope, ruleKind, value] = parts;
  if (!STYLE_SCOPES.has(scope)) throw new Error(`STYLE_RULE contains unknown scope ${scope}.`);
  if (!STYLE_RULE_KINDS.has(ruleKind)) throw new Error(`STYLE_RULE contains unknown kind ${ruleKind}.`);
  if (!value) throw new Error("STYLE_RULE value must not be empty.");
  const target = scope === "narration" ? state.styleProfile.narration : state.styleProfile;
  const fieldByKind = {
    honorific: "honorific_policy",
    punctuation: "punctuation_policy",
    preferred: "preferred_patterns",
    forbidden: "forbidden_patterns",
    note: "notes",
  };
  const field = fieldByKind[ruleKind];
  if (!Array.isArray(target[field])) throw new Error(`STYLE_RULE ${ruleKind} is not valid for ${scope}.`);
  target[field].push(value);
}

function styleExampleType(evidence) {
  if (evidence.textRole === "narration") return "narration";
  return String(evidence.textRole || "").includes("monologue") ? "monologue" : "dialogue";
}

function buildStyleExample(evidence, nodeId, confidence, reason) {
  return {
    translation: evidence.translation,
    original: evidence.original,
    type: styleExampleType(evidence),
    textRole: evidence.textRole || null,
    styleChannel: evidence.styleChannel || null,
    speakerRef: evidence.textRole === "narration" ? null : evidence.speakerRef || null,
    roleConfidence: evidence.roleConfidence ?? null,
    speakerConfidence: evidence.speakerConfidence ?? null,
    confidence,
    pageName: evidence.pageName || null,
    nodeId,
    reason: reason || null,
  };
}

function handleStyleExample(parts, state) {
  if (parts.length !== 4) throw new Error("STYLE_EXAMPLE must contain exactly 4 fields.");
  const [, nodeId, confidenceText, reason] = parts;
  if (!nodeId || !state.knownNodeIds.has(nodeId)) {
    throw new Error(`STYLE_EXAMPLE references unknown node ${nodeId}.`);
  }
  const evidence = state.evidenceByNodeId.get(nodeId);
  if (!(evidence.reasons || []).some((value) => value === "style_evidence" || value === "speaker_evidence")) {
    throw new Error(`STYLE_EXAMPLE ${nodeId} is not designated as verified style evidence.`);
  }
  const confidence = Math.min(parseConfidence(confidenceText, "STYLE_EXAMPLE"), evidence.confidence);
  if (confidence < 0.75) throw new Error(`STYLE_EXAMPLE ${nodeId} confidence must be at least 0.75.`);
  state.styleExampleEntries.push(buildStyleExample(evidence, nodeId, confidence, reason));
}

function handleNote(parts, state) {
  if (parts.length !== 2 || !parts[1]) throw new Error("NOTE must contain one non-empty value.");
  state.notes.push(parts[1]);
}

function handleKnowledgeDone(parts, state) {
  if (parts.length !== 1) throw new Error("KNOWLEDGE_DONE must not contain additional fields.");
  state.completed = true;
}

const KNOWLEDGE_HANDLERS = {
  TERM: handleTerm,
  CHARACTER: handleCharacter,
  CHARACTER_EXAMPLE: handleCharacterExample,
  STYLE_PROFILE: handleStyleProfile,
  STYLE_NARRATION: handleStyleNarration,
  STYLE_RULE: handleStyleRule,
  STYLE_EXAMPLE: handleStyleExample,
  NOTE: handleNote,
  KNOWLEDGE_DONE: handleKnowledgeDone,
};

function processKnowledgeLine(rawLine, state) {
  const line = rawLine.trim();
  if (!line) return;
  const parts = splitEscapedLine(line);
  const kind = parts[0];
  if (Object.prototype.hasOwnProperty.call(CHARACTER_DETAIL_FIELDS, kind)) {
    handleCharacterDetail(kind, parts, state);
    return;
  }
  const handler = KNOWLEDGE_HANDLERS[kind];
  if (!handler) throw new Error(`Unknown Knowledge output record ${kind}.`);
  handler(parts, state);
}

function buildKnowledgeResult(state, input) {
  const characterEntries = [...state.charactersByName.values()];
  return {
    enrichmentMode: "incremental_line",
    translationPairs: Array.isArray(input.translationPairs) ? input.translationPairs.length : 0,
    characters: characterEntries.length,
    terminology: state.terminologyEntries.length,
    styleExamples: state.styleExampleEntries.length,
    terminologyEntries: state.terminologyEntries,
    characterEntries,
    styleProfile: state.styleProfile,
    styleExampleEntries: state.styleExampleEntries,
    characterSpeechEvidence: [], narrationEvidence: [], notes: state.notes.join("\n"),
  };
}

function parseKnowledgeEnrichmentOutputStrict(text, input = {}) {
  const state = createState(input);
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    processKnowledgeLine(rawLine, state);
  }
  if (!state.completed) throw new Error("Knowledge output is missing KNOWLEDGE_DONE.");
  return buildKnowledgeResult(state, input);
}

function parseKnowledgeEnrichmentOutput(text, input = {}) {
  const lines = String(text || "").split(/\r?\n/);
  const completed = lines.some((rawLine) => rawLine.trim() === "KNOWLEDGE_DONE");
  if (!completed) {
    const error = new Error("Knowledge output is missing KNOWLEDGE_DONE.");
    error.code = "AO_OUTPUT_INCOMPLETE";
    throw error;
  }
  const collector = createSemanticCollector();
  const acceptedLines = [];
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (!line || line === "KNOWLEDGE_DONE") continue;
    try {
      parseKnowledgeEnrichmentOutputStrict([...acceptedLines, line, "KNOWLEDGE_DONE"].join("\n"), input);
      acceptedLines.push(line);
      acceptRecord(collector);
    } catch (error) {
      quarantineRecord(collector, {
        lineNumber: index + 1,
        raw: rawLine,
        kind: line.split("|", 1)[0] || null,
        reason: error.message,
      });
    }
  }
  const result = parseKnowledgeEnrichmentOutputStrict([...acceptedLines, "KNOWLEDGE_DONE"].join("\n"), input);
  return { ...result, semanticResult: finalizeSemanticResult(collector) };
}

module.exports = {
  STYLE_RULE_KINDS,
  STYLE_SCOPES,
  TERMINOLOGY_CATEGORIES,
  parseKnowledgeEnrichmentOutput,
  parseKnowledgeEnrichmentOutputStrict,
};
