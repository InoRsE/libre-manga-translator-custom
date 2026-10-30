/**
 * Trial #1: Zipang Chapter 54 Full-Chapter Vision Probe (M1.5 / M1.5.1 Final Correction)
 *
 * Reusable benchmark runner executing exactly ONE live inference HTTP POST request
 * via BenchmarkTransportGateway with cross-process single-writer locking and durable ledger.
 *
 * Target: All 22 distinct authentic manga pages of Zipang Chapter 54.
 * Workflow: English Scanlation -> Thai Translation (EN->TH).
 * Model: gemini-3.8-flash
 * Thinking: medium
 * Max Output Tokens: 65536
 * Temperature: 0.2
 *
 * M1.5.1 FINAL EVIDENCE CORRECTIONS:
 * 1. Region Manifest: Expected translation counts are derived strictly from the verified
 *    detector manifest (zipang-54-manifest.json, 139 total dialogue regions), NOT handwritten integers.
 * 2. Transmission Integrity: Transmitted images are verified against their cryptographic SHA-256 hashes.
 * 3. Fail-Closed Ledger: Missing benchmark ledger strictly blocks live dispatch.
 * 4. Mode Segregation: Explicitly distinguishes PRODUCTION_BBOX_TRANSLATION from FULL_PAGE_RECOGNITION.
 */

import fs from "fs";
import path from "path";
import { BenchmarkTransportGateway } from "../src/lib/gemini/benchmark-gateway";
import { getBenchmarkApiKey } from "./get-api-key";
import { getZipangCorpusPages, type ExtractedCorpusPage } from "./corpus-adapter";
import {
  loadChapterManifest,
  validateSubmissionAgainstManifest,
  validateTransmittedImageHash,
  computeSha256,
  type ChapterRegionManifest,
} from "../src/lib/gemini/region-manifest";

const EXPERIMENT_ID = "M1.5-EMPIRICAL-CAPACITY-BENCHMARK";
const TRIAL_ID = "trial-1-zipang54-full-chapter";

export type BenchmarkExecutionMode = "PRODUCTION_BBOX_TRANSLATION" | "FULL_PAGE_RECOGNITION";

