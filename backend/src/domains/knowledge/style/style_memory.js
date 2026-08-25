function uniqueStringList(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value))];
}

function normalizeConfidence(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function resolvedEvidence(entries, minimumConfidence = 0.6) {
  return topEntries(entries, 3).filter(
    (entry) => normalizeConfidence(entry.confidence, 0) >= minimumConfidence
  );
}

function topEntries(entries, limit = 4, scorer = null) {
  return [...(Array.isArray(entries) ? entries : [])]
    .filter((entry) => entry && typeof entry === "object")
    .sort((left, right) => {
      const leftScore = scorer ? scorer(left) : normalizeConfidence(left.confidence, 0);
      const rightScore = scorer ? scorer(right) : normalizeConfidence(right.confidence, 0);
      return rightScore - leftScore;
    })
    .slice(0, limit);
}

function buildCharacterSpeechMemory(chapterStyleEvidence, knowledgeBase) {
  const chapterSpeech = Array.isArray(chapterStyleEvidence?.characterSpeech)
    ? chapterStyleEvidence.characterSpeech
    : [];
  const knowledgeCharacters = Array.isArray(knowledgeBase?.characters) ? knowledgeBase.characters : [];
  const merged = new Map();

  for (const entry of chapterSpeech) {
    const name = String(entry?.name || "").trim();
    if (!name) {
      continue;
    }
    merged.set(name, {
      name,
      speech_style: uniqueStringList(entry.speech_style),
      sentence_ending_patterns: uniqueStringList(entry.sentence_ending_patterns),
      addressing_patterns: uniqueStringList(entry.addressing_patterns),
      example_lines: Array.isArray(entry.example_lines) ? entry.example_lines.slice(0, 3) : [],
      confidence: normalizeConfidence(entry.confidence, 0.6),
    });
  }

  for (const entry of knowledgeCharacters) {
    const name = String(entry?.name || "").trim();
    if (!name) {
      continue;
    }
    if (
      !Array.isArray(entry.speech_style) &&
      !Array.isArray(entry.sentence_ending_patterns) &&
      !Array.isArray(entry.addressing_patterns)
    ) {
      continue;
    }
    const current = merged.get(name) || {
      name,
      speech_style: [],
      sentence_ending_patterns: [],
      addressing_patterns: [],
      example_lines: [],
      confidence: 0,
    };
    merged.set(name, {
      ...current,
      speech_style: uniqueStringList([...(current.speech_style || []), ...(entry.speech_style || [])]),
      sentence_ending_patterns: uniqueStringList([
        ...(current.sentence_ending_patterns || []),
        ...(entry.sentence_ending_patterns || []),
      ]),
      addressing_patterns: uniqueStringList([
        ...(current.addressing_patterns || []),
        ...(entry.addressing_patterns || []),
      ]),
      example_lines: [...(current.example_lines || []), ...((Array.isArray(entry.example_lines) ? entry.example_lines : []).slice(0, 3))].slice(0, 4),
      confidence: Math.max(current.confidence || 0, normalizeConfidence(entry.confidence, 0)),
    });
  }

  return topEntries([...merged.values()], 6, (entry) => {
    const featureCount =
      (entry.speech_style?.length || 0) +
      (entry.sentence_ending_patterns?.length || 0) +
      (entry.addressing_patterns?.length || 0);
    return featureCount * 0.1 + normalizeConfidence(entry.confidence, 0);
  });
}

function buildStyleMemorySnapshot({
  chapterId = null,
  styleEvidence = null,
  chapterStyleEvidence = null,
  styleProfile = null,
  storyContext = null,
  translationContext = null,
  knowledgeBase = null,
} = {}) {
  const chapterContext =
    chapterId && storyContext?.chapters && typeof storyContext.chapters === "object"
      ? storyContext.chapters[chapterId] || null
      : null;
  const translationChapterLocal =
    translationContext?.chapterLocal && typeof translationContext.chapterLocal === "object"
      ? translationContext.chapterLocal
      : null;
  const profileRules =
    styleProfile?.rules && typeof styleProfile.rules === "object" ? styleProfile.rules : {};
  const profileSamples =
    styleProfile?.samples && typeof styleProfile.samples === "object" ? styleProfile.samples : {};
  const activeChapterEvidence =
    chapterStyleEvidence && typeof chapterStyleEvidence === "object" ? chapterStyleEvidence : null;

  const registerEvidence = resolvedEvidence(activeChapterEvidence?.registerEvidence);
  const punctuationEvidence = resolvedEvidence(activeChapterEvidence?.punctuationEvidence);
  const honorificEvidence = resolvedEvidence(activeChapterEvidence?.honorificEvidence);
  const characterSpeech = buildCharacterSpeechMemory(activeChapterEvidence, knowledgeBase);
  const storyAnchors = uniqueStringList(
    (Array.isArray(chapterContext?.keyLines) ? chapterContext.keyLines : Array.isArray(translationChapterLocal?.keyLines) ? translationChapterLocal.keyLines : [])
      .map((entry) => (typeof entry === "string" ? entry : String(entry?.text || entry?.line || "")).trim())
  ).slice(0, 4);

  const dialogueExamples = uniqueStringList([
    ...(activeChapterEvidence?.dialogueSamples || []),
    ...(profileSamples.dialogue || []),
  ]).slice(0, 4);
  const narrationExamples = uniqueStringList([
    ...(activeChapterEvidence?.narrationSamples || []),
    ...(profileSamples.narration || []),
  ]).slice(0, 4);
  const honorificExamples = uniqueStringList(profileSamples.honorifics || []).slice(0, 4);

  const activeLayers = uniqueStringList([
    activeChapterEvidence ? "chapter_style_evidence" : null,
    styleEvidence ? "style_evidence" : null,
    styleProfile ? "style_profile" : null,
    characterSpeech.length > 0 ? "character_speech" : null,
    storyAnchors.length > 0 ? "story_anchors" : null,
  ]);

  return {
    chapterId: chapterId || null,
    referenceKind: activeChapterEvidence?.referenceKind || null,
    targetStyleAllowed: activeChapterEvidence?.targetStyleAllowed === true,
    activeLayers,
    register: {
      preferred: registerEvidence[0]?.register || (profileRules.register !== "unknown" ? profileRules.register : null),
      evidence: registerEvidence.map((entry) => ({
        register: entry.register || null,
        confidence: normalizeConfidence(entry.confidence, 0),
      })),
    },
    punctuation: {
      preferFullWidth:
        punctuationEvidence[0]?.preferFullWidth ??
        profileRules?.punctuation?.preferFullWidth ??
        null,
      ellipsis: profileRules?.punctuation?.ellipsis ?? null,
      quoteStyle: profileRules?.punctuation?.quoteStyle ?? null,
      evidence: punctuationEvidence.map((entry) => ({
        preferFullWidth: entry.preferFullWidth === true,
        confidence: normalizeConfidence(entry.confidence, 0),
      })),
    },
    honorifics: {
      preserveHonorifics:
        honorificEvidence[0]?.preserveHonorifics ??
        profileRules?.preserveHonorifics ??
        null,
      evidence: honorificEvidence.map((entry) => ({
        preserveHonorifics: entry.preserveHonorifics === true,
        confidence: normalizeConfidence(entry.confidence, 0),
      })),
      examples: honorificExamples,
    },
    dialogueNarration: {
      dialogueRatio:
        activeChapterEvidence?.dialogueNarrationEvidence?.[0]?.dialogueRatio ??
        profileRules?.dialogueNarration?.dialogueRatio ??
        null,
      narrationRatio:
        activeChapterEvidence?.dialogueNarrationEvidence?.[0]?.narrationRatio ??
        profileRules?.dialogueNarration?.narrationRatio ??
        null,
      dialogueExamples,
      narrationExamples,
      narrationRules:
        knowledgeBase?.style_profile?.narration && typeof knowledgeBase.style_profile.narration === "object"
          ? knowledgeBase.style_profile.narration
          : null,
    },
    characterSpeech,
    storyAnchors,
    notes: uniqueStringList([
      ...(Array.isArray(activeChapterEvidence?.notes) ? activeChapterEvidence.notes : []),
      ...(Array.isArray(knowledgeBase?.style_profile?.notes) ? knowledgeBase.style_profile.notes : []),
    ]).slice(0, 8),
    coverage: {
      chapterCount: Array.isArray(styleEvidence?.metadata?.source_chapters)
        ? styleEvidence.metadata.source_chapters.length
        : 0,
      referenceSetCount: Array.isArray(styleEvidence?.metadata?.source_reference_sets)
        ? styleEvidence.metadata.source_reference_sets.length
        : 0,
    },
  };
}

function summarizeStyleMemorySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }
  return {
    activeLayers: Array.isArray(snapshot.activeLayers) ? snapshot.activeLayers : [],
    referenceKind: snapshot.referenceKind || null,
    targetStyleAllowed: snapshot.targetStyleAllowed === true,
    preferredRegister: snapshot.register?.preferred || null,
    preserveHonorifics: snapshot.honorifics?.preserveHonorifics ?? null,
    preferFullWidth: snapshot.punctuation?.preferFullWidth ?? null,
    ellipsis: snapshot.punctuation?.ellipsis ?? null,
    quoteStyle: snapshot.punctuation?.quoteStyle ?? null,
    characterSpeechCount: Array.isArray(snapshot.characterSpeech) ? snapshot.characterSpeech.length : 0,
    storyAnchorCount: Array.isArray(snapshot.storyAnchors) ? snapshot.storyAnchors.length : 0,
    dialogueExamples: Array.isArray(snapshot.dialogueNarration?.dialogueExamples)
      ? snapshot.dialogueNarration.dialogueExamples.length
      : 0,
    narrationExamples: Array.isArray(snapshot.dialogueNarration?.narrationExamples)
      ? snapshot.dialogueNarration.narrationExamples.length
      : 0,
    coverage: snapshot.coverage || { chapterCount: 0, referenceSetCount: 0 },
  };
}

module.exports = {
  buildStyleMemorySnapshot,
  summarizeStyleMemorySnapshot,
};
