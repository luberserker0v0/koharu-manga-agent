const {
  publicJob,
  withoutInternalLocations,
} = require("../../backend/src/http/routes/jobs/job_http");

describe("public job HTTP projection", () => {
  test("removes internal locations while preserving semantic root objects", () => {
    const value = withoutInternalLocations({
      manifestPath: "C:\\private\\manifest.json",
      imageDir: "/private/images",
      contentUrl: "/api/v1/content",
      root: { nodeId: "story-root" },
    });

    expect(value).toEqual({
      contentUrl: "/api/v1/content",
      root: { nodeId: "story-root" },
    });
  });

  test("projects artifacts as API resources instead of filesystem paths", () => {
    const projected = publicJob({
      id: "job-1",
      artifacts: [{ id: 7, kind: "report", path: "/private/report.json" }],
    });

    expect(projected.artifacts[0]).toEqual(expect.objectContaining({
      id: 7,
      fileName: "report.json",
      contentUrl: "/api/v1/jobs/job-1/artifacts/7/content",
    }));
    expect(projected.artifacts[0]).not.toHaveProperty("path");
  });
});
