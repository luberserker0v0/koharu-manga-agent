const STORY_RELATIONSHIP_TERMS = [
  "父親",
  "母親",
  "爸爸",
  "媽媽",
  "哥哥",
  "姐姐",
  "弟弟",
  "妹妹",
  "丈夫",
  "妻子",
  "前夫",
  "前妻",
  "兒子",
  "女兒",
  "指南役",
  "執事",
  "領主",
  "主君",
  "家臣",
  "婚約者",
];

const ROLE_RELATION_TERMS = new Set(["指南役", "執事", "家臣", "主君", "領主", "婚約者"]);
const FAMILY_RELATION_TYPE_BY_TERM = {
  父親: "family_parent",
  母親: "family_parent",
  爸爸: "family_parent",
  媽媽: "family_parent",
  哥哥: "family_senior_sibling",
  姐姐: "family_senior_sibling",
  弟弟: "family_junior_sibling",
  妹妹: "family_junior_sibling",
  丈夫: "family_spouse",
  妻子: "family_spouse",
  前夫: "former_spouse",
  前妻: "former_spouse",
  兒子: "family_child",
  女兒: "family_child",
  婚約者: "betrothed_to",
};

const STORY_CREDIT_PATTERN =
  /(原作|漫画|作画|キャラクター原案|キャラ原案|まんが|第\s*\d+\s*話|第\d+話|話「|話『)/u;
const STORY_NOISE_PATTERN =
  /(manga\d+\.com|manhuagui|bilibili|copyright|無断転載|无断转载|掃描|扫描|翻譯組|翻译组)/iu;
const EVENT_HINT_PATTERN =
  /(支配|立ち上がり|作った|禁忌|習わし|引き受けた|失敗|借金|プレゼント|陰口|心配|来なくて済んだ|教わる|騙す|結婚|子供|家を買って)/u;
const NARRATIVE_LINE_PATTERN =
  /[。！？!?]|(して|した|された|ていた|だった|である|ない|ぬ|だな|か？|かな|わ)/u;
const LOW_SIGNAL_EVENT_PATTERN =
  /(欲しい|したい|させろ|必要ない|信用している|思い出す|確認しなければ|素晴らしい名君でした|学びたいですか|抱っこだ|失礼だぞ)/u;
const STATE_CHANGE_EVENT_PATTERN =
  /(引き受けた|失敗|到着|勧めします|任せる|解体|縮小|処刑|学んだ|入る|譲り受けた|転生|死|騙した|与える|買ってあげる|始める|開始|reveals|offers|reincarnates|dies|executes|restructure|receives|begins|enters|demolish|mass-producing|demonstrates|arrives|caused)/iu;

function resolveReferenceSourceText(textNode) {
  return String(textNode?.sourceText || textNode?.originalText || textNode?.text || "").trim();
}

function resolveReferenceTranslatedText(textNode) {
  return String(
    textNode?.translatedText || textNode?.targetText || textNode?.translation || ""
  ).trim();
}

function isNoiseReferenceLine(line) {
  const value = String(line || "").trim();
  if (!value) {
    return true;
  }
  if (/manga\d+\.com|manhuagui|bilibili|copyright/i.test(value)) {
    return true;
  }
  if (/(无断转载|無断転載|扫描|掃描|汉化|漢化|翻译组|翻譯組|仅供试看|僅供試看)/u.test(value)) {
    return true;
  }
  if (/^page\s*\d+$/iu.test(value)) {
    return true;
  }
  if (/^[\p{P}\p{S}\s_]+$/u.test(value)) {
    return true;
  }
  if (value.length <= 1) {
    return true;
  }
  if (!/[\p{L}\p{N}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)) {
    return true;
  }
  return false;
}

function collectReferenceLines(texts, { preferTranslated = true, filterNoise = false } = {}) {
  const lines = [];
  for (const page of texts.pages || []) {
    for (const textNode of page.texts || []) {
      const translatedText = resolveReferenceTranslatedText(textNode);
      const sourceText = resolveReferenceSourceText(textNode);
      const primary = preferTranslated ? translatedText || sourceText : sourceText || translatedText;
      const normalized = String(primary || "").trim();
      if (!normalized) {
        continue;
      }
      if (filterNoise && isNoiseReferenceLine(normalized)) {
        continue;
      }
      lines.push(normalized);
    }
  }
  return lines;
}

function normalizeStoryLine(line) {
  return String(line || "").replace(/\s+/g, " ").trim();
}

