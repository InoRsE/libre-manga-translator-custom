/**
 * MAX-First Capacity Preflight Tool (M1.4 ACTION E)
 *
 * Evaluates candidate batch sizes against Gemini API token limits, context window,
 * candidate output token limits, HTTP payload boundaries, and RPM/TPM quotas.
 *
 * Scopes:
 * - Priority A: Zipang Ch. 54–265 (212 chapters, ~4,664 pages)
 * - Priority B: Zipang Ch. 1–265 (265 chapters, ~5,830 pages)
 * - Ideal stretch target: Entire 265-chapter collection within <= 20 inference requests.
 *
 * Run with: bun scripts/max-batch-preflight.ts
 */

export interface BatchCandidateAnalysis {
  batchSize: number;
  inputTokensEstimated: number;
  outputTokensEstimated: number;
  payloadSizeMbEstimated: number;
  requestsPriorityA: number; // 212 chapters (~4,664 pages)
  requestsPriorityB: number; // 265 chapters (~5,830 pages)
  fitsContextWindow1M: boolean;
  fitsOutputLimit8k: boolean;
  fitsOutputLimit65k: boolean;
  fitsInlineHttp20Mb: boolean;
  requiresFileApi: boolean;
  feasibilityVerdict: "OPTIMAL" | "FEASIBLE" | "BORDERLINE" | "INFEASIBLE";
  keyBottleneck: string;
}

// Modeling parameters based on Zipang empirical metrics
const AVG_PAGES_PER_CHAPTER = 22;
const PRIORITY_A_CHAPTERS = 212; // Ch 54-265
const PRIORITY_A_PAGES = PRIORITY_A_CHAPTERS * AVG_PAGES_PER_CHAPTER; // 4,664 pages
const PRIORITY_B_CHAPTERS = 265; // Ch 1-265
const PRIORITY_B_PAGES = PRIORITY_B_CHAPTERS * AVG_PAGES_PER_CHAPTER; // 5,830 pages

// Gemini Multimodal Token & System Constants
const TOKENS_PER_IMAGE_TILE = 258; // Gemini standard vision tile
const TILES_PER_MANGA_PAGE = 3; // ~1200x800 page tiles into 2-3 patches
const IMAGE_TOKENS_PER_PAGE = TOKENS_PER_IMAGE_TILE * TILES_PER_MANGA_PAGE; // ~774 tokens
const PROMPT_TOKENS_PER_PAGE = 150; // System instructions + bounding box coordinate metadata
const TOTAL_INPUT_TOKENS_PER_PAGE = IMAGE_TOKENS_PER_PAGE + PROMPT_TOKENS_PER_PAGE; // ~924 tokens

const AVG_BUBBLES_PER_PAGE = 8;
const TOKENS_PER_THAI_TRANSLATION = 22; // ~22 tokens per dialogue balloon in Thai script
const OUTPUT_TOKENS_PER_PAGE = AVG_BUBBLES_PER_PAGE * TOKENS_PER_THAI_TRANSLATION; // ~176 tokens

const AVG_JPEG_PAGE_SIZE_KB = 280; // Compressed JPEG manga scan
const INLINE_REST_PAYLOAD_LIMIT_MB = 20; // Google Generative Language REST limit
const GEMINI_CONTEXT_WINDOW_1M = 1_048_576;
const GEMINI_OUTPUT_LIMIT_8K = 8_192;
const GEMINI_OUTPUT_LIMIT_65K = 65_536;

export const CANDIDATE_BATCH_SIZES = [
  3600, 1024, 512, 464, 384, 292, 256, 128, 64, 32,
];

