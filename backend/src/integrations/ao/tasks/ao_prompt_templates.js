const TASK_DEFINITIONS = Object.freeze({
  story_context_update: {
    specialistFiles: [
      "workspace/.opencode/agents/story-context-builder.md",
    ],
    skillFiles: [
      "workspace/.opencode/skills/story-delta-contract/SKILL.md",
    ],
    defaultOutputFilePath: "output/story_delta_result.txt",
  },
  chapter_observation: {
    specialistFiles: [
      "workspace/.opencode/agents/chapter-observer.md",
    ],
    skillFiles: [
      "workspace/.opencode/skills/chapter-observation-contract/SKILL.md",
    ],
    defaultOutputFilePath: "output/chapter_observation.txt",
  },
  bilingual_evidence_window: {
    specialistFiles: [
      "workspace/.opencode/agents/bilingual-evidence-builder.md",
    ],
    skillFiles: [
      "workspace/.opencode/skills/bilingual-evidence-contract/SKILL.md",
    ],
    defaultOutputFilePath: "output/bilingual_evidence.txt",
  },
  reference_deep_review: {
    specialistFiles: [
      "workspace/.opencode/agents/reference-deep-reviewer.md",
    ],
    skillFiles: [
      "workspace/.opencode/skills/chapter-observation-contract/SKILL.md",
    ],
    defaultOutputFilePath: "output/reference_deep_review.txt",
  },
  quality_review: {
    specialistFiles: [
      "workspace/.opencode/agents/quality-optimizer.md",
    ],
    skillFiles: [
      "workspace/.opencode/skills/quality-line-contract/SKILL.md",
      "workspace/.opencode/skills/quality-decision-framework/SKILL.md",
    ],
    defaultOutputFilePath: "output/quality_result.txt",
  },
  translation_quality_observation: {
    specialistFiles: [
      "workspace/.opencode/agents/translation-quality-observer.md",
    ],
    skillFiles: [
      "workspace/.opencode/skills/translation-quality-observation-contract/SKILL.md",
    ],
    defaultOutputFilePath: "output/translation_quality_observation.txt",
  },
  reference_locale_projection: {
    specialistFiles: [
      "workspace/.opencode/agents/reference-locale-projector.md",
    ],
    skillFiles: [
      "workspace/.opencode/skills/reference-locale-projection-contract/SKILL.md",
    ],
    defaultOutputFilePath: "output/reference_locale_projection.txt",
  },
  knowledge_enrichment: {
    specialistFiles: [
      "workspace/.opencode/agents/knowledge-builder.md",
      "workspace/.opencode/agents/terminology-normalizer.md",
      "workspace/.opencode/agents/style-profiler.md",
    ],
    skillFiles: [
      "workspace/.opencode/skills/knowledge-line-contract/SKILL.md",
      "workspace/.opencode/skills/knowledge-merge-policy/SKILL.md",
    ],
    defaultOutputFilePath: "output/knowledge_result.txt",
  },
  translation_deep_audit: {
    specialistFiles: [
      "workspace/.opencode/agents/quality-optimizer.md",
    ],
    skillFiles: [
      "workspace/.opencode/skills/translation-deep-audit-contract/SKILL.md",
    ],
    defaultOutputFilePath: "output/deep_audit.txt",
  },
});

function buildTaskRequest(taskType, _input, options = {}) {
  const definition = TASK_DEFINITIONS[taskType];
  if (!definition) throw new Error("Unknown AO task type: " + taskType);
  return {
    taskType,
    specialistFiles: [...definition.specialistFiles],
    skillFiles: [...definition.skillFiles],
    inputFilePath: "input/task_input.json",
    outputMode: {
      type: "line_file",
      outputFilePath: options.outputFilePath || definition.defaultOutputFilePath,
      completionReply: "DONE",
    },
  };
}

function buildTaskDispatchMessage(taskRequest) {
  return [
    "Execute AO task: " + taskRequest.taskType + ".",
    "Read workspace/AGENTS.md, then input/task_request.json and input/task_input.json.",
    "Follow only the specialist and skill files listed in input/task_request.json.",
    "Write the complete result to " + taskRequest.outputMode.outputFilePath + ".",
    "Do not include the result, a summary, or an explanation in the message reply.",
    "After the result file is written, reply only: DONE",
  ].join("\n");
}

module.exports = {
  TASK_DEFINITIONS,
  buildTaskDispatchMessage,
  buildTaskRequest,
};
