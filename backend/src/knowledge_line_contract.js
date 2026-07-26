const { splitEscapedLine } = require("./quality_line_contract");

const STYLE_SCOPES = new Set(["global", "narration"]);
const STYLE_RULE_KINDS = new Set(["honorific", "punctuation", "preferred", "forbidden", "note"]);
const STYLE_EXAMPLE_TYPES = new Set(["dialogue", "narration"]);

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

function parseKnowledgeEnrichmentOutput(text, input = {}) {
  const terminologyEntries = [];
  const charactersByName = new Map();
  const styleProfile = createStyleProfile();
  const styleExampleEntries = [];
  const notes = [];
  const knownNodeIds = new Set((input.learningEvidence || []).map((entry) => entry.nodeId));
  let completed = false;

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = splitEscapedLine(line);
    const kind = parts[0];
    if (kind === "TERM") {
      if (parts.length !== 6) throw new Error("TERM must contain exactly 6 fields.");
      const [, term, translation, category, confidenceText, entryNotes] = parts;
      if (!term || !translation) throw new Error("TERM requires term and translation.");
      terminologyEntries.push({
        term,
        translation,
        category: category || null,
        confidence: parseConfidence(confidenceText, "TERM"),
        notes: entryNotes || null,
      });
      continue;
    }
    if (kind === "CHARACTER") {
      if (parts.length !== 5) throw new Error("CHARACTER must contain exactly 5 fields.");
      const [, name, firstSeenChapter, confidenceText, entryNotes] = parts;
      if (!name || charactersByName.has(name)) throw new Error(`CHARACTER name must be unique and non-empty: ${name}.`);
      charactersByName.set(name, {
        name,
        aliases: [],
        title_forms: [],
        speech_style: [],
        sentence_ending_patterns: [],
        addressing_patterns: [],
        first_seen_chapter: firstSeenChapter || null,
        example_lines: [],
        confidence: parseConfidence(confidenceText, "CHARACTER"),
        notes: entryNotes || null,
      });
      continue;
    }
    if (["CHARACTER_ALIAS", "CHARACTER_TITLE", "CHARACTER_SPEECH", "CHARACTER_ENDING", "CHARACTER_ADDRESS"].includes(kind)) {
      if (parts.length !== 3) throw new Error(`${kind} must contain exactly 3 fields.`);
      const [, name, value] = parts;
      const character = charactersByName.get(name);
      if (!character) throw new Error(`${kind} references unknown character ${name}.`);
      if (!value) throw new Error(`${kind} value must not be empty.`);
      const fieldByKind = {
        CHARACTER_ALIAS: "aliases",
        CHARACTER_TITLE: "title_forms",
        CHARACTER_SPEECH: "speech_style",
        CHARACTER_ENDING: "sentence_ending_patterns",
        CHARACTER_ADDRESS: "addressing_patterns",
      };
      character[fieldByKind[kind]].push(value);
      continue;
    }
    if (kind === "CHARACTER_EXAMPLE") {
      if (parts.length !== 5) throw new Error("CHARACTER_EXAMPLE must contain exactly 5 fields.");
      const [, name, pageName, nodeId, translation] = parts;
      const character = charactersByName.get(name);
      if (!character) throw new Error(`CHARACTER_EXAMPLE references unknown character ${name}.`);
      if (!translation) throw new Error("CHARACTER_EXAMPLE translation must not be empty.");
      if (nodeId && knownNodeIds.size > 0 && !knownNodeIds.has(nodeId)) {
        throw new Error(`CHARACTER_EXAMPLE references unknown node ${nodeId}.`);
      }
      character.example_lines.push({ pageName: pageName || null, nodeId: nodeId || null, translation });
      continue;
    }
    if (kind === "STYLE_PROFILE") {
      if (parts.length !== 3) throw new Error("STYLE_PROFILE must contain exactly 3 fields.");
      styleProfile.tone = parts[1] || null;
      styleProfile.register = parts[2] || null;
      continue;
    }
    if (kind === "STYLE_NARRATION") {
      if (parts.length !== 3) throw new Error("STYLE_NARRATION must contain exactly 3 fields.");
      styleProfile.narration.tone = parts[1] || null;
      styleProfile.narration.register = parts[2] || null;
      continue;
    }
    if (kind === "STYLE_RULE") {
      if (parts.length !== 4) throw new Error("STYLE_RULE must contain exactly 4 fields.");
      const [, scope, ruleKind, value] = parts;
      if (!STYLE_SCOPES.has(scope)) throw new Error(`STYLE_RULE contains unknown scope ${scope}.`);
      if (!STYLE_RULE_KINDS.has(ruleKind)) throw new Error(`STYLE_RULE contains unknown kind ${ruleKind}.`);
      if (!value) throw new Error("STYLE_RULE value must not be empty.");
      const target = scope === "narration" ? styleProfile.narration : styleProfile;
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
      continue;
    }
    if (kind === "STYLE_EXAMPLE") {
      if (parts.length !== 6) throw new Error("STYLE_EXAMPLE must contain exactly 6 fields.");
      const [, translation, type, pageName, nodeId, reason] = parts;
      if (!translation) throw new Error("STYLE_EXAMPLE translation must not be empty.");
      if (!STYLE_EXAMPLE_TYPES.has(type)) throw new Error(`STYLE_EXAMPLE contains unknown type ${type}.`);
      if (nodeId && knownNodeIds.size > 0 && !knownNodeIds.has(nodeId)) {
        throw new Error(`STYLE_EXAMPLE references unknown node ${nodeId}.`);
      }
      styleExampleEntries.push({ translation, type, pageName: pageName || null, nodeId: nodeId || null, reason: reason || null });
      continue;
    }
    if (kind === "NOTE") {
      if (parts.length !== 2 || !parts[1]) throw new Error("NOTE must contain one non-empty value.");
      notes.push(parts[1]);
      continue;
    }
    if (kind === "KNOWLEDGE_DONE") {
      if (parts.length !== 1) throw new Error("KNOWLEDGE_DONE must not contain additional fields.");
      completed = true;
      continue;
    }
    throw new Error(`Unknown Knowledge output record ${kind}.`);
  }

  if (!completed) throw new Error("Knowledge output is missing KNOWLEDGE_DONE.");
  const characterEntries = [...charactersByName.values()];
  return {
    enrichmentMode: "incremental_line",
    translationPairs: Array.isArray(input.translationPairs) ? input.translationPairs.length : 0,
    characters: characterEntries.length,
    terminology: terminologyEntries.length,
    styleExamples: styleExampleEntries.length,
    terminologyEntries,
    characterEntries,
    styleProfile,
    styleExampleEntries,
    characterSpeechEvidence: [],
    narrationEvidence: [],
    notes: notes.join("\n"),
  };
}

module.exports = {
  STYLE_EXAMPLE_TYPES,
  STYLE_RULE_KINDS,
  STYLE_SCOPES,
  parseKnowledgeEnrichmentOutput,
};
