/**
 * Trial #1: Zipang Chapter 54 Full-Chapter Calibration & Capacity Probe (M1.5 / M1.5.1)
 *
 * Reusable benchmark runner executing exactly ONE live inference HTTP POST request
 * via BenchmarkTransportGateway with cross-process single-writer locking and durable ledger.
 *
 * Target: All 22 distinct real manga pages of Zipang Chapter 54.
 * Model: gemini-3.8-flash
 * Thinking: medium
 * Max Output Tokens: 65536
 * Temperature: 0.2
 */

import fs from "fs";
import path from "path";
import { BenchmarkTransportGateway } from "../src/lib/gemini/benchmark-gateway";
import { getBenchmarkApiKey } from "./get-api-key";
import { getZipangCorpusPages, type ExtractedCorpusPage } from "./corpus-adapter";

const EXPERIMENT_ID = "M1.5-EMPIRICAL-CAPACITY-BENCHMARK";
const TRIAL_ID = "trial-1-zipang54-full-chapter";

export async function runTrial1(options?: { dryRun?: boolean }) {
  console.log("=================================================================");
  console.log(" MANGA-THAI — Mission M1.5.1: Empirical Capacity Benchmark");
  console.log(" TRIAL #1: Zipang Chapter 54 Full-Chapter Vision Probe (22 Pages)");
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

  // Extract all 22 pages portably
  const pages = getZipangCorpusPages();
  console.log(`Loaded ${pages.length} distinct real manga pages from Zipang Ch. 54.`);

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
  const expectedPages: Array<{ pageId: string; expectedCount: number }> = [];

  let totalImageBytes = 0;
  for (const p of pages) {
    if (!p.base64Data) continue;
    totalImageBytes += p.jpegBytesLength;

    parts.push({ text: `Page ${p.pageNumber} (ID: "${p.id}"):` });
    parts.push({
      inlineData: {
        mimeType: p.mimeType,
        data: p.base64Data,
      },
    });

    // Production Dialogue Contract: Each page registers its expected dialogue region count
    expectedPages.push({
      pageId: p.id,
      expectedCount: -1, // dynamic dialogue contract when raw scans are submitted
    });
  }

  console.log(`Constructed multimodal payload:`);
  console.log(`- Page count: ${pages.length}`);
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
You are provided with 22 sequential manga pages from Chapter 54 in document reading order: ${pages.map((p) => `Page ${p.pageNumber} (ID: "${p.id}")`).join(", ")}.
For each page, read all dialogue, narration, radar reports, and ship communications in reading order (right-to-left, top-to-bottom for manga).
Translate the text into natural, accurate, immersive THAI (ภาษาไทย).
Maintain the military/naval terminology (e.g. ship coordinates, bearings, radar ranges, Mirai crew dialogue) and dramatic historical tone.

CRITICAL INSTRUCTIONS:
1. Output strictly valid JSON matching this schema:
{
  "pages": [
${pages
  .map(
    (p) =>
      `    {\n      "pageId": "${p.id}",\n      "translations": ["คำแปลบทพูด 1", "คำแปลบทพูด 2"],\n      "sourceTexts": ["Original text 1", "Original text 2"]\n    }`,
  )
  .join(",\n")}
  ],
  "context": {
    "summary": "1-2 sentence series context in English",
    "dictionary": "Original naval/military term -> English Translation"
  }
}
2. "translations" MUST contain the THAI translation for each dialogue box/bubble on that page in reading order.
3. "sourceTexts" MUST contain the original text transcribed verbatim from that page.
4. "translations" and "sourceTexts" arrays for each page MUST have the exact same number of items.
5. If a page has no dialogue (e.g. action or pure art), output empty arrays: "translations": [], "sourceTexts": [].
6. Never mix up or swap dialogue between pages. Maintain strict pageId assignment for all 22 pages.
`;

  const userPrompt = `Please translate all dialogue in the 22 provided pages of Zipang Chapter 54 in reading order.
Ensure every page from "${pages[0].id}" to "${pages[pages.length - 1].id}" has a corresponding object in the "pages" array.
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
    console.log(`- thoughtsTokenCount:   ${result.entry.usageMetadata.thoughtsTokenCount}`);
    console.log(`- totalTokenCount:      ${result.entry.usageMetadata.totalTokenCount}`);

    const candidateExclThinking =
      (result.entry.usageMetadata.candidatesTokenCount || 0) -
      (result.entry.usageMetadata.thoughtsTokenCount || 0);
    console.log(`- pureTranslationOutputTokens: ${candidateExclThinking}`);
    if (pages.length > 0) {
      console.log(`- candidateTokensPerPage:     ${(candidateExclThinking / pages.length).toFixed(1)} tokens/page`);
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
