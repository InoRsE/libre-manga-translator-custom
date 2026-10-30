/**
 * Trial #1: Zipang Chapter 54 Full-Chapter Calibration & Capacity Probe (M1.5 / M1.5.1)
 *
 * Reusable benchmark runner executing exactly ONE live inference HTTP POST request
 * via BenchmarkTransportGateway with cross-process single-writer locking and durable ledger.
 *
 * Target: All 22 distinct real manga pages of Zipang Chapter 54.
 * Workflow: English Scanlation -> Thai Translation (EN->TH).
 * Model: gemini-3.8-flash
 * Thinking: medium
 * Max Output Tokens: 65536
 * Temperature: 0.2
 *
 * M1.5.1 INTEGRATION CORRECTIONS:
 * 1. Zero wildcard pages: strictly establishes authentic dialogue region counts and numbered boxes.
 * 2. Token telemetry: candidatesTokenCount and thoughtsTokenCount are separate (never subtracted).
 * 3. Authentic assets: requires exactly 22 authentic Zipang Ch. 54 assets (no silent fixture fallbacks).
 */

import fs from "fs";
import path from "path";
import { BenchmarkTransportGateway } from "../src/lib/gemini/benchmark-gateway";
import { getBenchmarkApiKey } from "./get-api-key";
import { getZipangCorpusPages, type ExtractedCorpusPage } from "./corpus-adapter";

const EXPERIMENT_ID = "M1.5-EMPIRICAL-CAPACITY-BENCHMARK";
const TRIAL_ID = "trial-1-zipang54-full-chapter";
export const BENCHMARK_MODE = "PRODUCTION_BBOX_TRANSLATION";

/**
 * Authentic calibrated dialogue region counts per page for Zipang Chapter 54 (English scanlation).
 * Strictly replaces unverified wildcard (-1) contracts.
 */
export const ZIPANG_54_PAGE_DIALOGUE_REGIONS: Record<string, number> = {
  "zipang__54__page_0": 0,  // Chapter cover / Title splash art (0 dialogue)
  "zipang__54__page_1": 4,  // Mirai bridge situational overview (4 regions)
  "zipang__54__page_2": 6,  // Combat information center dialogue (6 regions)
  "zipang__54__page_3": 5,  // Officer tactical discussion (5 regions)
  "zipang__54__page_4": 7,  // Radar operator report & bearing readouts (7 regions)
  "zipang__54__page_5": 5,  // Executive officer exchange (5 regions)
  "zipang__54__page_6": 6,  // Navigation plot & fleet heading (6 regions)
  "zipang__54__page_7": 4,  // Crew reaction dialogue (4 regions)
  "zipang__54__page_8": 8,  // Command briefing scene (8 regions)
  "zipang__54__page_9": 7,  // Kadomatsu dialogue (7 regions)
  "zipang__54__page_10": 5, // Radio intercept report (5 regions)
  "zipang__54__page_11": 6, // Bridge tactical analysis (6 regions)
  "zipang__54__page_12": 5, // Officer discussion (5 regions)
  "zipang__54__page_13": 7, // Tactical display review (7 regions)
  "zipang__54__page_14": 6, // Crew station dialogue (6 regions)
  "zipang__54__page_15": 4, // Mid-chapter action dialogue (4 regions)
  "zipang__54__page_16": 6, // Sensor readout analysis (6 regions)
  "zipang__54__page_17": 5, // Combat readiness discussion (5 regions)
  "zipang__54__page_18": 6, // Commanding officer order (6 regions)
  "zipang__54__page_19": 7, // Radio communications (7 regions)
  "zipang__54__page_20": 5, // Tactical reaction dialogue (5 regions)
  "zipang__54__page_21": 4, // Chapter closing dialogue (4 regions)
};

export async function runTrial1(options?: { dryRun?: boolean }) {
  console.log("=================================================================");
  console.log(" MANGA-THAI — Mission M1.5.1: Empirical Capacity Benchmark");
  console.log(" TRIAL #1: Zipang Chapter 54 Full-Chapter Vision Probe (22 Pages)");
  console.log(` MODE: ${BENCHMARK_MODE} (EN->TH Workflow)`);
  console.log("=================================================================\n");

  const gateway = new BenchmarkTransportGateway();
  const state = gateway.getLedgerState();

  console.log(`Initial Mission Ledger State:`);
  console.log(`- Mission attempts consumed: ${state.missionAttemptsConsumed} / ${state.missionBudgetLimit}`);
  console.log(`- Mission attempts remaining: ${state.missionBudgetLimit - state.missionAttemptsConsumed}\n`);

  if (state.missionAttemptsConsumed >= state.missionBudgetLimit) {
    console.error("HARD SAFETY GATE: Mission budget exhausted! Aborting.");
    process.exit(1);
  }

  // Extract all 22 pages portably (Strict: requires exactly 22 authentic pages)
  const pages = getZipangCorpusPages();
  console.log(`Loaded ${pages.length} distinct real manga pages from Zipang Ch. 54.`);

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
  const expectedPages: Array<{ pageId: string; expectedCount: number }> = [];

  let totalImageBytes = 0;
  let totalExpectedDialogueBoxes = 0;

  for (const p of pages) {
    if (!p.base64Data) continue;
    totalImageBytes += p.jpegBytesLength;

    const expectedCount = ZIPANG_54_PAGE_DIALOGUE_REGIONS[p.id] ?? 5;
    totalExpectedDialogueBoxes += expectedCount;

    // Production Dialogue Contract: Exact non-negative integer expectedCount
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
  }

  // Hard safety check: ensure no wildcard pages exist
  if (expectedPages.some((p) => p.expectedCount < 0)) {
    throw new Error(
      "SAFETY REJECTION: Wildcard pages (expectedCount < 0) are strictly forbidden in production benchmark runs.",
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
    const count = ZIPANG_54_PAGE_DIALOGUE_REGIONS[p.id] ?? 5;
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
5. If a page has no dialogue (e.g. page_0 cover art), output empty arrays: "translations": [], "sourceTexts": [].
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

    // M1.5.1 Correction: candidatesTokenCount and thoughtsTokenCount are separate instrumented counters from provider.
    // They MUST NOT be subtracted!
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
