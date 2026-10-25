function uniqueStringList(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value))];
}

function normalizeConfidence(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function resolvedEvidence(entries, minimumConfidence = 0.6) {
  return topEntries(entries, 3).filter((entry) => normalizeConfidence(entry.confidence, 0) >= minimumConfidence);
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

function createChapterSpeechEntry(entry) {
  const name = String(entry?.name || "").trim();
  if (!name) return null;
  return {
    name,
    speech_style: uniqueStringList(entry.speech_style),
    sentence_ending_patterns: uniqueStringList(entry.sentence_ending_patterns),
    addressing_patterns: uniqueStringList(entry.addressing_patterns),
    example_lines: Array.isArray(entry.example_lines) ? entry.example_lines.slice(0, 3) : [],
    confidence: normalizeConfidence(entry.confidence, 0.6),
  };
}

function scoreCharacterSpeech(entry) {
  const featureCount =
    (entry.speech_style?.length || 0) +
    (entry.sentence_ending_patterns?.length || 0) +
    (entry.addressing_patterns?.length || 0);
  return featureCount * 0.1 + normalizeConfidence(entry.confidence, 0);
}

function hasCharacterSpeechEvidence(entry) {
  return (
    Array.isArray(entry?.speech_style) ||
    Array.isArray(entry?.sentence_ending_patterns) ||
    Array.isArray(entry?.addressing_patterns)
  );
}

function emptyCharacterSpeech(name) {
  return {
    name,
    speech_style: [],
    sentence_ending_patterns: [],
    addressing_patterns: [],
    example_lines: [],
    confidence: 0,
  };
}

function mergeCharacterSpeechValues(current, entry) {
  return {
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
    example_lines: [...(current.example_lines || []), ...(entry.example_lines || []).slice(0, 3)].slice(0, 4),
    confidence: Math.max(current.confidence || 0, normalizeConfidence(entry.confidence, 0)),
  };
}

function mergeKnowledgeCharacter(merged, entry) {
  const name = String(entry?.name || "").trim();
  if (!name || !hasCharacterSpeechEvidence(entry)) return;
  const current = merged.get(name) || emptyCharacterSpeech(name);
  merged.set(name, {
    ...mergeCharacterSpeechValues(current, {
      ...entry,
      example_lines: Array.isArray(entry.example_lines) ? entry.example_lines : [],
    }),
  });
}

function buildCharacterSpeechMemory(chapterStyleEvidence, knowledgeBase) {
  const chapterSpeech = Array.isArray(chapterStyleEvidence?.characterSpeech)
    ? chapterStyleEvidence.characterSpeech
    : [];
  const knowledgeCharacters = Array.isArray(knowledgeBase?.characters) ? knowledgeBase.characters : [];
  const merged = new Map();
  for (const entry of chapterSpeech) {
    const created = createChapterSpeechEntry(entry);
    if (created) merged.set(created.name, created);
  }
  for (const entry of knowledgeCharacters) {
    mergeKnowledgeCharacter(merged, entry);
  }
  return topEntries([...merged.values()], 6, scoreCharacterSpeech);
}

function chapterContextFor(chapterId, storyContext) {
  return chapterId && storyContext?.chapters && typeof storyContext.chapters === "object"
    ? storyContext.chapters[chapterId] || null
    : null;
}

function translationChapterLocalFor(translationContext) {
  return translationContext?.chapterLocal && typeof translationContext.chapterLocal === "object"
    ? translationContext.chapterLocal
    : null;
}

function profileRulesOf(styleProfile) {
  return styleProfile?.rules && typeof styleProfile.rules === "object" ? styleProfile.rules : {};
}

function profileSamplesOf(styleProfile) {
  return styleProfile?.samples && typeof styleProfile.samples === "object" ? styleProfile.samples : {};
}

function activeChapterEvidenceOf(chapterStyleEvidence) {
  return chapterStyleEvidence && typeof chapterStyleEvidence === "object" ? chapterStyleEvidence : null;
}

function buildStoryAnchors(chapterContext, translationChapterLocal) {
  const source = Array.isArray(chapterContext?.keyLines)
    ? chapterContext.keyLines
    : Array.isArray(translationChapterLocal?.keyLines)
      ? translationChapterLocal.keyLines
      : [];
  return uniqueStringList(
    source.map((entry) => (typeof entry === "string" ? entry : String(entry?.text || entry?.line || "")).trim()),
  ).slice(0, 4);
}

function buildActiveLayers(activeChapterEvidence, styleEvidence, styleProfile, characterSpeech, storyAnchors) {
  return uniqueStringList([
    activeChapterEvidence ? "chapter_style_evidence" : null,
    styleEvidence ? "style_evidence" : null,
    styleProfile ? "style_profile" : null,
    characterSpeech.length > 0 ? "character_speech" : null,
    storyAnchors.length > 0 ? "story_anchors" : null,
  ]);
}

function buildRegisterSection(registerEvidence, profileRules) {
  return {
    preferred: registerEvidence[0]?.register || (profileRules.register !== "unknown" ? profileRules.register : null),
    evidence: registerEvidence.map((entry) => ({
      register: entry.register || null,
      confidence: normalizeConfidence(entry.confidence, 0),
    })),
  };
}

function buildPunctuationSection(punctuationEvidence, profileRules) {
  return {
    preferFullWidth: punctuationEvidence[0]?.preferFullWidth ?? profileRules?.punctuation?.preferFullWidth ?? null,
    ellipsis: profileRules?.punctuation?.ellipsis ?? null,
    quoteStyle: profileRules?.punctuation?.quoteStyle ?? null,
    evidence: punctuationEvidence.map((entry) => ({
      preferFullWidth: entry.preferFullWidth === true,
      confidence: normalizeConfidence(entry.confidence, 0),
    })),
  };
}

function buildHonorificsSection(honorificEvidence, profileRules, honorificExamples) {
  return {
    preserveHonorifics: honorificEvidence[0]?.preserveHonorifics ?? profileRules?.preserveHonorifics ?? null,
    evidence: honorificEvidence.map((entry) => ({
      preserveHonorifics: entry.preserveHonorifics === true,
      confidence: normalizeConfidence(entry.confidence, 0),
    })),
    examples: honorificExamples,
  };
}

function buildDialogueNarrationSection(
  activeChapterEvidence,
  profileRules,
  knowledgeBase,
  dialogueExamples,
  narrationExamples,
) {
  return {
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
  };
}

function assembleStyleMemorySnapshot(params) {
  return {
    chapterId: params.chapterId || null,
    referenceKind: params.activeChapterEvidence?.referenceKind || null,
    targetStyleAllowed: params.activeChapterEvidence?.targetStyleAllowed === true,
    activeLayers: params.activeLayers,
    register: params.register,
    punctuation: params.punctuation,
    honorifics: params.honorifics,
    dialogueNarration: params.dialogueNarration,
    characterSpeech: params.characterSpeech,
    storyAnchors: params.storyAnchors,
    notes: params.notes,
    coverage: params.coverage,
  };
}

function collectStyleSamples(activeChapterEvidence, profileSamples) {
  return {
    dialogueExamples: uniqueStringList([
      ...(activeChapterEvidence?.dialogueSamples || []),
      ...(profileSamples.dialogue || []),
    ]).slice(0, 4),
    narrationExamples: uniqueStringList([
      ...(activeChapterEvidence?.narrationSamples || []),
      ...(profileSamples.narration || []),
    ]).slice(0, 4),
    honorificExamples: uniqueStringList(profileSamples.honorifics || []).slice(0, 4),
  };
}

function collectStyleNotes(activeChapterEvidence, knowledgeBase) {
  return uniqueStringList([
    ...(Array.isArray(activeChapterEvidence?.notes) ? activeChapterEvidence.notes : []),
    ...(Array.isArray(knowledgeBase?.style_profile?.notes) ? knowledgeBase.style_profile.notes : []),
  ]).slice(0, 8);
}

function styleEvidenceCoverage(styleEvidence) {
  return {
    chapterCount: Array.isArray(styleEvidence?.metadata?.source_chapters)
      ? styleEvidence.metadata.source_chapters.length
      : 0,
    referenceSetCount: Array.isArray(styleEvidence?.metadata?.source_reference_sets)
      ? styleEvidence.metadata.source_reference_sets.length
      : 0,
  };
}

function resolvedStyleEvidence(activeChapterEvidence) {
  return {
    registerEvidence: resolvedEvidence(activeChapterEvidence?.registerEvidence),
    punctuationEvidence: resolvedEvidence(activeChapterEvidence?.punctuationEvidence),
    honorificEvidence: resolvedEvidence(activeChapterEvidence?.honorificEvidence),
  };
}

function computeStyleMemoryValues(input) {
  const { chapterId, styleEvidence, chapterStyleEvidence, styleProfile } = input;
  const { storyContext, translationContext, knowledgeBase } = input;
  const chapterContext = chapterContextFor(chapterId, storyContext);
  const translationChapterLocal = translationChapterLocalFor(translationContext);
  const profileRules = profileRulesOf(styleProfile);
  const profileSamples = profileSamplesOf(styleProfile);
  const activeChapterEvidence = activeChapterEvidenceOf(chapterStyleEvidence);
  const characterSpeech = buildCharacterSpeechMemory(activeChapterEvidence, knowledgeBase);
  const storyAnchors = buildStoryAnchors(chapterContext, translationChapterLocal);
  return {
    chapterId,
    activeChapterEvidence,
    activeLayers: buildActiveLayers(activeChapterEvidence, styleEvidence, styleProfile, characterSpeech, storyAnchors),
    profileRules,
    knowledgeBase,
    characterSpeech,
    storyAnchors,
    ...resolvedStyleEvidence(activeChapterEvidence),
    notes: collectStyleNotes(activeChapterEvidence, knowledgeBase),
    coverage: styleEvidenceCoverage(styleEvidence),
    ...collectStyleSamples(activeChapterEvidence, profileSamples),
  };
}

function buildStyleSections(values) {
  return {
    register: buildRegisterSection(values.registerEvidence, values.profileRules),
    punctuation: buildPunctuationSection(values.punctuationEvidence, values.profileRules),
    honorifics: buildHonorificsSection(
      values.honorificEvidence,
      values.profileRules,
      values.honorificExamples,
    ),
    dialogueNarration: buildDialogueNarrationSection(
      values.activeChapterEvidence,
      values.profileRules,
      values.knowledgeBase,
      values.dialogueExamples,
      values.narrationExamples,
    ),
  };
}

function buildStyleMemorySnapshot(input = {}) {
  const values = computeStyleMemoryValues({
    chapterId: null,
    styleEvidence: null,
    chapterStyleEvidence: null,
    styleProfile: null,
    storyContext: null,
    translationContext: null,
    knowledgeBase: null,
    ...input,
  });
  return assembleStyleMemorySnapshot({
    ...values,
    ...buildStyleSections(values),
  });
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