function isStoryContextCreditLine(line) {
  const value = normalizeStoryLine(line);
  if (!value) {
    return true;
  }
  if (STORY_NOISE_PATTERN.test(value)) {
    return true;
  }
  if (STORY_CREDIT_PATTERN.test(value) && value.length <= 160) {
    return true;
  }
  return false;
}

function buildStoryKeyLines(lines) {
  const unique = [];
  const seen = new Set();

  for (const rawLine of lines) {
    const line = normalizeStoryLine(rawLine);
    if (!line || seen.has(line) || isStoryContextCreditLine(line)) {
      continue;
    }
    if (line.length < 4) {
      continue;
    }
    seen.add(line);
    unique.push(line);
  }

  return unique
    .map((line) => {
      let score = 0;
      if (EVENT_HINT_PATTERN.test(line)) {
        score += 4;
      }
      if (NARRATIVE_LINE_PATTERN.test(line)) {
        score += 2;
      }
      if (line.length >= 12 && line.length <= 60) {
        score += 2;
      }
      if (/[一-龠ぁ-んァ-ヶ]/u.test(line)) {
        score += 1;
      }
      if (line.length > 90) {
        score -= 2;
      }
      return { line, score };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .map((entry) => entry.line);
}

function buildStoryEvents(lines) {
  return buildStoryKeyLines(lines)
    .filter((line) => EVENT_HINT_PATTERN.test(line))
    .slice(0, 4)
    .map((line) => ({ summary: line }));
}

function normalizeEventDedupKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectEventAnchors(entry) {
  const parts = [
    String(entry?.summary || "").trim(),
    String(entry?.evidenceLine || "").trim(),
    ...(Array.isArray(entry?.participants) ? entry.participants.map((value) => String(value || "").trim()) : []),
  ].filter(Boolean);
  return normalizeEventDedupKey(parts.join(" "));
}

function scoreStoryEventEntry(entry) {
  const summary = String(entry?.summary || "").trim();
  const evidenceLine = String(entry?.evidenceLine || "").trim();
  const signalText = `${summary} ${evidenceLine}`.trim();
  let score = Number.isFinite(entry?.confidence) ? entry.confidence * 10 : 6;

  if (!signalText) {
    score -= 10;
  }
  if (STATE_CHANGE_EVENT_PATTERN.test(signalText)) {
    score += 4;
  }
  if (Array.isArray(entry?.participants) && entry.participants.length > 0) {
    score += 2;
  }
  if (summary.length >= 10 && summary.length <= 90) {
    score += 1;
  }
  if (LOW_SIGNAL_EVENT_PATTERN.test(signalText)) {
    score -= 4;
  }
  if (/^[!?？！…。・\s]+$/u.test(summary) || /^[!?？！…。・\s]+$/u.test(evidenceLine)) {
    score -= 8;
  }

  return score;
}

function filterStoryEvents(entries = []) {
  const deduped = [];
  const seen = new Set();

  for (const entry of entries || []) {
    const summary = String(entry?.summary || "").trim();
    const evidenceLine = String(entry?.evidenceLine || "").trim();
    if (!summary) {
      continue;
    }
    const key = collectEventAnchors({ ...entry, summary, evidenceLine }) || `${summary}::${evidenceLine}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({
      ...entry,
      summary,
      evidenceLine,
    });
  }

  return deduped
    .map((entry) => ({ entry, score: scoreStoryEventEntry(entry) }))
    .filter(({ entry, score }) => {
      if (score < 6.5) {
        return false;
      }
      if (LOW_SIGNAL_EVENT_PATTERN.test(`${entry.summary} ${entry.evidenceLine}`) && !STATE_CHANGE_EVENT_PATTERN.test(`${entry.summary} ${entry.evidenceLine}`)) {
        return false;
      }
      return true;
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map(({ entry }) => entry);
}

function buildRelationshipFacts(lines, characterEntries, options = {}) {
  const focusCharacterName = String(
    options?.focusCharacter?.name ||
      options?.focusCharacter?.source_name ||
      options?.focusCharacter?.source_term ||
      ""
  ).trim();
  const characterMentions = (characterEntries || []).map((entry) => {
    const canonicalName = String(entry.name || entry.source_name || entry.source_term || "").trim();
    const aliases = [
      ...(Array.isArray(entry.aliases) ? entry.aliases : []),
      ...(Array.isArray(entry.title_forms) ? entry.title_forms : []),
      ...(Array.isArray(entry.titleForms) ? entry.titleForms : []),
    ]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    const patterns = [...new Set([canonicalName, ...aliases])].filter(Boolean);
    return {
      canonicalName,
      patterns,
    };
  });
  const facts = [];

  for (const rawLine of lines) {
    const line = normalizeStoryLine(rawLine);
    if (!line || isStoryContextCreditLine(line)) {
      continue;
    }

    for (const term of STORY_RELATIONSHIP_TERMS) {
      if (!line.includes(term)) {
        continue;
      }
      if (term === "丈夫" && line.includes("大丈夫")) {
        continue;
      }
      let relatedCharacters = characterMentions
        .filter((entry) => entry.patterns.some((pattern) => line.includes(pattern)))
        .map((entry) => entry.canonicalName)
        .filter(Boolean)
        .slice(0, 2);
      const relationType = ROLE_RELATION_TERMS.has(term)
        ? term === "指南役"
          ? "mentor_of"
          : term === "主君"
            ? "serves"
            : term === "領主"
              ? "has_role"
              : term === "婚約者"
                ? "betrothed_to"
                : "serves"
        : FAMILY_RELATION_TYPE_BY_TERM[term] || "related_to";
      const hasFocusTitle = /(?:領主(?:様)?|旦那様)/u.test(line);
      if (focusCharacterName && hasFocusTitle && !relatedCharacters.includes(focusCharacterName)) {
        relatedCharacters = [...relatedCharacters, focusCharacterName].slice(0, 2);
      }
      if (
        focusCharacterName &&
        relatedCharacters.length === 1 &&
        (relationType === "mentor_of" || relationType === "serves") &&
        !relatedCharacters.includes(focusCharacterName)
      ) {
        relatedCharacters = [relatedCharacters[0], focusCharacterName];
      }
      facts.push({
        term,
        relationType,
        subject: relatedCharacters[0] || null,
        object: relatedCharacters[1] || null,
        subjectCandidates: relatedCharacters.slice(0, 1),
        objectCandidates: relatedCharacters.slice(1, 2),
        summary:
          relatedCharacters.length > 0
            ? `${relatedCharacters.join(" / ")} 與「${term}」相關`
            : line,
        evidenceLine: line,
        confidence: relatedCharacters.length >= 2 ? 0.76 : relatedCharacters.length === 1 ? 0.62 : 0.48,
      });
      break;
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const fact of facts) {
    const key = `${fact.term}::${fact.summary}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(fact);
  }
  return deduped.slice(0, 6);
}

function buildStableCharacterEntries(existingGlossary, existingStoryContext) {
  const entries = [];
  const glossaryEntries = Array.isArray(existingGlossary?.entries) ? existingGlossary.entries : [];
  for (const entry of glossaryEntries) {
    if (entry?.category !== "character_name") {
      continue;
    }
    entries.push({
      name: entry.canonical_translation || entry.source_term || null,
      source_name: entry.source_term || null,
      aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
      title_forms:
        entry?.rendering_hints && Array.isArray(entry.rendering_hints.title_forms)
          ? entry.rendering_hints.title_forms
          : [],
      confidence: entry.confidence || 0.6,
    });
  }

  const globalCharacters = Array.isArray(existingStoryContext?.global?.characters)
    ? existingStoryContext.global.characters
    : [];
  for (const entry of globalCharacters) {
    entries.push({
      name: entry.name || null,
      source_name: entry.canonicalForm || null,
      aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
      title_forms: Array.isArray(entry.titleForms) ? entry.titleForms : [],
      confidence: entry.confidence || 0.6,
    });
  }

  const deduped = new Map();
  for (const entry of entries) {
    const key = String(entry.name || entry.source_name || "").trim();
    if (!key) {
      continue;
    }
    const current = deduped.get(key);
    if (!current) {
      deduped.set(key, {
        ...entry,
        aliases: [...new Set((entry.aliases || []).filter(Boolean))],
        title_forms: [...new Set((entry.title_forms || []).filter(Boolean))],
      });
      continue;
    }
    deduped.set(key, {
      ...current,
      aliases: [...new Set([...(current.aliases || []), ...(entry.aliases || [])].filter(Boolean))],
      title_forms: [
        ...new Set([...(current.title_forms || []), ...(entry.title_forms || [])].filter(Boolean)),
      ],
      confidence: Math.max(current.confidence || 0, entry.confidence || 0),
    });
  }
  return [...deduped.values()];
}

function extractNameFragments(name) {
  const value = String(name || "").trim();
  if (!value) {
    return [];
  }
  const pieces = value
    .split(/[・\s]/u)
    .map((piece) => piece.trim())
    .filter(Boolean);
  return [...new Set([value, ...pieces])];
}

function deriveHonorificAliases(lines, baseNames) {
  const aliases = new Set();
  for (const baseName of baseNames) {
    for (const rawLine of lines) {
      const line = normalizeStoryLine(rawLine);
      if (!line || !line.includes(baseName)) {
        continue;
      }
      const regex = new RegExp(`${baseName}(殿|様|さん|君|くん|ちゃん)`, "u");
      const match = line.match(regex);
      if (match) {
        aliases.add(match[0]);
      }
    }
  }
  return [...aliases];
}

function enrichChapterCharacterEntries(lines, extractedCharacterEntries, stableCharacterEntries) {
  const normalizedLines = (lines || []).map((line) => normalizeStoryLine(line)).filter(Boolean);
  const merged = new Map();

  function upsert(entry, source = "stable") {
    const name = String(entry.name || entry.source_name || entry.source_term || "").trim();
    if (!name) {
      return;
    }
    const baseNames = [
      ...extractNameFragments(name),
      ...extractNameFragments(entry.source_name || ""),
      ...extractNameFragments(entry.source_term || ""),
    ];
    const aliases = [
      ...(Array.isArray(entry.aliases) ? entry.aliases : []),
      ...(Array.isArray(entry.title_forms) ? entry.title_forms : []),
      ...(Array.isArray(entry.titleForms) ? entry.titleForms : []),
      ...deriveHonorificAliases(normalizedLines, baseNames),
    ]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    const patterns = [...new Set([...baseNames, ...aliases])];
    const mentionCount = normalizedLines.filter((line) => patterns.some((pattern) => line.includes(pattern))).length;
    if (source === "stable" && mentionCount === 0) {
      return;
    }
    const current = merged.get(name);
    const next = {
      ...entry,
      name,
      aliases: [...new Set(aliases)],
      title_forms: [...new Set(aliases.filter((value) => /[様殿さん君くんちゃん]$/u.test(value)))],
      confidence:
        source === "extracted"
          ? Math.max(entry.confidence || 0, current?.confidence || 0, 0.7)
          : Math.max(entry.confidence || 0, current?.confidence || 0, mentionCount > 1 ? 0.72 : 0.62),
      mentionCount: Math.max(current?.mentionCount || 0, mentionCount),
    };
    merged.set(name, current ? { ...current, ...next } : next);
  }

  for (const entry of stableCharacterEntries || []) {
    upsert(entry, "stable");
  }
  for (const entry of extractedCharacterEntries || []) {
    upsert(entry, "extracted");
  }

  return [...merged.values()].sort((left, right) => (right.mentionCount || 0) - (left.mentionCount || 0));
}

function resolveFocusCharacter(lines, characterEntries) {
  const normalizedLines = (lines || []).map((line) => normalizeStoryLine(line)).filter(Boolean);
  const scored = (characterEntries || [])
    .map((entry) => {
      const patterns = [
        ...extractNameFragments(entry.name || ""),
        ...extractNameFragments(entry.source_name || ""),
        ...(Array.isArray(entry.aliases) ? entry.aliases : []),
        ...(Array.isArray(entry.title_forms) ? entry.title_forms : []),
        ...(Array.isArray(entry.titleForms) ? entry.titleForms : []),
      ]
        .map((value) => String(value || "").trim())
        .filter(Boolean);
      const count = normalizedLines.filter((line) => patterns.some((pattern) => line.includes(pattern))).length;
      return { entry, count, confidence: entry.confidence || 0 };
    })
    .filter((item) => item.count > 0)
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return right.confidence - left.confidence;
    });
  return scored[0]?.entry || null;
}

