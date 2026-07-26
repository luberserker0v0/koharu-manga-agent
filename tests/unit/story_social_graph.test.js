const {
  createStoryGraphFromContext,
  deriveSocialGraphFromStoryGraph,
} = require("../../backend/src/modules/knowledge_assets");

describe("story and social graph derivation", () => {
  test("creates a social edge from explicit relationship endpoints with multiple evidences", () => {
    const storyGraph = createStoryGraphFromContext({
      mangaId: "manga-1",
      chapterId: "chapter-1",
      referenceSetId: "reference-1",
      chapterContext: {
        characters: [
          { name: "リアム・セラ・バンフィールド", aliases: ["リアム"], confidence: 0.9 },
        ],
        terminology: [],
        mentions: [],
        events: [],
        relationships: [
          {
            term: "trusts",
            relationType: "trusts",
            subject: "リアム",
            object: "天城",
            confidence: 0.81,
            evidences: [
              { pageName: "001.png", nodeId: "n1", evidenceLine: "リアムは天城を信頼している" },
              { pageName: "002.png", nodeId: "n2", evidenceLine: "天城に任せる" },
            ],
          },
        ],
      },
    });

    const relationEdge = storyGraph.edges.find((edge) => edge.relation_type === "trusts");
    expect(relationEdge).toBeDefined();
    expect(relationEdge.evidences).toHaveLength(2);

    const socialGraph = deriveSocialGraphFromStoryGraph(storyGraph, {
      mangaId: "manga-1",
      chapterId: "chapter-1",
      referenceSetId: "reference-1",
    });
    expect(socialGraph.nodes.map((node) => node.canonical_name)).toEqual(
      expect.arrayContaining(["リアム・セラ・バンフィールド", "天城"])
    );
    expect(socialGraph.edges).toEqual([
      expect.objectContaining({ relation_type: "trusts", evidence_count: 2 }),
    ]);
  });

  test("resolves a single-character OCR difference to one known identity", () => {
    const storyGraph = createStoryGraphFromContext({
      mangaId: "manga-1",
      chapterId: "chapter-1",
      referenceSetId: "reference-1",
      chapterContext: {
        characters: [
          { name: "リアム・セラ・バンフィールド", confidence: 0.9 },
          { name: "天城", confidence: 0.9 },
        ],
        terminology: [],
        mentions: [],
        events: [],
        relationships: [
          {
            term: "serves",
            relationType: "serves",
            subject: "天城",
            object: "リアム・セラ・パンフィールド",
            evidenceLine: "天城はリアム・セラ・パンフィールドに仕える",
            confidence: 0.7,
          },
        ],
      },
    });

    expect(storyGraph.nodes.filter((node) => node.node_type === "character")).toHaveLength(2);
    expect(storyGraph.edges.find((edge) => edge.relation_type === "serves")).toBeDefined();
  });
});
