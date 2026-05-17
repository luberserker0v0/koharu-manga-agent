#!/usr/bin/env node

/**
 * build_knowledge_base.js
 * 分析翻譯對照，提取術語、角色名、風格，建立知識庫。
 *
 * 用法:
 *   node build_knowledge_base.js --input ./knowledge_base/self/my-manga.json [--base-url http://127.0.0.1:9999]
 */

const fs = require("fs");
const path = require("path");
const config = require("../../shared/config");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { input: config.PATHS.KNOWLEDGE_BASE, baseUrl: config.DEFAULT_BASE_URL };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && args[i + 1]) opts.input = args[++i];
    else if (args[i] === "--base-url" && args[i + 1]) opts.baseUrl = args[++i].replace(/\/+$/, "");
  }
  return opts;
}

function extractCharacters(pairs) {
  const charMap = {};
  const namePatterns = [
    /([一-龯]{2,4})さん$/, /([一-龯]{2,4})くん$/, /([一-龯]{2,4})ちゃん$/,
    /([A-Z][a-z]+)さん$/, /([A-Z][a-z]+)くん$/,
  ];

  for (const pair of pairs) {
    for (const pattern of namePatterns) {
      const match = pair.original.match(pattern);
      if (match) {
        const name = match[1];
        if (!charMap[name]) {
          charMap[name] = { translations: new Set(), context_notes: "" };
        }
        charMap[name].translations.add(pair.translation);
      }
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
    { original: /横領/, translation: "挪用公款", contexts: ["公司", "職場"] },
    { original: /クビ/, translation: "開除", contexts: ["解僱"] },
    { original: /就職/, translation: "工作", contexts: ["日常"] },
    { original: /結婚/, translation: "結婚", contexts: ["日常"] },
    { original: /借金/, translation: "債務", contexts: ["財務"] },
    { original: /浮気/, translation: "出軌", contexts: ["感情"] },
  ];

  for (const pair of pairs) {
    for (const term of commonTerms) {
      if (term.original.test(pair.original)) {
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
  }
  return termMap;
}

function extractStyleProfile(pairs) {
  const firstPerson = new Set();
  const sentenceEndings = [];

  for (const pair of pairs) {
    const fpMatch = pair.translation.match(/^(我|本人|俺|私)/);
    if (fpMatch) firstPerson.add(fpMatch[1]);

    if (pair.translation.endsWith("了")) sentenceEndings.push("了");
    if (pair.translation.endsWith("呢")) sentenceEndings.push("呢");
    if (pair.translation.endsWith("吧")) sentenceEndings.push("吧");
    if (pair.translation.endsWith("啊")) sentenceEndings.push("啊");
    if (pair.translation.endsWith("！")) sentenceEndings.push("！");
    if (pair.translation.endsWith("...") || pair.translation.endsWith("……")) sentenceEndings.push("省略");
  }

  const mostCommonEnding = sentenceEndings.length > 0
    ? sentenceEndings.sort((a, b) => sentenceEndings.filter(v => v === b).length - sentenceEndings.filter(v => v === a).length)[0]
    : "無明顯模式";

  return {
    tone: "口語化，保留情感表達",
    first_person: [...firstPerson].join("/") || "我",
    sentence_ending: mostCommonEnding,
    honorifics: "依情境保留或轉換為中文敬語",
    naming_convention: "角色名保留原文漢字，不音譯",
  };
}

function extractStyleExamples(pairs) {
  const patterns = [];

  const grammarPatterns = [
    { pattern: /〜てきた/, translation: "活過來了/下來了", note: "表示持續狀態的變化" },
    { pattern: /〜ている/, translation: "正在/著", note: "進行式" },
    { pattern: /〜ない/, translation: "不/沒", note: "否定" },
    { pattern: /〜た/, translation: "了", note: "過去式" },
    { pattern: /〜だろう/, translation: "吧", note: "推測" },
  ];

  for (const pair of pairs) {
    for (const gp of grammarPatterns) {
      if (gp.pattern.test(pair.original)) {
        patterns.push({
          pattern: gp.pattern.source,
          translation_pattern: gp.translation,
          note: gp.note,
        });
      }
    }
  }

  const seen = new Set();
  return patterns.filter(p => {
    const key = p.pattern + p.translation_pattern;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main() {
  const opts = parseArgs();
  if (!opts.input || !fs.existsSync(opts.input)) {
    console.error(JSON.stringify({ success: false, error: "找不到輸入檔案" }));
    process.exit(1);
  }

  const kb = JSON.parse(fs.readFileSync(opts.input, "utf-8"));
  const pairs = kb.translation_pairs || [];

  if (pairs.length === 0) {
    console.log(JSON.stringify({ success: true, message: "無翻譯對照可分析" }));
    process.exit(0);
  }

  console.error(`🔍 正在分析 ${pairs.length} 筆翻譯對照...`);

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

  console.log(JSON.stringify({
    success: true,
    characters: Object.keys(kb.characters).length,
    terminology: Object.keys(kb.terminology).length,
    style_examples: kb.style_examples.length,
    output: opts.input,
  }, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