function normalizeObservedMentionEntries(entries = []) {
  return (entries || [])
    .map((entry) => ({
      entityType: String(entry?.entityType || "term").trim() || "term",
      surfaceForm: String(entry?.surfaceForm || "").trim(),
      canonicalForm: String(entry?.canonicalForm || "").trim(),
      pageName: entry?.pageName || null,
      nodeId: entry?.nodeId || null,
      confidence: Number.isFinite(entry?.confidence) ? entry.confidence : 0.6,
      evidenceLine: String(entry?.evidenceLine || "").trim(),
      notes: entry?.notes || "",
      textRole: entry?.textRole || null,
      styleChannel: entry?.styleChannel || null,
      speakerRef: entry?.speakerRef || null,
    }))
    .filter((entry) => entry.surfaceForm || entry.canonicalForm || entry.evidenceLine);
}

function normalizeObservedRelationEntries(entries = []) {
  return (entries || [])
    .map((entry) => ({
      term: String(entry?.relationType || "related_to").trim() || "related_to",
      relationType: String(entry?.relationType || "related_to").trim() || "related_to",
      subject: String(entry?.subject || "").trim() || null,
      object: String(entry?.object || "").trim() || null,
      subjectCandidates: String(entry?.subject || "").trim() ? [String(entry.subject).trim()] : [],
      objectCandidates: String(entry?.object || "").trim() ? [String(entry.object).trim()] : [],
      summary:
        String(entry?.subject || "").trim() || String(entry?.object || "").trim()
          ? `${String(entry?.subject || "").trim() || "?"} / ${String(entry?.object || "").trim() || "?"} :: ${String(entry?.relationType || "related_to").trim() || "related_to"}`
          : String(entry?.evidenceLine || "").trim(),
      evidenceLine: String(entry?.evidenceLine || "").trim(),
      evidences: Array.isArray(entry?.evidences)
        ? entry.evidences
            .map((evidence) => ({
              pageName: evidence?.pageName || null,
              nodeId: evidence?.nodeId || null,
              evidenceLine: String(evidence?.evidenceLine || "").trim(),
              textRole: evidence?.textRole || null,
            }))
            .filter((evidence) => evidence.pageName && evidence.nodeId && evidence.evidenceLine)
        : [],
      confidence: Number.isFinite(entry?.confidence) ? entry.confidence : 0.6,
      notes: entry?.notes || "",
      pageName: entry?.pageName || null,
      nodeId: entry?.nodeId || null,
      textRole: entry?.textRole || null,
      styleChannel: entry?.styleChannel || null,
      speakerRef: entry?.speakerRef || null,
    }))
    .filter((entry) => entry.evidenceLine || entry.subject || entry.object);
}