export async function runTrial1(options?: {
  dryRun?: boolean;
  mode?: BenchmarkExecutionMode;
  customManifestPath?: string;
}) {
  const mode: BenchmarkExecutionMode = options?.mode || "PRODUCTION_BBOX_TRANSLATION";

  console.log("=================================================================");
  console.log(" MANGA-THAI — Mission M1.5.1: Empirical Capacity Benchmark");
  console.log(" TRIAL #1: Zipang Chapter 54 Full-Chapter Vision Probe (22 Pages)");
  console.log(` EXECUTION MODE: ${mode} (EN->TH Workflow)`);
  console.log("=================================================================\n");

  const gateway = new BenchmarkTransportGateway();
  // Fail-closed check: resumed execution strictly requires existing ledger
  const state = gateway.getLedgerState({ requireExisting: true });

  console.log(`Initial Mission Ledger State:`);
  console.log(`- Mission attempts consumed: ${state.missionAttemptsConsumed} / ${state.missionBudgetLimit}`);
  console.log(`- Mission attempts remaining: ${state.missionBudgetLimit - state.missionAttemptsConsumed}\n`);

  if (state.missionAttemptsConsumed >= state.missionBudgetLimit) {
    console.error("HARD SAFETY GATE: Mission budget exhausted! Aborting.");
    process.exit(1);
  }

  // Load authoritative Chapter Region Manifest (139 regions across 22 pages)
  const manifest = loadChapterManifest(options?.customManifestPath);
  console.log(`Loaded Authoritative Region Manifest:`);
  console.log(`- Chapter Key:            ${manifest.chapterKey}`);
  console.log(`- Total Pages:            ${manifest.totalPages}`);
  console.log(`- Total Dialogue Regions: ${manifest.totalDialogueRegions} (strictly detector-derived, NO handwritten values)\n`);

  const manifestMap = new Map(manifest.pages.map((p) => [p.pageId, p]));

  // Extract all 22 pages portably (Strict: requires exactly 22 authentic pages)
  const pages = getZipangCorpusPages();
  console.log(`Loaded ${pages.length} distinct real manga pages from Zipang Ch. 54.`);

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
  const expectedPages: Array<{ pageId: string; expectedCount: number }> = [];

  let totalImageBytes = 0;
  let totalExpectedDialogueBoxes = 0;

  for (const p of pages) {
    if (!p.base64Data) continue;
    const manifestPage = manifestMap.get(p.id);

    if (!manifestPage) {
      throw new Error(`UNREGISTERED PAGE ERROR: Page '${p.id}' is missing from the region manifest.`);
    }

    // Verify source image hash against manifest
    const sourceHash = computeSha256(p.base64Data);
    if (sourceHash !== manifestPage.sourceImageSha256) {
      throw new Error(
        `SOURCE INTEGRITY ERROR: Source image hash mismatch for page '${p.id}'. Expected ${manifestPage.sourceImageSha256}, got ${sourceHash}`,
      );
    }

    totalImageBytes += p.jpegBytesLength;

    if (mode === "PRODUCTION_BBOX_TRANSLATION") {
      // Derive expected count strictly from manifest region count (matching bboxes.length)
      const expectedCount = manifestPage.regionCount;
      totalExpectedDialogueBoxes += expectedCount;

      expectedPages.push({
        pageId: p.id,
        expectedCount,
      });

      const boxLabels = expectedCount > 0
        ? `Numbered dialogue regions: ${Array.from({ length: expectedCount }, (_, i) => `Box ${i + 1}`).join(", ")}`
        : "No dialogue (Cover/Art spread)";

      parts.push({ text: `Page ${p.pageNumber} (ID: "${p.id}", ${boxLabels}):` });
      parts.push({
        inlineData: {
          mimeType: p.mimeType,
          data: p.base64Data,
        },
      });
    } else {
      // FULL_PAGE_RECOGNITION: exploratory whole-page vision experiment
      expectedPages.push({
        pageId: p.id,
        expectedCount: -1, // dynamic recognition wildcard
      });

      parts.push({ text: `Page ${p.pageNumber} (ID: "${p.id}", Whole-Page Recognition):` });
      parts.push({
        inlineData: {
          mimeType: p.mimeType,
          data: p.base64Data,
        },
      });
    }
  }

  if (mode === "PRODUCTION_BBOX_TRANSLATION") {
    // Validate submission strictly against manifest: fails on any mismatch
    validateSubmissionAgainstManifest(manifest, expectedPages);
    console.log(`Manifest contract validation: PASSED (All 22 pages strictly match detector-derived region counts)`);
  } else {
    console.warn(
      `[MODE NOTICE: FULL_PAGE_RECOGNITION]: This mode is an exploratory whole-page vision experiment.\n` +
      `It does NOT provide production bounding-box coverage and CANNOT claim render-ready translations.`,
    );
  }

  console.log(`Constructed multimodal payload:`);
  console.log(`- Page count: ${pages.length}`);
  console.log(`- Total dialogue boxes: ${totalExpectedDialogueBoxes}`);
  console.log(`- Total JPEG bytes: ${(totalImageBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`- Estimated Base64 payload size: ~${((totalImageBytes * 4) / 3 / 1024 / 1024).toFixed(2)} MB`);
  console.log(`- Destination model: gemini-3.8-flash`);
  console.log(`- Thinking configuration: medium`);
  console.log(`- Max output tokens: 65,536\n`);

  if (options?.dryRun) {
    console.log("[DRY-RUN]: Preflight validation successful. Zero inference requests dispatched.");
    return;
  }

  const apiKey = getBenchmarkApiKey();

  const systemPrompt = `You are a professional manga translator working on the naval/historical series "Zipang".
The source manga scanlation is in ENGLISH. Your task is to translate all dialogue into natural, accurate, immersive THAI (ภาษาไทย).
Target Workflow: English dialogue -> Thai translation (EN->TH).
You are provided with 22 sequential manga pages from Chapter 54 in document reading order: ${pages.map((p) => `Page ${p.pageNumber} (ID: "${p.id}")`).join(", ")}.
For each page, read all dialogue, narration, radar reports, and ship communications in reading order (right-to-left, top-to-bottom for manga).
Maintain the military/naval terminology (e.g. ship coordinates, bearings, radar ranges, Mirai crew dialogue) and dramatic historical tone.

CRITICAL INSTRUCTIONS:
1. Output strictly valid JSON matching this schema:
{
  "pages": [
${pages
  .map((p) => {
    const manifestP = manifestMap.get(p.id)!;
    const count = manifestP.regionCount;
    const transEx = Array.from({ length: count }, (_, i) => `"คำแปลบทพูด ${i + 1}"`).join(", ");
    const srcEx = Array.from({ length: count }, (_, i) => `"English dialogue ${i + 1}"`).join(", ");
    return `    {\n      "pageId": "${p.id}",\n      "translations": [${transEx}],\n      "sourceTexts": [${srcEx}]\n    }`;
  })
  .join(",\n")}
  ],
  "context": {
    "summary": "1-2 sentence series context in English",
    "dictionary": "Original naval/military term -> English Translation"
  }
}
2. "translations" MUST contain the THAI translation for each dialogue box/bubble on that page in reading order.
3. "sourceTexts" MUST contain the original English text transcribed verbatim from that page.
4. "translations" and "sourceTexts" arrays for each page MUST have the EXACT expected length:
${expectedPages.map((p) => `   - Page "${p.pageId}": exactly ${p.expectedCount} items`).join("\n")}
5. If a page has no dialogue (e.g. page_9 art spread with 0 regions), output empty arrays: "translations": [], "sourceTexts": [].
6. Never mix up or swap dialogue between pages. Maintain strict pageId assignment for all 22 pages.
`;

  const userPrompt = `Please translate all dialogue in the 22 provided pages of Zipang Chapter 54 from English into Thai in reading order.
Ensure every page from "${pages[0].id}" to "${pages[pages.length - 1].id}" has a corresponding object in the "pages" array with matching translations and sourceTexts.
Output strictly the JSON structure without markdown code blocks.`;

  console.log("Dispatching live inference request through BenchmarkTransportGateway...");
  console.log("NOTE: Strict single-shot dispatch with timeout 240s. Zero retries.\n");

  const startTime = Date.now();
  const result = await gateway.executeBenchmarkInference({
    experimentId: EXPERIMENT_ID,
    trialId: TRIAL_ID,
    apiKey,
    model: "gemini-3.8-flash",
    temperature: 0.2,
    maxOutputTokens: 65536,
    thinkingLevel: "medium",
    systemPrompt,
    userPrompt,
    parts,
    expectedPages,
    timeoutMs: 240_000,
  });

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nInference request completed in ${durationSec}s.`);
  console.log(`Result success: ${result.success}`);
  console.log(`HTTP Status: ${result.entry.httpStatus}`);
  console.log(`Dispatch Status: ${result.entry.dispatchStatus}`);

  if (result.entry.error) {
    console.error(`Error encountered: ${result.entry.error}`);
  }

  if (result.entry.usageMetadata) {
    console.log("\n=== TOKEN TELEMETRY METRICS ===");
    console.log(`- promptTokenCount:     ${result.entry.usageMetadata.promptTokenCount}`);
    console.log(`- candidatesTokenCount: ${result.entry.usageMetadata.candidatesTokenCount}`);
    console.log(`- thoughtsTokenCount:   ${result.entry.usageMetadata.thoughtsTokenCount ?? 0}`);
    console.log(`- totalTokenCount:      ${result.entry.usageMetadata.totalTokenCount}`);

    // M1.5.1 Section 4: candidatesTokenCount and thoughtsTokenCount are separate instrumented counters from provider.
    // They are NOT subtracted!
    if (pages.length > 0) {
      const cand = result.entry.usageMetadata.candidatesTokenCount || 0;
      const thoughts = result.entry.usageMetadata.thoughtsTokenCount || 0;
      console.log(`- candidatesTokensPerPage: ${(cand / pages.length).toFixed(1)} tokens/page`);
      if (thoughts > 0) {
        console.log(`- thoughtsTokensPerPage:   ${(thoughts / pages.length).toFixed(1)} tokens/page`);
      }
    }
  }

  const auditPath = path.resolve(process.cwd(), "trial-1-raw-response.json");
  if (result.rawText) {
    fs.writeFileSync(auditPath, result.rawText, "utf8");
    console.log(`Raw model response saved to: ${auditPath}`);
  }

  if (result.recovered) {
    console.log("\n=== RECOVERY AND VERIFICATION RESULTS ===");
    console.log(`- Completed valid pages: ${result.recovered.completedPages.length} / ${pages.length}`);
    console.log(`- Unfinished pages:      ${result.recovered.unfinishedPageIds.length}`);
    console.log(`- Fully complete:        ${result.recovered.isFullyComplete}`);
    console.log(`- Truncated:             ${result.recovered.isTruncated}`);
  }

  const finalState = gateway.getLedgerState();
  console.log(`\nUpdated Mission Ledger:`);
  console.log(`- Mission attempts consumed: ${finalState.missionAttemptsConsumed} / ${finalState.missionBudgetLimit}`);
  console.log(`- Mission attempts remaining: ${finalState.missionBudgetLimit - finalState.missionAttemptsConsumed}`);
}

if (import.meta.main) {
  // STRICT M1.5.1 RULE: Default invocation is dry-run only; no live generateContent call
  const isLiveAuthorized = process.argv.includes("--authorized-live");
  runTrial1({ dryRun: !isLiveAuthorized }).catch(console.error);
}