export function analyzeBatchCandidate(batchSize: number): BatchCandidateAnalysis {
  const inputTokens = batchSize * TOTAL_INPUT_TOKENS_PER_PAGE;
  const outputTokens = batchSize * OUTPUT_TOKENS_PER_PAGE;
  const payloadMb = (batchSize * AVG_JPEG_PAGE_SIZE_KB) / 1024;

  const requestsA = Math.ceil(PRIORITY_A_PAGES / batchSize);
  const requestsB = Math.ceil(PRIORITY_B_PAGES / batchSize);

  const fitsContextWindow1M = inputTokens <= GEMINI_CONTEXT_WINDOW_1M;
  const fitsOutputLimit8k = outputTokens <= GEMINI_OUTPUT_LIMIT_8K;
  const fitsOutputLimit65k = outputTokens <= GEMINI_OUTPUT_LIMIT_65K;
  const fitsInlineHttp20Mb = payloadMb <= INLINE_REST_PAYLOAD_LIMIT_MB;
  const requiresFileApi = !fitsInlineHttp20Mb;

  let feasibilityVerdict: "OPTIMAL" | "FEASIBLE" | "BORDERLINE" | "INFEASIBLE" = "FEASIBLE";
  let keyBottleneck = "None (Fully balanced)";

  if (!fitsContextWindow1M) {
    feasibilityVerdict = "INFEASIBLE";
    keyBottleneck = `Context window exceeded (${Math.round(inputTokens / 1000)}k > 1,048k tokens)`;
  } else if (!fitsOutputLimit65k) {
    feasibilityVerdict = "INFEASIBLE";
    keyBottleneck = `Output token limit exceeded (${Math.round(outputTokens / 1000)}k > 65k tokens)`;
  } else if (outputTokens > 55_000) {
    feasibilityVerdict = "BORDERLINE";
    keyBottleneck = `Near max candidate limit (${Math.round(outputTokens / 1000)}k tokens, riesgo of truncation)`;
  } else if (fitsInlineHttp20Mb && fitsOutputLimit8k) {
    feasibilityVerdict = "OPTIMAL";
    keyBottleneck = "None (Fits standard REST inline & 8k limits)";
  } else if (fitsInlineHttp20Mb && fitsOutputLimit65k) {
    feasibilityVerdict = "OPTIMAL";
    keyBottleneck = "Requires Gemini 2.0/2.5/3.7 Flash (65k output limit)";
  } else if (requiresFileApi && fitsOutputLimit65k) {
    feasibilityVerdict = "FEASIBLE";
    keyBottleneck = "Requires Gemini File API (Payload > 20MB)";
  }

  return {
    batchSize,
    inputTokensEstimated: inputTokens,
    outputTokensEstimated: outputTokens,
    payloadSizeMbEstimated: Math.round(payloadMb * 10) / 10,
    requestsPriorityA: requestsA,
    requestsPriorityB: requestsB,
    fitsContextWindow1M,
    fitsOutputLimit8k,
    fitsOutputLimit65k,
    fitsInlineHttp20Mb,
    requiresFileApi,
    feasibilityVerdict,
    keyBottleneck,
  };
}