function normalizeObservedEventEntries(entries = []) {
  return (entries || [])
    .map((entry) => ({
      summary: String(entry?.summary || "").trim(),
      evidenceLine: String(entry?.evidenceLine || "").trim(),
      evidences: Array.isArray(entry?.evidences)
        ? entry.evidences
            .map((evidence) => ({
              pageName: evidence?.pageName || null,
              nodeId: evidence?.nodeId || null,
              evidenceLine: String(evidence?.evidenceLine || "").trim(),
              textRole: evidence?.textRole || null,
            }))
            .filter((evidence) => evidence.pageName && evidence.nodeId && evidence.evidenceLine)
        : [],
      confidence: Number.isFinite(entry?.confidence) ? entry.confidence : 0.6,
      pageName: entry?.pageName || null,
      nodeId: entry?.nodeId || null,
      participants: Array.isArray(entry?.participants) ? entry.participants.filter(Boolean) : [],
      notes: entry?.notes || "",
      textRole: entry?.textRole || null,
      styleChannel: entry?.styleChannel || null,
      speakerRef: entry?.speakerRef || null,
    }))
    .filter((entry) => entry.summary);
}

function textLooksJapanese(value) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(String(value || ""));
}

function textLooksChinese(value) {
  return /[\p{Script=Han}]/u.test(String(value || "")) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(String(value || ""));
}

