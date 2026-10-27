const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  PostEditWorkspaceModule,
  buildPostEditDocumentFromRegionSnapshot,
} = require("../../backend/src/domains/post_edit/workspace/post_edit_workspace");

function createScene() {
  return {
    scene: {
      pages: {
        page_001: {
          name: "001.png",
          nodes: {
            node_001: {
              transform: { x: 10, y: 20, width: 30, height: 40 },
              kind: {
                text: {
                  text: "original line",
                  translation: "translated line",
                },
              },
            },
            node_002: {
              transform: { x: 50, y: 60, width: 20, height: 10 },
              kind: {
                text: {
                  text: "second line",
                  translation: "second translation",
                },
              },
            },
          },
        },
      },
    },
  };
}

describe("post edit workspace", () => {
  test("retains opaque correction identities from a region snapshot", () => {
    const input = {
      jobId: "job-001", sourcePreflightId: "preflight-001", snapshot: { pages: [{
        internalPageId: "page-001", pageName: "001.png", sourceImageId: "source-001",
        regionSetRevisionId: "region-set-001",
        coordinateSpace: { kind: "source_image_pixels", width: 100, height: 200 },
        regions: [{
          id: "region-001", internalNodeId: "node-001", sourceText: "source",
          translatedText: "target", geometry: { x: 1, y: 2, width: 30, height: 40 },
        }],
      }] },
    };
    const document = buildPostEditDocumentFromRegionSnapshot(input);

    expect(document.pages["page-001"]).toEqual(expect.objectContaining({
      sourceImageId: "source-001", regionSetRevisionId: "region-set-001",
    }));
    expect(document.pages["page-001"].nodes["node-001"].regionId).toBe("region-001");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "post-edit-workspace-"));
    const module = new PostEditWorkspaceModule({ root });
    module.createDocumentFromRegionSnapshot(input);
    document.pages["page-001"].sourceImageId = "tampered-source";
    document.pages["page-001"].nodes["node-001"].regionId = "tampered-region";
    const saved = module.save("job-001", document);
    expect(saved.pages["page-001"].sourceImageId).toBe("source-001");
    expect(saved.pages["page-001"].nodes["node-001"].regionId).toBe("region-001");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("creates and saves lightweight post-edit documents", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "post-edit-workspace-"));
    const module = new PostEditWorkspaceModule({ root });

    const documentPath = module.createDocumentFromScene({
      jobId: "job-001",
      sourcePreflightId: "preflight-001",
      mangaId: "manga-001",
      translatorId: "translator-001",
      chapterId: "chapter-001",
      scene: createScene(),
    });
    const created = module.load("job-001");

    expect(created.jobId).toBe("job-001");
    expect(created.sourcePreflightId).toBe("preflight-001");
    expect(created.sourcePageOrder).toEqual(["page_001"]);
    expect(created.pageOrder).toEqual(["page_001"]);
    expect(created.pages.page_001.nodeOrder).toEqual(["node_001", "node_002"]);
    expect(created.pages.page_001.nodes.node_001.editedTranslation).toBe("translated line");
    expect(created.pages.page_001.nodes.node_001.anchor).toEqual({
      pageName: "001.png",
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      centerX: 25,
      centerY: 40,
    });

    const saved = module.save("job-001", {
      ...created,
      pages: {
        ...created.pages,
        page_001: {
          ...created.pages.page_001,
          nodeOrder: ["node_002", "node_001"],
          nodes: {
            ...created.pages.page_001.nodes,
            node_001: {
              ...created.pages.page_001.nodes.node_001,
              editedTranslation: "edited translation",
            },
          },
        },
      },
    });

    expect(saved.pages.page_001.nodeOrder).toEqual(["node_002", "node_001"]);
    expect(saved.pages.page_001.nodes.node_001.editedTranslation).toBe("edited translation");

    expect(fs.existsSync(documentPath)).toBe(true);
    expect(documentPath).toBe(path.join(root, "job-001", "post_edit_document.json"));
    expect(fs.existsSync(path.join(root, "job-001", "translated_scene.json"))).toBe(false);
  });

  test("deletes documents by manga/translator/chapter binding", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "post-edit-workspace-"));
    const module = new PostEditWorkspaceModule({ root });

    module.createDocumentFromScene({
      jobId: "job-keep",
      sourcePreflightId: "preflight-keep",
      mangaId: "manga-keep",
      translatorId: "translator-keep",
      chapterId: "chapter-keep",
      scene: createScene(),
    });
    module.createDocumentFromScene({
      jobId: "job-delete",
      sourcePreflightId: "preflight-delete",
      mangaId: "manga-delete",
      translatorId: "translator-delete",
      chapterId: "chapter-delete",
      scene: createScene(),
    });

    const deleted = module.deleteByBinding({
      mangaId: "manga-delete",
      translatorId: "translator-delete",
    });

    expect(deleted).toEqual([
      expect.objectContaining({
        jobId: "job-delete",
      }),
    ]);
    expect(module.exists("job-delete")).toBe(false);
    expect(module.exists("job-keep")).toBe(true);
  });
});