export function generatePreflightReport(): string {
  const results = CANDIDATE_BATCH_SIZES.map(analyzeBatchCandidate);

  let md = "# MAX-First Capacity Preflight Analysis: Zipang 1–265\n\n";
  md += `**Scope Definitions:**\n`;
  md += `- Priority A: Chapters 54–265 (${PRIORITY_A_CHAPTERS} chapters = ~${PRIORITY_A_PAGES.toLocaleString()} pages)\n`;
  md += `- Priority B: Chapters 1–265 (${PRIORITY_B_CHAPTERS} chapters = ~${PRIORITY_B_PAGES.toLocaleString()} pages)\n`;
  md += `- Ideal Stretch Target: Complete all 265 chapters in <= 20 inference requests\n`;
  md += `- Modeling parameters: ${AVG_PAGES_PER_CHAPTER} pages/ch, ${AVG_BUBBLES_PER_PAGE} bubbles/page, ~${TOTAL_INPUT_TOKENS_PER_PAGE} input tok/page, ~${OUTPUT_TOKENS_PER_PAGE} out tok/page\n\n`;

  md += `## 1. Candidate Batch Size Matrix\n\n`;
  md += `| Batch Size | Input Tokens | Output Tokens | Payload (MB) | Req (Ch 54-265) | Req (Ch 1-265) | Inline REST | Gemini 65k Out | Verdict |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;

  for (const r of results) {
    const inlineStr = r.fitsInlineHttp20Mb ? "YES" : "NO (File API)";
    const outStr = r.fitsOutputLimit65k ? "YES" : "EXCEEDED";
    md += `| **${r.batchSize}** | ${r.inputTokensEstimated.toLocaleString()} | ${r.outputTokensEstimated.toLocaleString()} | ${r.payloadSizeMbEstimated} MB | ${r.requestsPriorityA} | ${r.requestsPriorityB} | ${inlineStr} | ${outStr} | **${r.feasibilityVerdict}** |\n`;
  }

  md += `\n## 2. Stretch Target Assessment: 265 Chapters in <= 20 Requests\n\n`;
  const stretchReqs = 20;
  const pagesPerStretchReq = Math.ceil(PRIORITY_B_PAGES / stretchReqs);
  const stretchAnalysis = analyzeBatchCandidate(pagesPerStretchReq);

  md += `- Required batch size for <= 20 requests: **${pagesPerStretchReq} pages/request** (~${Math.round(pagesPerStretchReq / AVG_PAGES_PER_CHAPTER)} chapters/request)\n`;
  md += `- Total Input Tokens per request: **${stretchAnalysis.inputTokensEstimated.toLocaleString()} tokens** (${Math.round((stretchAnalysis.inputTokensEstimated / GEMINI_CONTEXT_WINDOW_1M) * 100)}% of 1M context window)\n`;
  md += `- Total Output Tokens per request: **${stretchAnalysis.outputTokensEstimated.toLocaleString()} tokens** (${Math.round((stretchAnalysis.outputTokensEstimated / GEMINI_OUTPUT_LIMIT_65K) * 100)}% of 65k candidate limit)\n`;
  md += `- Total Payload per request: **${stretchAnalysis.payloadSizeMbEstimated} MB** (Exceeds 20MB inline HTTP, requires Gemini File API upload)\n`;
  md += `- **Scientific Verdict:** **${stretchAnalysis.feasibilityVerdict}**. Completing the entire 265-chapter collection in exactly 20 requests is technically possible with Gemini 2.5/3.7 Flash, but requires the File API and leaves little safety margin against token truncation.\n\n`;

  md += `## 3. Key Findings & Concrete Recommendations\n\n`;
  md += `1. **Output Token Limit is the Hard Ceiling, NOT Context Window:**\n`;
  md += `   - The 1M token input context window can easily hold 1,000+ manga pages.\n`;
  md += `   - However, Gemini's candidate output limit is capped at 8,192 tokens (for 1.5 Flash) or 65,536 tokens (for 2.0/2.5/3.7 Flash).\n`;
  md += `   - Any batch size > 372 pages strictly exceeds the 65k output token ceiling and will result in truncated dialogue.\n\n`;

  md += `2. **Inline HTTP vs File API Boundary:**\n`;
  md += `   - Standard extension background requests using inline ` + "`image/jpeg`" + ` data are limited to ~20MB (approx. **64 pages**).\n`;
  md += `   - Batch sizes > 64 pages require uploading images via the Gemini Files API (` + "`media.upload`" + `) rather than sending inline base64 strings.\n\n`;

  md += `3. **Recommended Production Phasing:**\n`;
  md += `   - **Phase 1 (Immediate - Extension Native): Batch Size = 32 to 64 pages.**\n`;
  md += `     - 100% inline REST compliant (no File API needed).\n`;
  md += `     - Fits safely within 8k-12k candidate token budgets.\n`;
  md += `     - Priority A (Zipang 54–265) takes only ~73 to 146 total API calls.\n`;
  md += `   - **Phase 2 (High-Throughput Offline Preparation): Batch Size = 256 pages.**\n`;
  md += `     - Uses Gemini File API and Gemini 3.7 Flash (65k output limit).\n`;
  md += `     - Completes Priority A in only **19 API requests**!\n`;
  md += `     - Completes Priority B (Chapters 1–265) in only **23 API requests**!\n`;

  return md;
}

if (import.meta.main) {
  const report = generatePreflightReport();
  console.log(report);
}