function shouldPreserveEventSummaryInLanguage(summary, contentLanguage) {
  const normalizedLanguage = String(contentLanguage || "").trim().toLowerCase();
  if (!summary) {
    return false;
  }
  if (normalizedLanguage.startsWith("ja")) {
    return textLooksJapanese(summary);
  }
  if (normalizedLanguage.startsWith("zh")) {
    return textLooksChinese(summary) || textLooksJapanese(summary);
  }
  return true;
}

function enforceStoryEventLanguage(entries = [], contentLanguage = null) {
  return (entries || []).map((entry) => {
    const summary = String(entry?.summary || "").trim();
    const evidenceLine = String(entry?.evidenceLine || "").trim();
    if (!summary) {
      return entry;
    }
    if (shouldPreserveEventSummaryInLanguage(summary, contentLanguage)) {
      return entry;
    }
    if (shouldPreserveEventSummaryInLanguage(evidenceLine, contentLanguage)) {
      return {
        ...entry,
        summary: evidenceLine,
        notes: [String(entry?.notes || "").trim(), "summary_replaced_with_evidence_due_to_language_mismatch"]
          .filter(Boolean)
          .join("; "),
      };
    }
    return {
      ...entry,
      notes: [String(entry?.notes || "").trim(), "summary_language_mismatch"]
        .filter(Boolean)
        .join("; "),
    };
  });
}

