const {
  matchPostEditDocumentToScene,
} = require("../../backend/src/modules/post_edit_export");

function createDocument() {
  return {
    jobId: "job-001",
    sourcePreflightId: "preflight-001",
    sourcePageOrder: ["page_doc_001"],
    pageOrder: ["page_doc_001"],
    pages: {
      page_doc_001: {
        pageId: "page_doc_001",
        pageName: "001.png",
        nodeOrder: ["node_doc_001", "node_doc_002"],
        nodes: {
          node_doc_001: {
            nodeId: "node_doc_001",
            originalText: "hello",
            originalTranslation: "你好",
            editedTranslation: "您好",
            anchor: {
              pageName: "001.png",
              x: 10,
              y: 10,
              width: 20,
              height: 10,
              centerX: 20,
              centerY: 15,
            },
          },
          node_doc_002: {
            nodeId: "node_doc_002",
            originalText: "world",
            originalTranslation: "世界",
            editedTranslation: "世間",
            anchor: {
              pageName: "001.png",
              x: 100,
              y: 20,
              width: 24,
              height: 12,
              centerX: 112,
              centerY: 26,
            },
          },
        },
      },
    },
  };
}

function createScene(overrides = {}) {
  return {
    scene: {
      pages: {
        page_scene_001: {
          name: "001.png",
          nodes: {
            node_scene_001: {
              transform: { x: 12, y: 11, width: 21, height: 9 },
              kind: {
                text: {
                  text: "hello",
                },
              },
            },
            node_scene_002: {
              transform: { x: 102, y: 19, width: 25, height: 12 },
              kind: {
                text: {
                  text: "world",
                },
              },
            },
            ...overrides,
          },
        },
      },
    },
  };
}

describe("post edit export matching", () => {
  test("matches nodes by page name and anchor distance", () => {
    const result = matchPostEditDocumentToScene(createDocument(), createScene());

    expect(result.unresolved).toEqual([]);
    expect(result.matches).toEqual([
      expect.objectContaining({
        documentNodeId: "node_doc_001",
        rebuiltNodeId: "node_scene_001",
        editedTranslation: "您好",
      }),
      expect.objectContaining({
        documentNodeId: "node_doc_002",
        rebuiltNodeId: "node_scene_002",
        editedTranslation: "世間",
      }),
    ]);
  });

  test("uses geometry to disambiguate same-text candidates", () => {
    const document = createDocument();
    document.pages.page_doc_001.nodeOrder = ["node_doc_001"];
    document.pages.page_doc_001.nodes = {
      node_doc_001: document.pages.page_doc_001.nodes.node_doc_001,
    };
    const scene = {
      scene: {
        pages: {
          page_scene_001: {
            name: "001.png",
            nodes: {
              node_far: {
                transform: { x: 300, y: 300, width: 20, height: 10 },
                kind: { text: { text: "hello" } },
              },
              node_near: {
                transform: { x: 11, y: 11, width: 20, height: 10 },
                kind: { text: { text: "hello" } },
              },
            },
          },
        },
      },
    };

    const result = matchPostEditDocumentToScene(document, scene);

    expect(result.unresolved).toEqual([]);
    expect(result.matches[0]).toEqual(
      expect.objectContaining({
        rebuiltNodeId: "node_near",
      })
    );
  });

  test("reports unresolved nodes when no safe match exists", () => {
    const scene = {
      scene: {
        pages: {
          page_scene_001: {
            name: "999.png",
            nodes: {},
          },
        },
      },
    };

    const result = matchPostEditDocumentToScene(createDocument(), scene);

    expect(result.matches).toEqual([]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({
        pageName: "001.png",
        nodeId: "node_doc_001",
      }),
      expect.objectContaining({
        pageName: "001.png",
        nodeId: "node_doc_002",
      }),
    ]);
  });
});
