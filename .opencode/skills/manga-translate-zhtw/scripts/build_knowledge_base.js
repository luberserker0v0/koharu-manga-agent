#!/usr/bin/env node

/**
 * build_knowledge_base.js
 * Analyze collected translation pairs and enrich the knowledge base with
 * characters, terminology, and style hints.
 *
 * Usage:
 *   node build_knowledge_base.js --input ./knowledge_base/self/my-manga.json [--base-url http://127.0.0.1:9999]
 */

const fs = require("fs");
const config = require("../lib/config");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    input: config.PATHS.KNOWLEDGE_BASE,
    baseUrl: config.DEFAULT_BASE_URL,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && args[i + 1]) {
      opts.input = args[++i];
    } else if (args[i] === "--base-url" && args[i + 1]) {
      opts.baseUrl = args[++i].replace(/\/+$/, "");
    }
  }

  return opts;
}

function extractCharacters(pairs) {
  const charMap = {};
  const namePatterns = [
    /([^\s]{2,4})さん$/,
    /([^\s]{2,4})ちゃん$/,
    /([^\s]{2,4})～+$/,
    /([A-Z][a-z]+)さん$/,
    /([A-Z][a-z]+)ちゃん$/,
  ];

  for (const pair of pairs) {
    for (const pattern of namePatterns) {
      const match = pair.original.match(pattern);
      if (!match) {
        continue;
      }

      const name = match[1];
      if (!charMap[name]) {
        charMap[name] = { translations: new Set(), context_notes: "" };
      }
      charMap[name].translations.add(pair.translation);
    }
  }

  const result = {};
  for (const [name, data] of Object.entries(charMap)) {
    result[name] = {
      translations: [...data.translations],
      context_notes: data.context_notes,
    };
  }

  return result;
}

function extractTerminology(pairs) {
  const termMap = {};
  const commonTerms = [
    { original: /先輩/, contexts: ["school", "relationship"] },
    { original: /部活/, contexts: ["school"] },
    { original: /文化祭/, contexts: ["school"] },
    { original: /委員長/, contexts: ["school"] },
    { original: /先生/, contexts: ["title"] },
    { original: /魔王/, contexts: ["fantasy"] },
  ];

  for (const pair of pairs) {
    for (const term of commonTerms) {
      if (!term.original.test(pair.original)) {
        continue;
      }

      const key = pair.original.trim();
      if (!termMap[key]) {
        termMap[key] = {
          translation: pair.translation,
          contexts: term.contexts,
          alternatives: [],
          preferred: pair.translation,
        };
      }
    }
  }

  return termMap;
}

function extractStyleProfile(pairs) {
  const firstPerson = new Set();
  const sentenceEndings = [];

  for (const pair of pairs) {
    const fpMatch = pair.translation.match(/^(我|俺|咱|本小姐)/);
    if (fpMatch) {
      firstPerson.add(fpMatch[1]);
    }

    if (pair.translation.endsWith("嗎")) sentenceEndings.push("嗎");
    if (pair.translation.endsWith("呢")) sentenceEndings.push("呢");
    if (pair.translation.endsWith("啊")) sentenceEndings.push("啊");
    if (pair.translation.endsWith("吧")) sentenceEndings.push("吧");
    if (pair.translation.endsWith("喔")) sentenceEndings.push("喔");
    if (
      pair.translation.endsWith("...") ||
      pair.translation.endsWith("……")
    ) {
      sentenceEndings.push("ellipsis");
    }
  }

  const mostCommonEnding =
    sentenceEndings.length > 0
      ? sentenceEndings.sort(
          (a, b) =>
            sentenceEndings.filter((value) => value === b).length -
            sentenceEndings.filter((value) => value === a).length
        )[0]
      : "neutral";

  return {
    tone: "casual spoken Traditional Chinese",
    first_person: [...firstPerson].join("/") || "unknown",
    sentence_ending: mostCommonEnding,
    honorifics: "preserve contextual honorific usage when needed",
    naming_convention: "prefer consistent Taiwanese Traditional Chinese naming",
  };
}

function extractStyleExamples(pairs) {
  const patterns = [];
  const grammarPatterns = [
    {
      pattern: /じゃない/,
      translation: "negative emphasis",
      note: "Preserve spoken negative tone.",
    },
    {
      pattern: /だよ/,
      translation: "assertive casual ending",
      note: "Keep a direct spoken rhythm.",
    },
    {
      pattern: /です/,
      translation: "polite register",
      note: "Keep formal tone when context needs it.",
    },
    {
      pattern: /なあ/,
      translation: "soft trailing ending",
      note: "Preserve reflective mood.",
    },
    {
      pattern: /よね/,
      translation: "agreement-seeking ending",
      note: "Keep conversational agreement tone.",
    },
  ];

  for (const pair of pairs) {
    for (const grammarPattern of grammarPatterns) {
      if (!grammarPattern.pattern.test(pair.original)) {
        continue;
      }

      patterns.push({
        pattern: grammarPattern.pattern.source,
        translation_pattern: grammarPattern.translation,
        note: grammarPattern.note,
      });
    }
  }

  const seen = new Set();
  return patterns.filter((pattern) => {
    const key = `${pattern.pattern}:${pattern.translation_pattern}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function main() {
  const opts = parseArgs();
  if (!opts.input || !fs.existsSync(opts.input)) {
    console.error(
      JSON.stringify({ success: false, error: "Knowledge base input not found" })
    );
    process.exit(1);
  }

  const kb = JSON.parse(fs.readFileSync(opts.input, "utf-8"));
  const pairs = kb.translation_pairs || [];

  if (pairs.length === 0) {
    console.log(
      JSON.stringify({
        success: true,
        message: "No translation pairs found. Nothing to analyze.",
      })
    );
    process.exit(0);
  }

  console.error(`Analyzing ${pairs.length} translation pairs...`);

  const characters = extractCharacters(pairs);
  const terminology = extractTerminology(pairs);
  const styleProfile = extractStyleProfile(pairs);
  const styleExamples = extractStyleExamples(pairs);

  kb.characters = { ...kb.characters, ...characters };
  kb.terminology = { ...kb.terminology, ...terminology };
  kb.style_profile = { ...kb.style_profile, ...styleProfile };
  kb.style_examples = [...(kb.style_examples || []), ...styleExamples];
  kb.updated_at = new Date().toISOString();

  fs.writeFileSync(opts.input, JSON.stringify(kb, null, 2));

  console.log(
    JSON.stringify(
      {
        success: true,
        characters: Object.keys(kb.characters).length,
        terminology: Object.keys(kb.terminology).length,
        style_examples: kb.style_examples.length,
        output: opts.input,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