function normalizeObservedKeyLineEntries(entries = []) {
  return (entries || [])
    .map((entry) => ({
      text: String(entry?.text || "").trim(),
      kind: String(entry?.kind || "terminology").trim() || "terminology",
      confidence: Number.isFinite(entry?.confidence) ? entry.confidence : 0.6,
      pageName: entry?.pageName || null,
      nodeId: entry?.nodeId || null,
      notes: entry?.notes || "",
      textRole: entry?.textRole || null,
      styleChannel: entry?.styleChannel || null,
      speakerRef: entry?.speakerRef || null,
    }))
    .filter((entry) => entry.text);
}

function buildReferenceIngestionReport({
  referenceSetId,
  mangaId,
  translatorId,
  chapterId,
  chapterTitle,
  manifestLabel,
  useForTerminology,
  useForStyle,
  analysisDepth = "quick_read",
  rawLineCount,
  cleanLineCount,
  candidateSummary,
  referenceKind = "translator",
  glossary = null,
  candidateTerms = null,
  storyContext = null,
  styleEvidence = null,
  styleProfile = null,
  chapterObservation = null,
}) {
  const glossaryEntries = Array.isArray(glossary?.entries) ? glossary.entries : [];
  const candidateEntries = Array.isArray(candidateTerms?.entries) ? candidateTerms.entries : [];
  const storyChapters =
    storyContext?.chapters && typeof storyContext.chapters === "object"
      ? Object.entries(storyContext.chapters).map(([chapterKey, chapter]) => ({
          chapterKey,
          ...chapter,
        }))
      : [];
  const acceptedTerminology = glossaryEntries.filter((entry) => entry.category !== "character_name");
  const acceptedCharacters = glossaryEntries.filter((entry) => entry.category === "character_name");
  const candidateTerminology = candidateEntries.filter(
    (entry) => (entry.kind === "term" || entry.entity_type === "term") && entry.status === "candidate"
  );
  const candidateCharacters = candidateEntries.filter(
    (entry) =>
      (entry.kind === "character" || entry.entity_type === "character") && entry.status === "candidate"
  );
  const rejectedEntries = candidateEntries.filter((entry) => entry.status === "rejected");
  const storySummary = storyChapters.reduce(
    (summary, chapter) => {
      summary.chapters.push({
        chapterId: chapter.chapterId || null,
        referenceSetIds: Array.isArray(chapter.referenceSetIds) ? chapter.referenceSetIds : [],
        characterCount: Array.isArray(chapter.characters) ? chapter.characters.length : 0,
        terminologyCount: Array.isArray(chapter.terminology) ? chapter.terminology.length : 0,
        mentionCount: Array.isArray(chapter.mentions) ? chapter.mentions.length : 0,
        relationshipCount: Array.isArray(chapter.relationships) ? chapter.relationships.length : 0,
        eventCount: Array.isArray(chapter.events) ? chapter.events.length : 0,
        keyLineCount: Array.isArray(chapter.keyLines) ? chapter.keyLines.length : 0,
      });
      summary.mentions += Array.isArray(chapter.mentions) ? chapter.mentions.length : 0;
      summary.relationships += Array.isArray(chapter.relationships) ? chapter.relationships.length : 0;
      summary.events += Array.isArray(chapter.events) ? chapter.events.length : 0;
      summary.keyLines += Array.isArray(chapter.keyLines) ? chapter.keyLines.length : 0;
      return summary;
    },
    {
      chapters: [],
      mentions: 0,
      relationships: 0,
      events: 0,
      keyLines: 0,
    }
  );
  const styleChapterCount =
    styleEvidence?.chapters && typeof styleEvidence.chapters === "object"
      ? Object.keys(styleEvidence.chapters).length
      : 0;
  const styleChapterEntries =
    styleEvidence?.chapters && typeof styleEvidence.chapters === "object"
      ? Object.values(styleEvidence.chapters)
      : [];
  const styleDialogueSamples = styleChapterEntries.reduce((count, chapter) => {
    const samples =
      chapter && typeof chapter === "object" && Array.isArray(chapter.dialogueSamples)
        ? chapter.dialogueSamples
        : [];
    return count + samples.filter(Boolean).length;
  }, 0);
  const styleNarrationSamples = styleChapterEntries.reduce((count, chapter) => {
    const samples =
      chapter && typeof chapter === "object" && Array.isArray(chapter.narrationSamples)
        ? chapter.narrationSamples
        : [];
    return count + samples.filter(Boolean).length;
  }, 0);

  return {
    generatedAt: new Date().toISOString(),
    kind: "reference_ingestion_summary",
    referenceSetId,
    mangaId,
    translatorId: translatorId || null,
    chapterId: chapterId || null,
    chapterTitle: chapterTitle || null,
    manifestLabel: manifestLabel || null,
    referenceKind,
    useForTerminology,
    useForStyle,
    analysisDepth,
    sourceStats: {
      rawLineCount,
      cleanLineCount,
      filteredNoiseCount: Math.max(0, rawLineCount - cleanLineCount),
    },
    observationSummary: chapterObservation
      ? {
          revisionId: chapterObservation.revisionId,
          nodeCount: chapterObservation.coverage?.observedNodes || chapterObservation.nodes?.length || 0,
          mentionCount: chapterObservation.mentions?.length || 0,
          storyCueCount: chapterObservation.storyCues?.length || 0,
          coverage: chapterObservation.coverage || null,
        }
      : null,
    candidateSummary,
    latestRun: {
      referenceSetId,
      chapterId: chapterId || null,
      chapterTitle: chapterTitle || null,
      manifestLabel: manifestLabel || null,
      referenceKind,
      analysisDepth,
      sourceStats: {
        rawLineCount,
        cleanLineCount,
        filteredNoiseCount: Math.max(0, rawLineCount - cleanLineCount),
      },
      candidateSummary,
      observationRevisionId: chapterObservation?.revisionId || null,
    },
    aggregateSummary: {
      glossaryEntries: glossaryEntries.length,
      acceptedTerminology: acceptedTerminology.length,
      acceptedCharacters: acceptedCharacters.length,
      candidateTerms: candidateTerminology.length,
      candidateCharacters: candidateCharacters.length,
      rejectedEntries: rejectedEntries.length,
      storyChapters: storyChapters.length,
      storyMentions: referenceKind === "source" ? storySummary.mentions : 0,
      storyRelationships: referenceKind === "source" ? storySummary.relationships : 0,
      storyEvents: referenceKind === "source" ? storySummary.events : 0,
      storyKeyLines: referenceKind === "source" ? storySummary.keyLines : 0,
      styleEvidenceChapters: styleChapterCount,
      styleDialogueSamples,
      styleNarrationSamples,
      styleRuleKeys:
        styleProfile?.rules && typeof styleProfile.rules === "object"
          ? Object.keys(styleProfile.rules).length
          : 0,
      observationNodes: chapterObservation?.coverage?.observedNodes || chapterObservation?.nodes?.length || 0,
      observationMentions: chapterObservation?.mentions?.length || 0,
      observationStoryCues: chapterObservation?.storyCues?.length || 0,
    },
    chapterSummaries: storySummary.chapters,
  };
}

