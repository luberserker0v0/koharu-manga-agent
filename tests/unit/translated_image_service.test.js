const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { paths } = require("../../backend/src/config");
const {
  TranslatedImageService,
  readZipEntries,
} = require("../../backend/src/domains/translation/exports/translated_image_service");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const compression = entry.compression ?? 8;
    const compressed = compression === 8 ? zlib.deflateRawSync(data) : data;
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(compression, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(compression, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

describe("TranslatedImageService", () => {
  let root;
  let cacheRoot;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(paths.workspaceRoot, "translated-image-test-"));
    cacheRoot = path.join(root, "cache");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("extracts ordered images and returns base64 data", async () => {
    const zipPath = path.join(root, "export.zip");
    fs.writeFileSync(zipPath, buildZip([
      { name: "pages/page-10.png", data: Buffer.from("ten") },
      { name: "pages/page-2.jpg", data: Buffer.from("two"), compression: 0 },
      { name: "manifest.json", data: Buffer.from("{}") },
    ]));
    const service = new TranslatedImageService({ root: cacheRoot, maxFileBytes: 100, maxFiles: 10, maxTotalBytes: 200 });
    const artifacts = [{ id: 7, kind: "export", path: zipPath }];

    const listed = await service.list({ jobId: "job-1", artifacts });
    expect(listed).toEqual(expect.objectContaining({ artifactId: 7, sourceFormat: "zip", count: 2 }));
    expect(listed.images.map((image) => image.fileName)).toEqual(["page-2.jpg", "page-10.png"]);
    expect(listed.images[0]).not.toHaveProperty("path");

    const encoded = await service.encoded({ jobId: "job-1", artifacts, imageId: listed.images[0].id });
    expect(encoded.encoding).toBe("base64");
    expect(Buffer.from(encoded.data, "base64").toString("utf8")).toBe("two");
  });

  test("rejects traversal entries before extraction", () => {
    const zipPath = path.join(root, "traversal.zip");
    fs.writeFileSync(zipPath, buildZip([{ name: "../escape.png", data: Buffer.from("bad") }]));
    expect(() => readZipEntries(zipPath)).toThrow("path traversal");
    expect(fs.existsSync(path.join(root, "escape.png"))).toBe(false);
  });

  test("supports a direct image export", async () => {
    const imagePath = path.join(root, "export.png");
    fs.writeFileSync(imagePath, Buffer.from("png"));
    const service = new TranslatedImageService({ root: cacheRoot });
    const listed = await service.list({ jobId: "job-direct", artifacts: [{ id: 9, kind: "export", path: imagePath }] });
    expect(listed.sourceFormat).toBe("image");
    expect(listed.images).toHaveLength(1);
    expect(listed.images[0].mediaType).toBe("image/png");
  });
});
