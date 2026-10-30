import { describe, it, expect } from "bun:test";
import {
  computeCrc32,
  createCbzArchive,
  formatCbzFilename,
  dataUrlToUint8Array,
} from "@/lib/export/cbz";

describe("CBZ Archive Generator (M1.4 ACTION C)", () => {
  it("computes accurate CRC-32 checksums", () => {
    const encoder = new TextEncoder();
    const data = encoder.encode("The quick brown fox jumps over the lazy dog");
    // Standard CRC-32 for this pangram is 0x414fa339
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

  it("creates a valid ZIP/CBZ binary with local headers, central directory, and EOCD", () => {
    const encoder = new TextEncoder();
    const file1Data = encoder.encode("Fake PNG image 1 content");
    const file2Data = encoder.encode("Fake PNG image 2 content");
    const manifestData = encoder.encode(JSON.stringify({ series: "Zipang", chapter: "54" }));

    const archive = createCbzArchive([
      { name: "001.png", data: file1Data },
      { name: "002.png", data: file2Data },
      { name: "manifest.json", data: manifestData },
    ]);

    expect(archive).toBeDefined();
    expect(archive.length).toBeGreaterThan(0);

    // Verify local file header signature for first file: PK\x03\x04 (0x04034b50)
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);

    // Verify EOCD signature near end of file: PK\x05\x06 (0x06054b50)
    const eocdSig = view.getUint32(archive.length - 22, true);
    expect(eocdSig).toBe(0x06054b50);

    // Verify record count in EOCD is 3
    const diskRecords = view.getUint16(archive.length - 14, true);
    const totalRecords = view.getUint16(archive.length - 12, true);
    expect(diskRecords).toBe(3);
    expect(totalRecords).toBe(3);
  });

  it("converts data URLs cleanly to Uint8Array", () => {
    const originalText = "Hello Manga World";
    const base64 = btoa(originalText);
    const dataUrl = `data:image/png;base64,${base64}`;

    const bytes = dataUrlToUint8Array(dataUrl);
    const decoded = new TextDecoder().decode(bytes);
    expect(decoded).toBe(originalText);
  });
});
