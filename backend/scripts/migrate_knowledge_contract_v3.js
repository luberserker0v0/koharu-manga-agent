const fs = require("fs");
const path = require("path");

const { PROJECT_ROOT } = require("../src/config");

const ALLOWED_CATEGORIES = new Set([
  "character_name", "place_name", "organization_name", "title", "technique",
  "ability", "artifact", "worldbuilding", "technical_term",
]);
const CATEGORY_RENAMES = new Map([
  ["faction", "organization_name"],
  ["title_form", "title"],
]);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function mergeExamples(left = [], right = []) {
  return [...new Map([...left, ...right].map((entry) => [
    [entry.chapterId, entry.pageName, entry.nodeId, entry.translation].join("::"),
    entry,
  ])).values()];
}

function mergeCharacterGroup(entries, identityKey, targetName) {
  const preferred = entries.find((entry) => entry.locked === true || ["manual", "reference"].includes(entry.source)) || entries[0];
  const evidenceChapters = unique(entries.flatMap((entry) => entry.evidence?.chapter_ids || []));
  return {
    ...preferred,
    identity_key: identityKey,
    name: preferred.locked === true || ["manual", "reference"].includes(preferred.source) ? preferred.name : targetName,
    aliases: unique(entries.flatMap((entry) => [entry.name, ...(entry.aliases || [])]).filter((value) => value !== targetName)),
    title_forms: unique(entries.flatMap((entry) => entry.title_forms || [])),
    speech_style: unique(entries.flatMap((entry) => entry.speech_style || [])),
    sentence_ending_patterns: unique(entries.flatMap((entry) => entry.sentence_ending_patterns || [])),
    addressing_patterns: unique(entries.flatMap((entry) => entry.addressing_patterns || [])),
    example_lines: entries.reduce((result, entry) => mergeExamples(result, entry.example_lines || []), []),
    notes: unique(entries.flatMap((entry) => Array.isArray(entry.notes) ? entry.notes : [entry.notes])),
    confidence: Math.max(...entries.map((entry) => Number(entry.confidence) || 0)),
    evidence: {
      ...(preferred.evidence || {}),
      mention_count: Math.max(...entries.map((entry) => Number(entry.evidence?.mention_count) || 0)),
      chapter_ids: evidenceChapters,
      source_counts: {
        self: Math.max(...entries.map((entry) => Number(entry.evidence?.source_counts?.self) || 0)),
        reference: Math.max(...entries.map((entry) => Number(entry.evidence?.source_counts?.reference) || 0)),
      },
      high_confidence_hits: Math.max(...entries.map((entry) => Number(entry.evidence?.high_confidence_hits) || 0)),
      medium_confidence_hits: Math.max(...entries.map((entry) => Number(entry.evidence?.medium_confidence_hits) || 0)),
      score: Math.max(...entries.map((entry) => Number(entry.evidence?.score) || 0)),
    },
  };
}

function migrate(filePath) {
  const originalText = fs.readFileSync(filePath, "utf8");
  const knowledge = JSON.parse(originalText);
  const quarantined = [];
  knowledge.terminology = (knowledge.terminology || []).flatMap((entry) => {
    const category = CATEGORY_RENAMES.get(entry.category) || entry.category;
    if (!ALLOWED_CATEGORIES.has(category)) {
      quarantined.push({ ...entry, quarantineReason: `unsupported_category:${entry.category || "missing"}` });
      return [];
    }
    return [{ ...entry, category }];
  });

  const characterCanonical = new Map(
    knowledge.terminology
      .filter((entry) => entry.category === "character_name" && entry.term && entry.translation)
      .map((entry) => [entry.term, entry.translation])
  );
  const grouped = [];
  for (const character of knowledge.characters || []) {
    const match = [...characterCanonical].find(([sourceName, targetName]) =>
      [character.name, ...(character.aliases || [])].includes(sourceName) ||
      [character.name, ...(character.aliases || [])].includes(targetName)
    );
    const identityKey = match?.[0] || character.identity_key || character.name;
    const targetName = match?.[1] || character.name;
    const values = new Set([identityKey, targetName, character.name, ...(character.aliases || [])].filter(Boolean));
    const group = grouped.find((candidate) => [...candidate.values].some((value) => values.has(value)));
    if (group) {
      group.entries.push(character);
      for (const value of values) group.values.add(value);
      if (character.name !== group.identityKey && (character.aliases || []).includes(group.identityKey)) {
        group.targetName = character.name;
      }
    } else {
      grouped.push({ identityKey, targetName, values, entries: [character] });
    }
  }
  knowledge.characters = grouped.map((group) =>
    mergeCharacterGroup(group.entries, group.identityKey, group.targetName)
  );

  const pairByNode = new Map((knowledge.translation_pairs || [])
    .filter((entry) => entry.nodeId)
    .map((entry) => [entry.nodeId, entry]));
  knowledge.style_examples = (knowledge.style_examples || []).map((entry) => {
    const pair = pairByNode.get(entry.nodeId);
    if (!pair) return entry;
    return {
      ...entry,
      original: pair.original || entry.original || null,
      textRole: pair.textRole || entry.textRole || entry.type || null,
      styleChannel: pair.styleChannel || entry.styleChannel || null,
      speakerRef: (pair.textRole || entry.textRole) === "narration" ? null : pair.speakerRef || entry.speakerRef || null,
      roleConfidence: pair.roleConfidence ?? entry.roleConfidence ?? null,
      speakerConfidence: pair.speakerConfidence ?? entry.speakerConfidence ?? null,
      confidence: pair.confidence ?? entry.confidence ?? null,
    };
  });
  knowledge.metadata = {
    ...(knowledge.metadata || {}),
    knowledge_contract_version: 3,
    contract_migrated_at: new Date().toISOString(),
  };

  const timestamp = Date.now();
  const backupPath = `${filePath}.pre-contract-v3-${timestamp}.bak`;
  const quarantinePath = `${filePath}.contract-v3-quarantine-${timestamp}.json`;
  fs.writeFileSync(backupPath, originalText, "utf8");
  fs.writeFileSync(quarantinePath, JSON.stringify({ source: filePath, entries: quarantined }, null, 2), "utf8");
  fs.writeFileSync(filePath, JSON.stringify(knowledge, null, 2), "utf8");
  return {
    filePath,
    backupPath,
    quarantinePath,
    quarantined: quarantined.length,
    terminology: knowledge.terminology.length,
    characters: knowledge.characters.length,
    enrichedStyleExamples: knowledge.style_examples.filter((entry) => entry.confidence != null).length,
  };
}

const target = process.argv[2];
if (!target) throw new Error("Usage: node backend/scripts/migrate_knowledge_contract_v3.js <knowledge.json>");
const filePath = path.resolve(PROJECT_ROOT, target);
process.stdout.write(`${JSON.stringify(migrate(filePath), null, 2)}\n`);
