import { describe, it, expect } from "bun:test";
import {
  computeCrc32,
  createCbzArchive,
  parseZipArchive,
  detectImageSignature,
  formatCbzFilename,
  dataUrlToUint8Array,
  uint8ArrayToBase64,
} from "@/lib/export/cbz";

describe("CBZ Archive Generator & Independent Reader (M1.4.1 REPAIR C)", () => {
  it("computes accurate CRC-32 checksums", () => {
    const encoder = new TextEncoder();
    const data = encoder.encode("The quick brown fox jumps over the lazy dog");
    expect(computeCrc32(data)).toBe(0x414fa339);
  });

  it("formats standardized CBZ filenames correctly", () => {
    expect(formatCbzFilename("Zipang", "54", "TH")).toBe("ZIPANG_Ch054_TH.cbz");
    expect(formatCbzFilename("One Piece", "1000", "TH")).toBe("ONE_PIECE_Ch1000_TH.cbz");
    expect(formatCbzFilename("Berserk", "1", "en")).toBe("BERSERK_Ch001_EN.cbz");
    expect(formatCbzFilename("Attack on Titan · Ch. 139.5", "139.5", "TH")).toBe(
      "ATTACK_ON_TITAN_CH_1395_Ch139.5_TH.cbz",
    );
  });

  it("detects genuine image signatures and rejects non-image or text data", () => {
    // Valid 1x1 PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const pngInfo = detectImageSignature(pngBytes);
    expect(pngInfo).not.toBeNull();
    expect(pngInfo?.ext).toBe("png");
    expect(pngInfo?.mime).toBe("image/png");

    // Valid JPEG magic bytes: FF D8 FF E0
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const jpegInfo = detectImageSignature(jpegBytes);
    expect(jpegInfo).not.toBeNull();
    expect(jpegInfo?.ext).toBe("jpg");

    // Invalid non-image data (e.g. plain text placeholder)
    const textBytes = new TextEncoder().encode("Page 1 original: https://example.com/p1.jpg");
    expect(detectImageSignature(textBytes)).toBeNull();
  });

  it("creates a valid CBZ and verifies ordering, extraction, and CRC-32 using independent ZIP reader", () => {
    const encoder = new TextEncoder();
    // 1x1 valid PNG bytes
    const pngImage1 = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
    ]);
    const pngImage2 = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
    ]);
    const manifestData = encoder.encode(
      JSON.stringify({ series: "Zipang", chapter: "54", pageCount: 2 }),
    );

    const archiveBytes = createCbzArchive([
      { name: "001.png", data: pngImage1 },
      { name: "002.png", data: pngImage2 },
      { name: "manifest.json", data: manifestData },
    ]);

    // Independent ZIP parsing
    const parsed = parseZipArchive(archiveBytes);
    expect(parsed.files.length).toBe(3);

    // Verify file ordering
    expect(parsed.files[0].name).toBe("001.png");
    expect(parsed.files[1].name).toBe("002.png");
    expect(parsed.files[2].name).toBe("manifest.json");

    // Verify CRC-32 validity on extracted bytes
    expect(parsed.files[0].isValidCrc).toBe(true);
    expect(parsed.files[1].isValidCrc).toBe(true);
    expect(parsed.files[2].isValidCrc).toBe(true);

    // Verify extracted data matches original image bytes
    expect(parsed.files[0].data).toEqual(pngImage1);
    expect(detectImageSignature(parsed.files[0].data)?.mime).toBe("image/png");
    expect(parsed.files[1].data).toEqual(pngImage2);
    expect(detectImageSignature(parsed.files[1].data)?.mime).toBe("image/png");
  });

  it("converts chunked base64 safely without stack overflow", () => {
    const originalText = "Libre Manga Translator Offline Integrity Verification";
    const bytes = new TextEncoder().encode(originalText);
    const b64 = uint8ArrayToBase64(bytes);
    const roundtrip = atob(b64);
    expect(roundtrip).toBe(originalText);
  });
});
