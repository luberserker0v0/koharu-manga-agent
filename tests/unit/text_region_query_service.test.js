const { TextRegionQueryService } = require(
  "../../backend/src/domains/translation/text_regions/text_region_query_service",
);

function page(sourceImageId) {
  return {
    sourceImageId,
    sourceOrderIndex: sourceImageId === "source-1" ? 0 : 1,
    sourceFileName: `${sourceImageId}.png`,
    regionSetRevisionId: `region-set-${sourceImageId}`,
    coordinateSpace: {
      kind: "source_image_pixels", origin: "top_left", width: 100, height: 200,
      rotationUnit: "degrees_clockwise",
    },
    regions: [],
  };
}

describe("TextRegionQueryService revision composition", () => {
  test("inherits unchanged page revisions from the parent Job", async () => {
    const root = { id: "root-job", type: "translation", payload: {} };
    const child = {
      id: "child-job", type: "translation", parentJobId: "root-job",
      payload: { revision: { rootJobId: "root-job", parentJobId: "root-job" } },
    };
    const jobs = new Map([[root.id, root], [child.id, child]]);
    const revisions = [
      { jobId: "root-job", sourceImageId: "source-1", revisionId: "root-page-1" },
      { jobId: "root-job", sourceImageId: "source-2", revisionId: "root-page-2" },
      { jobId: "child-job", sourceImageId: "source-2", revisionId: "child-page-2" },
    ];
    const synchronizeJob = jest.fn(async () => {});
    const service = new TextRegionQueryService({
      store: {
        getJob: (id) => jobs.get(id) || null,
        listTranslationPageRevisions: () => revisions,
      },
      pageRevisionService: { synchronizeJob },
      snapshotRepository: { loadForJob: () => ({
        rootJobId: "root-job", fingerprint: "snapshot-child", pages: [page("source-1"), page("source-2")],
      }) },
    });

    const result = await service.get("child-job");

    expect(result.pages.map((entry) => [entry.sourceImageId, entry.pageRevisionId])).toEqual([
      ["source-1", "root-page-1"],
      ["source-2", "child-page-2"],
    ]);
    expect(synchronizeJob).toHaveBeenCalledWith("root-job");
    expect(synchronizeJob).toHaveBeenCalledWith("child-job");
  });
});
