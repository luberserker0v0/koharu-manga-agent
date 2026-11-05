const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");

const { UploadService } = require("../../backend/src/domains/uploads/upload_service");
const {
  OcrTextReviewService,
  OCR_TEXT_REVIEW_SYSTEM_PROMPT,
  buildPrompt,
  validateRequest,
} = require("../../backend/src/domains/translation/text_regions/ocr_text_review_service");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("OcrTextReviewService", () => {
  let root;
  let uploadService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-text-review-"));
    uploadService = new UploadService({ root });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  async function readyUpload() {
    const upload = uploadService.create({ kind: "ocr_review" });
    await uploadService.putFile(upload.uploadId, "ocr_001.png", Readable.from(PNG));
    uploadService.complete(upload.uploadId);
    return upload.uploadId;
  }

  test("corrects each crop independently and retains the client mapping", async () => {
    const uploadId = await readyUpload();
    const reviewer = {
      assertVisionModel: jest.fn(async () => {}),
      correctOcrText: jest.fn(async () => ({ text: '{"correctedText":"intergalactic"}' })),
    };
    const service = new OcrTextReviewService({
      uploadService,
      reviewer,
      getConfig: () => ({ translation: {
        defaultTarget: { modelId: "vision-model" },
        lmStudio: { baseUrl: "http://127.0.0.1:25555" },
        generationOptions: { reasoning: "off" },
      } }),
    });
    const hooks = { setStage: jest.fn(), emit: jest.fn(), isCanceled: jest.fn(() => false) };
    const request = {
      uploadId,
      sourceLanguages: ["en", "ja"],
      items: [{
        clientItemId: "region-1", fileName: "ocr_001.png", ocrText: "inter galac tic",
        contextBefore: "What is this?", contextAfter: "An empire.",
      }],
    };

    await expect(service.run(service.prepare(request), hooks)).resolves.toMatchObject({
      uploadId,
      sourceLanguages: ["en", "ja"],
      items: [{
        clientItemId: "region-1", originalText: "inter galac tic",
        correctedText: "intergalactic", changed: true, status: "succeeded",
      }],
      summary: { total: 1, succeededCount: 1, failedCount: 0, changedCount: 1 },
    });
    const inference = reviewer.correctOcrText.mock.calls[0][0];
    expect(inference.prompt).toContain("<ocr_hint>\ninter galac tic\n</ocr_hint>");
    expect(inference.systemPrompt).toContain("exactly one final transcription");
    expect(inference.prompt).toContain("Expected source languages in priority order: en, ja.");
    expect(inference).not.toHaveProperty("geometry");
    expect(inference).not.toHaveProperty("box");
    expect(hooks.emit).toHaveBeenCalledWith("ocr_text_review.progress", expect.objectContaining({
      clientItemId: "region-1", completed: 1, total: 1, progress: 1,
    }));
  });

  test("rejects duplicate IDs and geometry fields at the public boundary", () => {
    expect(() => validateRequest({
      uploadId: "upload-1",
      items: [{ clientItemId: "region-1", fileName: "ocr.png", ocrText: "text", geometry: {} }],
    })).toThrow(/unsupported fields: geometry/);
    expect(buildPrompt({ ocrText: "helo", contextBefore: null, contextAfter: null }, ["en"]))
      .toContain("Output one final transcription");
    expect(OCR_TEXT_REVIEW_SYSTEM_PROMPT).toContain("Never translate or paraphrase");
  });
});
