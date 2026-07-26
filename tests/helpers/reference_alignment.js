function buildFixtureReferenceAlignment({ targetTexts, targetReferenceSetId }) {
  const translationPairs = (targetTexts?.pages || []).flatMap((page) =>
    (page.texts || []).map((node) => ({
      original: node.sourceText || node.text || "fixture source",
      translation:
        node.translatedText || node.translation || node.sourceText || node.text || "fixture target",
      sourcePageId: page.pageId || page.pageName,
      targetPageId: page.pageId || page.pageName,
      sourceNodeIds: [node.nodeId].filter(Boolean),
      targetNodeIds: [node.nodeId].filter(Boolean),
      matchType: "one_to_one",
      confidence: 1,
      sourceReference: "fixture:source",
      targetReference: `reference:${targetReferenceSetId}`,
    }))
  );
  return {
    sourceReferenceSetId: "ref_fixture_source",
    translationPairs,
    summary: { acceptedPairs: translationPairs.length },
    dialogueAlignmentPath: null,
  };
}

module.exports = { buildFixtureReferenceAlignment };