function buildStoryContextChapter(
  chapterId,
  referenceSetId,
  referenceKind,
  termEntries,
  characterEntries,
  texts,
  existingGlossary = null,
  existingStoryContext = null,
  extractedEvidence = null,
  contentLanguage = null
) {
  const lines = collectReferenceLines(texts, {
    preferTranslated: referenceKind !== "source",
    filterNoise: true,
  });
  const stableCharacterEntries = buildStableCharacterEntries(existingGlossary, existingStoryContext);
  const enrichedCharacterEntries = enrichChapterCharacterEntries(
    lines,
    characterEntries,
    stableCharacterEntries
  );
  const fallbackKeyLines = buildStoryKeyLines(lines);
  const fallbackEvents = buildStoryEvents(lines);
  const focusCharacter = resolveFocusCharacter(lines, enrichedCharacterEntries);
  const fallbackRelationships = buildRelationshipFacts(lines, enrichedCharacterEntries, {
    focusCharacter,
  });
  const observedMentions = normalizeObservedMentionEntries(extractedEvidence?.observedMentions || []);
  const observedRelations = normalizeObservedRelationEntries(extractedEvidence?.observedRelations || []);
  const observedEvents = enforceStoryEventLanguage(
    normalizeObservedEventEntries(extractedEvidence?.observedEvents || []),
    contentLanguage
  );
  const observedKeyLines = normalizeObservedKeyLineEntries(extractedEvidence?.keyLines || []);
  const hasStoryDelta = extractedEvidence?.storyDeltaApplied === true;
  const keyLines = observedKeyLines.length > 0
    ? observedKeyLines.map((entry) => entry.text)
    : hasStoryDelta ? [] : fallbackKeyLines;
  const events = filterStoryEvents(
    observedEvents.length > 0 ? observedEvents : hasStoryDelta ? [] : fallbackEvents
  );
  const relationships = observedRelations.length > 0
    ? observedRelations
    : hasStoryDelta ? [] : fallbackRelationships;

  return {
    chapterId: chapterId || null,
    referenceSetIds: [referenceSetId],
    characters: enrichedCharacterEntries.map((entry) => ({
      name: entry.name,
      entityType: entry.entity_type || "character",
      referenceKind: entry.reference_kind || referenceKind || null,
      aliases: Array.isArray(entry.aliases) ? entry.aliases.filter(Boolean) : [],
      titleForms: Array.isArray(entry.title_forms) ? entry.title_forms.filter(Boolean) : [],
      canonicalForm:
        entry.canonical_form ||
        (referenceKind === "source"
          ? entry.source_name || entry.source_term || entry.name
          : entry.source_name || entry.name),
      targetRendering:
        Object.prototype.hasOwnProperty.call(entry, "target_rendering")
          ? entry.target_rendering
          : referenceKind === "source"
            ? null
            : entry.name || null,
      confidence: entry.confidence,
    })),
    terminology: termEntries.map((entry) => ({
      term: entry.canonical_translation,
      sourceTerm: entry.source_term || null,
      entityType: entry.entity_type || "term",
      referenceKind: entry.reference_kind || null,
      canonicalForm: entry.canonical_form || entry.source_term || entry.canonical_translation || null,
      targetRendering:
        Object.prototype.hasOwnProperty.call(entry, "target_rendering") ? entry.target_rendering : null,
      category: entry.category,
      confidence: entry.confidence,
    })),
    events,
    relationships,
    keyLines,
    mentions: observedMentions,
    characterStates: Array.isArray(extractedEvidence?.characterStates)
      ? extractedEvidence.characterStates
      : [],
    openThreads: Array.isArray(extractedEvidence?.openThreads)
      ? extractedEvidence.openThreads
      : [],
    storyDeltaNotes: extractedEvidence?.storyDeltaNotes || "",
  };
}

