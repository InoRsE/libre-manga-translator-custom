/**
 * Region Manifest & Cryptographic Transmission Contract (M1.5.1 Final Correction)
 *
 * Enforces reproducible region coordinates, detection provenance, and image integrity:
 * 1. Region coordinates and counts are derived strictly from detector output, NEVER handwritten integers.
 * 2. Missing detector output must NEVER become zero-dialogue success.
 * 3. Transmitted annotated images must match their stored cryptographic SHA-256 hashes.
 * 4. Modified expected counts without a matching region manifest must fail immediately.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { ExpectedBatchPage } from "../server/validator";

export interface PageRegionManifest {
  pageId: string;
  pageIndex: number;
  pageNumber: number;
  sourceImageSha256: string;
  regionCount: number;
  bboxes: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    confidence: number;
  }>;
  detectionProvenance: {
    detectorModel: string;
    minConfidence: number;
    modelWeightsHash: string;
    generatedAt: number;
  };
  annotatedImageSha256: string;
}

export interface ChapterRegionManifest {
  chapterKey: string;
  totalPages: number;
  totalDialogueRegions: number;
  pages: PageRegionManifest[];
  createdAt: number;
}

export function computeSha256(data: string | Buffer): string {
  const buf = typeof data === "string"
    ? (data.startsWith("data:")
        ? Buffer.from(data.replace(/^data:image\/[a-z]+;base64,/, ""), "base64")
        : Buffer.from(data, "base64"))
    : data;
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function resolveDefaultManifestPath(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "scripts", "manifests", "zipang-54-manifest.json");
    if (fs.existsSync(candidate)) return path.resolve(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd(), "scripts/manifests/zipang-54-manifest.json");
}

export function loadChapterManifest(customPath?: string): ChapterRegionManifest {
  const p = customPath ? path.resolve(customPath) : resolveDefaultManifestPath();
  if (!fs.existsSync(p)) {
    throw new Error(
      `MANIFEST ERROR: Region manifest not found at '${p}'. Production bounding-box translation strictly requires a verified region manifest.`,
    );
  }

  const raw = fs.readFileSync(p, "utf8");
  let manifest: any;
  try {
    manifest = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`MANIFEST INTEGRITY ERROR: Corrupted manifest at '${p}': ${e.message}`);
  }

  validateManifestIntegrity(manifest);
  return manifest as ChapterRegionManifest;
}

export function validateManifestIntegrity(manifest: unknown): void {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("MANIFEST INTEGRITY ERROR: Manifest is not a valid JSON object");
  }

  const m = manifest as Record<string, any>;
  if (typeof m.chapterKey !== "string" || !Array.isArray(m.pages) || typeof m.totalPages !== "number") {
    throw new Error("MANIFEST INTEGRITY ERROR: Manifest schema missing required top-level fields");
  }

  let calculatedRegions = 0;
  for (const page of m.pages) {
    if (!page || typeof page !== "object") {
      throw new Error("MANIFEST INTEGRITY ERROR: Invalid page entry in manifest");
    }

    // Acceptance Test Guard: Missing detector output must not become zero-dialogue success
    if (!Array.isArray(page.bboxes)) {
      throw new Error(
        `MISSING DETECTOR OUTPUT ERROR: Page '${page.pageId}' lacks valid detector 'bboxes' array. Missing detector output must NEVER become zero-dialogue success.`,
      );
    }

    if (typeof page.regionCount !== "number" || page.regionCount !== page.bboxes.length) {
      throw new Error(
        `MANIFEST CORRUPTION: Page '${page.pageId}' declared regionCount (${page.regionCount}) does not match bboxes length (${page.bboxes.length})`,
      );
    }

    if (!page.sourceImageSha256 || typeof page.sourceImageSha256 !== "string") {
      throw new Error(`MANIFEST INTEGRITY ERROR: Page '${page.pageId}' missing sourceImageSha256`);
    }

    if (!page.annotatedImageSha256 || typeof page.annotatedImageSha256 !== "string") {
      throw new Error(`MANIFEST INTEGRITY ERROR: Page '${page.pageId}' missing annotatedImageSha256`);
    }

    calculatedRegions += page.regionCount;
  }

  if (m.totalDialogueRegions !== calculatedRegions) {
    throw new Error(
      `MANIFEST COUNT MISMATCH: Manifest totalDialogueRegions (${m.totalDialogueRegions}) does not match sum of page regions (${calculatedRegions})`,
    );
  }
}

/**
 * Validates submitted expected pages against the authoritative manifest.
 * Fails immediately if any expectedCount is modified without matching the region manifest.
 */
export function validateSubmissionAgainstManifest(
  manifest: ChapterRegionManifest,
  expectedPages: ExpectedBatchPage[],
): void {
  const manifestMap = new Map<string, PageRegionManifest>();
  for (const p of manifest.pages) {
    manifestMap.set(p.pageId, p);
  }

  for (const exp of expectedPages) {
    const pageId = String(exp.pageId).trim();
    const manifestPage = manifestMap.get(pageId);

    if (!manifestPage) {
      throw new Error(
        `UNREGISTERED PAGE ERROR: Page '${pageId}' is not registered in the region manifest for chapter '${manifest.chapterKey}'.`,
      );
    }

    // Acceptance Test Guard: A modified expected count without a matching region manifest must fail!
    if (exp.expectedCount !== manifestPage.regionCount) {
      throw new Error(
        `MANIFEST MISMATCH ERROR: Expected count for page '${pageId}' (${exp.expectedCount}) does not match manifest region count (${manifestPage.regionCount}). Handwritten or modified counts are strictly forbidden.`,
      );
    }
  }
}

/**
 * Validates that the actual image data transmitted to the model matches the manifest's annotated hash.
 */
export function validateTransmittedImageHash(
  manifestPage: PageRegionManifest,
  transmittedDataOrBase64: string | Buffer,
): void {
  const actualHash = computeSha256(transmittedDataOrBase64);
  if (actualHash !== manifestPage.annotatedImageSha256) {
    throw new Error(
      `TRANSMISSION INTEGRITY ERROR: Transmitted image for page '${manifestPage.pageId}' has SHA-256 hash '${actualHash}', which does not match authoritative manifest hash '${manifestPage.annotatedImageSha256}'.`,
    );
  }
}
