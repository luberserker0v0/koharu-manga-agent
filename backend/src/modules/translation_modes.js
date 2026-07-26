const TRANSLATION_MODE_POLICIES = Object.freeze({
  quick: Object.freeze({
    useReferenceMemory: false,
    useLocalMemory: false,
    runQuality: false,
    commitKnowledge: false,
  }),
  reference_style: Object.freeze({
    useReferenceMemory: true,
    useLocalMemory: false,
    runQuality: "optional",
    commitKnowledge: false,
  }),
  local_style: Object.freeze({
    useReferenceMemory: false,
    useLocalMemory: true,
    runQuality: "optional",
    commitKnowledge: true,
  }),
  learning_style: Object.freeze({
    useReferenceMemory: true,
    useLocalMemory: true,
    runQuality: true,
    commitKnowledge: true,
  }),
});

function resolveTranslationModePolicy(mode, qualityRequested = false) {
  const policy = TRANSLATION_MODE_POLICIES[mode];
  if (!policy) {
    throw new Error(`Unknown translation mode: ${mode || "(missing)"}.`);
  }
  return {
    translationMode: mode,
    useReferenceMemory: policy.useReferenceMemory,
    useLocalMemory: policy.useLocalMemory,
    runQuality: policy.runQuality === true || (policy.runQuality === "optional" && qualityRequested === true),
    qualityPolicy: policy.runQuality,
    commitKnowledge: policy.commitKnowledge,
  };
}

module.exports = {
  TRANSLATION_MODE_POLICIES,
  resolveTranslationModePolicy,
};