function buildTranslatorReferenceContextChapter(
  chapterId,
  referenceSetId,
  referenceKind,
  termEntries,
  characterEntries
) {
  return {
    chapterId: chapterId || null,
    referenceSetIds: [referenceSetId],
    characters: characterEntries.map((entry) => ({
      name: entry.name,
      entityType: entry.entity_type || "character",
      referenceKind: entry.reference_kind || referenceKind || null,
      aliases: Array.isArray(entry.aliases) ? entry.aliases.filter(Boolean) : [],
      titleForms: Array.isArray(entry.title_forms) ? entry.title_forms.filter(Boolean) : [],
      canonicalForm: entry.canonical_form || entry.source_name || entry.source_term || entry.name || null,
      targetRendering:
        Object.prototype.hasOwnProperty.call(entry, "target_rendering")
          ? entry.target_rendering
          : entry.name || null,
      confidence: entry.confidence,
    })),
    terminology: termEntries.map((entry) => ({
      term: entry.canonical_translation,
      sourceTerm: entry.source_term || null,
      entityType: entry.entity_type || "term",
      referenceKind: entry.reference_kind || null,
      canonicalForm: entry.canonical_form || entry.source_term || entry.canonical_translation || null,
      targetRendering:
        Object.prototype.hasOwnProperty.call(entry, "target_rendering") ? entry.target_rendering : null,
      category: entry.category,
      confidence: entry.confidence,
    })),
    events: [],
    relationships: [],
    keyLines: [],
    mentions: [],
  };
}

module.exports = {
  buildReferenceIngestionReport,
  buildStoryContextChapter,
  buildTranslatorReferenceContextChapter,
  collectReferenceLines,
  resolveReferenceSourceText,
  resolveReferenceTranslatedText,
};
