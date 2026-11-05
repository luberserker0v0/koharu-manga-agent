function regionInput(region) {
  const geometry = region.geometry;
  return {
    index: region.readingOrder,
    box: [geometry.x, geometry.y, geometry.width, geometry.height],
    text: region.sourceText,
  };
}

function buildTextRegionReviewPrompt(page, sourceLanguage) {
  const current = { count: page.regions.length, regions: page.regions.map(regionInput) };
  const languages = Array.isArray(sourceLanguage) ? sourceLanguage : [sourceLanguage].filter(Boolean);
  return [
    "You are a manga OCR correction specialist.",
    "Goal: transcribe the source text in every fixed box, then correct recognition errors with page-level semantics.",
    `Image size: ${page.coordinateSpace.width} x ${page.coordinateSpace.height} pixels.`,
    `Expected source languages: ${languages.length ? languages.join(", ") : "unknown"}.`,
    `Fixed OCR regions in reading order: ${JSON.stringify(current)}`,
    "Rules:",
    "1. Read the visible glyphs inside each box. Current OCR is only a noisy hint.",
    "2. Resolve ambiguous characters, spacing, and punctuation using neighboring boxes, reading order, dialogue flow, grammar, and sentence meaning.",
    "3. For alphabetic text, restore natural word spaces and join only fragments of the same word caused by layout wrapping.",
    "Ordinary alphabetic sentences must not retain concatenated words; preserve intentional URLs, names, codes, and sound effects.",
    "4. Preserve the source language, names, numbers, case, punctuation, sound effects, and meaningful line breaks. If language is unknown, infer it from the image and context.",
    "5. Do not translate, paraphrase, censor, embellish, or invent dialogue. When uncertain, make the smallest visually supported correction.",
    "6. Boxes are fixed. Never add, remove, resize, move, merge, or split them.",
    "Return only one JSON object with exactly two fields: count and texts.",
    'texts must be an array of corrected OCR strings in exactly the same order as the supplied regions.',
    `count and texts.length must both equal ${page.regions.length}.`,
    "Do not use Markdown or add explanations.",
  ].join("\n");
}

module.exports = { buildTextRegionReviewPrompt, regionInput };
