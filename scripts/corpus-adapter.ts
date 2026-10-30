/**
 * Local Manga Corpus Adapter (M1.5.1 Integration Correction)
 *
 * Strict Authentic Corpus Contract:
 * - getZipangCorpusPages() requires exactly 22 authentic Zipang Chapter 54 page assets.
 * - Throws an explicit error if authentic assets are missing, incomplete (<22), or corrupted.
 * - PROHIBITS silent substitution of unrelated fixtures for live benchmarks (AGENTS.md).
 * - Synthetic/mock assets are strictly segregated into getMockCorpusPages() for unit tests.
 */

import fs from "fs";
import path from "path";

export interface ExtractedCorpusPage {
  file: string;
  id: string;
  chapterKey: string;
  pageIndex: number;
  pageNumber: number;
  src: string;
  mimeType: string;
  byteLength: number;
  dataUrlLength: number;
  jpegBytesLength: number;
  base64Data?: string;
}

export const EXPECTED_ZIPANG_54_PAGE_COUNT = 22;

export function getZipangCorpusPages(): ExtractedCorpusPage[] {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error(
      `AUTHENTIC CORPUS FAILURE: LOCALAPPDATA environment variable is missing. Cannot locate authentic Zipang Ch. 54 corpus. Silently substituting fallback fixtures is strictly prohibited.`,
    );
  }

  const blobDir = path.join(
    localAppData,
    "Google",
    "Chrome",
    "User Data",
    "Default",
    "IndexedDB",
    "https_comix.to_0.indexeddb.blob",
    "1",
    "00",
  );

  if (!fs.existsSync(blobDir)) {
    throw new Error(
      `AUTHENTIC CORPUS FAILURE: Blob directory not found at '${blobDir}'. Authentic Zipang Ch. 54 assets are missing. Silently substituting fallback fixtures is strictly prohibited.`,
    );
  }

  const files = fs
    .readdirSync(blobDir)
    .filter((f) => !fs.statSync(path.join(blobDir, f)).isDirectory());

  const extracted: ExtractedCorpusPage[] = [];

  for (const f of files) {
    const raw = fs.readFileSync(path.join(blobDir, f));
    const str = raw.toString("utf8");

    const idMatch = str.match(/zipang__54__page_(\d+)/);
    if (!idMatch) continue;

    const pageIndex = parseInt(idMatch[1], 10);
    const dataUrlIdx = raw.indexOf(Buffer.from("data:image"));
    if (dataUrlIdx === -1) continue;

    let endIdx = raw.indexOf(Buffer.from('"'), dataUrlIdx);
    if (endIdx === -1) endIdx = raw.length;

    const dataUrl = raw.toString("utf8", dataUrlIdx, endIdx);
    const base64Part = dataUrl.replace(/^data:image\/[a-z]+;base64,/, "");
    const imageBuf = Buffer.from(base64Part, "base64");

    const srcMatch = str.match(/https:\/\/[^"\s]+/);
    const src = srcMatch ? srcMatch[0] : "";

    extracted.push({
      file: f,
      id: `zipang__54__page_${pageIndex}`,
      chapterKey: "zipang__54",
      pageIndex,
      pageNumber: pageIndex + 1,
      src,
      mimeType: "image/jpeg",
      byteLength: raw.length,
      dataUrlLength: dataUrl.length,
      jpegBytesLength: imageBuf.length,
      base64Data: base64Part,
    });
  }

  extracted.sort((a, b) => a.pageIndex - b.pageIndex);

  if (extracted.length !== EXPECTED_ZIPANG_54_PAGE_COUNT) {
    throw new Error(
      `AUTHENTIC CORPUS FAILURE: Zipang Chapter 54 benchmark strictly requires exactly ${EXPECTED_ZIPANG_54_PAGE_COUNT} authentic page assets (found ${extracted.length}). Silently substituting fallback fixtures is prohibited by AGENTS.md.`,
    );
  }

  return extracted;
}

/**
 * Explicit helper for synthetic/mock tests.
 * NEVER called as a silent fallback by getZipangCorpusPages().
 */
export function getMockCorpusPages(): ExtractedCorpusPage[] {
  const assetsDir = path.resolve(process.cwd(), "tests/assets");
  if (!fs.existsSync(assetsDir)) return [];

  const candidateFiles = [
    "vertical-japanese-test.png",
    "horizontal-japanese-test.png",
    "inpainting-test.png",
    "korean-test.png",
    "chinese-vertical-test.jpg",
  ];

  const pages: ExtractedCorpusPage[] = [];
  candidateFiles.forEach((file, index) => {
    const p = path.join(assetsDir, file);
    if (!fs.existsSync(p)) return;
    const buf = fs.readFileSync(p);
    const mime = file.endsWith(".jpg") ? "image/jpeg" : "image/png";
    const base64 = buf.toString("base64");

    pages.push({
      file,
      id: `mock_corpus_page_${index}`,
      chapterKey: "mock_corpus",
      pageIndex: index,
      pageNumber: index + 1,
      src: `file://${p}`,
      mimeType: mime,
      byteLength: buf.length,
      dataUrlLength: base64.length,
      jpegBytesLength: buf.length,
      base64Data: base64,
    });
  });

  return pages;
}
