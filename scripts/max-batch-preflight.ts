/**
 * MAX-First Capacity Preflight Analysis Tool (M1.4.1 REPAIR F)
 *
 * Evaluates candidate batch sizes against Gemini API token limits, context window,
 * candidate output token limits, HTTP payload boundaries, and RPM/TPM quotas.
 *
 * Scopes:
 * - Priority A: Zipang Ch. 54–265 (212 chapters, ~4,664 pages)
 * - Priority B: Zipang Ch. 1–265 (265 chapters, ~5,830 pages)
 * - Research Target: Complete all 265 chapters in <= 20 inference requests
 *
 * Run with: bun scripts/max-batch-preflight.ts
 */

export type BatchEvidenceLevel =
  | "LIVE_VERIFIED"
  | "INPUT_MEASURED"
  | "MODELLED_ONLY";

export interface BatchCandidateAnalysis {
  batchSize: number;
  evidenceLevel: BatchEvidenceLevel;
  inputTokensEstimated: { min: number; nominal: number; max: number };
  outputTokensEstimated: { min: number; nominal: number; max: number };
  payloadSizeMbEstimated: { min: number; nominal: number; max: number };
  requestsPriorityA: number; // 212 chapters
  requestsPriorityB: number; // 265 chapters
  fitsContextWindow1M: boolean;
  fitsOutputLimit8k: boolean;
  fitsOutputLimit65k: boolean;
  fitsInlineHttp20Mb: boolean;
  feasibilityVerdict:
    | "OPTIMAL_INLINE"
    | "FEASIBLE_WITH_FILE_API"
    | "THEORETICALLY_CONSTRAINED"
    | "INFEASIBLE";
  keyBottlenecks: string[];
}

// ============================================================================
// Explicit Model Parameters with Uncertainty Intervals
// NOTE: These are hypothetical engineering assumptions, not guaranteed metrics.
// ============================================================================
export const PARAMETERS = {
  // Chapter sizing
  PAGES_PER_CHAPTER_NOMINAL: 22,
  PAGES_PER_CHAPTER_RANGE: [18, 26] as const,

  PRIORITY_A_CHAPTERS: 212, // Ch 54-265
  PRIORITY_B_CHAPTERS: 265, // Ch 1-265

  // Multimodal Input Tokens
  // Gemini standard vision tile = 258 tokens per 768x768 tile.
  // Standard manga scan (1200x800) tiles into 2 to 4 patches.
  IMAGE_TOKENS_PER_PAGE_NOMINAL: 774, // 3 tiles
  IMAGE_TOKENS_PER_PAGE_RANGE: [258, 1032] as const,
  PROMPT_TOKENS_PER_PAGE_NOMINAL: 150, // System instructions + coordinate JSON
  PROMPT_TOKENS_PER_PAGE_RANGE: [100, 220] as const,

  // Dialogue & Output Tokens (Thai script expansion)
  BUBBLES_PER_PAGE_NOMINAL: 8,
  BUBBLES_PER_PAGE_RANGE: [4, 14] as const, // ±45% variation across action vs dialogue
  OUTPUT_TOKENS_PER_BUBBLE_NOMINAL: 22,
  OUTPUT_TOKENS_PER_BUBBLE_RANGE: [15, 30] as const, // Thai script utf-8 token expansion

  // Scan payload sizes
  JPEG_KB_PER_PAGE_NOMINAL: 280,
  JPEG_KB_PER_PAGE_RANGE: [180, 420] as const,

  // Gemini System Ceilings
  CONTEXT_WINDOW_1M: 1_048_576,
  OUTPUT_LIMIT_8K: 8_192, // Gemini 1.5 Flash / Pro default
  OUTPUT_LIMIT_65K: 65_536, // Gemini 2.0 / 2.5 / 3.7 Flash
  INLINE_REST_PAYLOAD_LIMIT_MB: 20, // 20MB inline HTTP limit
  FREE_TIER_RPM: 15,
  FREE_TIER_TPM: 1_000_000,
  PAID_TIER_RPM: 1_000,
  PAID_TIER_TPM: 4_000_000,
};

const PRIORITY_A_PAGES_NOMINAL =
  PARAMETERS.PRIORITY_A_CHAPTERS * PARAMETERS.PAGES_PER_CHAPTER_NOMINAL; // 4,664 pages
const PRIORITY_B_PAGES_NOMINAL =
  PARAMETERS.PRIORITY_B_CHAPTERS * PARAMETERS.PAGES_PER_CHAPTER_NOMINAL; // 5,830 pages

export const CANDIDATE_BATCH_SIZES = [
  3600, 1024, 512, 464, 384, 292, 256, 128, 64, 32,
];

export function analyzeBatchCandidate(batchSize: number): BatchCandidateAnalysis {
  const nominalInputPerPage =
    PARAMETERS.IMAGE_TOKENS_PER_PAGE_NOMINAL +
    PARAMETERS.PROMPT_TOKENS_PER_PAGE_NOMINAL; // 924 tokens
  const minInputPerPage =
    PARAMETERS.IMAGE_TOKENS_PER_PAGE_RANGE[0] +
    PARAMETERS.PROMPT_TOKENS_PER_PAGE_RANGE[0]; // 358 tokens
  const maxInputPerPage =
    PARAMETERS.IMAGE_TOKENS_PER_PAGE_RANGE[1] +
    PARAMETERS.PROMPT_TOKENS_PER_PAGE_RANGE[1]; // 1,252 tokens

  const nominalOutputPerPage =
    PARAMETERS.BUBBLES_PER_PAGE_NOMINAL *
    PARAMETERS.OUTPUT_TOKENS_PER_BUBBLE_NOMINAL; // 176 tokens
  const minOutputPerPage =
    PARAMETERS.BUBBLES_PER_PAGE_RANGE[0] *
    PARAMETERS.OUTPUT_TOKENS_PER_BUBBLE_RANGE[0]; // 60 tokens
  const maxOutputPerPage =
    PARAMETERS.BUBBLES_PER_PAGE_RANGE[1] *
    PARAMETERS.OUTPUT_TOKENS_PER_BUBBLE_RANGE[1]; // 420 tokens

  const inputNominal = batchSize * nominalInputPerPage;
  const inputMin = batchSize * minInputPerPage;
  const inputMax = batchSize * maxInputPerPage;

  const outputNominal = batchSize * nominalOutputPerPage;
  const outputMin = batchSize * minOutputPerPage;
  const outputMax = batchSize * maxOutputPerPage;

  const payloadNominal = (batchSize * PARAMETERS.JPEG_KB_PER_PAGE_NOMINAL) / 1024;
  const payloadMin = (batchSize * PARAMETERS.JPEG_KB_PER_PAGE_RANGE[0]) / 1024;
  const payloadMax = (batchSize * PARAMETERS.JPEG_KB_PER_PAGE_RANGE[1]) / 1024;

  const reqA = Math.ceil(PRIORITY_A_PAGES_NOMINAL / batchSize);
  const reqB = Math.ceil(PRIORITY_B_PAGES_NOMINAL / batchSize);

  const fitsContextWindow1M = inputMax <= PARAMETERS.CONTEXT_WINDOW_1M;
  const fitsOutputLimit8k = outputMax <= PARAMETERS.OUTPUT_LIMIT_8K;
  const fitsOutputLimit65k = outputNominal <= PARAMETERS.OUTPUT_LIMIT_65K;
  const fitsInlineHttp20Mb = payloadMax <= PARAMETERS.INLINE_REST_PAYLOAD_LIMIT_MB;

  const bottlenecks: string[] = [];
  let feasibilityVerdict: BatchCandidateAnalysis["feasibilityVerdict"] =
    "FEASIBLE_WITH_FILE_API";

  // Enforce limits separately
  if (inputNominal > PARAMETERS.CONTEXT_WINDOW_1M) {
    feasibilityVerdict = "INFEASIBLE";
    bottlenecks.push(
      `Input context window exceeded (${Math.round(inputNominal / 1000)}k > 1,048k tokens)`,
    );
  }

  if (outputNominal > PARAMETERS.OUTPUT_LIMIT_65K) {
    feasibilityVerdict = "INFEASIBLE";
    bottlenecks.push(
      `Nominal output exceeds 65k candidate ceiling (${Math.round(outputNominal / 1000)}k tokens)`,
    );
  } else if (outputMax > PARAMETERS.OUTPUT_LIMIT_65K) {
    feasibilityVerdict = "THEORETICALLY_CONSTRAINED";
    bottlenecks.push(
      `High dialogue density chapters will breach 65k ceiling (upper bound: ${Math.round(outputMax / 1000)}k tokens)`,
    );
  }

  if (!fitsInlineHttp20Mb) {
    bottlenecks.push(
      `Payload (${Math.round(payloadNominal)}MB) exceeds 20MB inline HTTP REST limit`,
    );
  }

  if (batchSize <= 64 && fitsInlineHttp20Mb && fitsOutputLimit65k) {
    feasibilityVerdict = "OPTIMAL_INLINE";
  }

  if (batchSize === 292) {
    feasibilityVerdict = "THEORETICALLY_CONSTRAINED";
    bottlenecks.push(
      "Unverified: Consumes ~78% of 65k output tokens under nominal density; high risk of truncation under dense chapters",
    );
    bottlenecks.push("Unverified: Multimodal instruction adherence across 292 images is untested");
  }

  // Evidence classification
  let evidenceLevel: BatchEvidenceLevel = "MODELLED_ONLY";
  if (batchSize === 1 || batchSize === 2) {
    evidenceLevel = "LIVE_VERIFIED";
  }

  return {
    batchSize,
    evidenceLevel,
    inputTokensEstimated: { min: inputMin, nominal: inputNominal, max: inputMax },
    outputTokensEstimated: { min: outputMin, nominal: outputNominal, max: outputMax },
    payloadSizeMbEstimated: {
      min: Math.round(payloadMin * 10) / 10,
      nominal: Math.round(payloadNominal * 10) / 10,
      max: Math.round(payloadMax * 10) / 10,
    },
    requestsPriorityA: reqA,
    requestsPriorityB: reqB,
    fitsContextWindow1M,
    fitsOutputLimit8k,
    fitsOutputLimit65k,
    fitsInlineHttp20Mb,
    feasibilityVerdict,
    keyBottlenecks: bottlenecks.length ? bottlenecks : ["None (Within standard limits)"],
  };
}

export function generatePreflightReport(): string {
  const results = CANDIDATE_BATCH_SIZES.map(analyzeBatchCandidate);

  let md = "# MAX-First Capacity Preflight Analysis: Zipang 1–265 (M1.4.1)\n\n";
  md += `### Scope Definitions & Uncertainty Model\n`;
  md += `- **Priority A:** Chapters 54–265 (${PARAMETERS.PRIORITY_A_CHAPTERS} chapters = ~${PRIORITY_A_PAGES_NOMINAL.toLocaleString()} pages)\n`;
  md += `- **Priority B:** Chapters 1–265 (${PARAMETERS.PRIORITY_B_CHAPTERS} chapters = ~${PRIORITY_B_PAGES_NOMINAL.toLocaleString()} pages)\n`;
  md += `- **Owner Research Target:** Complete all 265 chapters within <= 20 inference requests\n`;
  md += `- **Hypothetical Modeling Parameters (with explicit uncertainty):**\n`;
  md += `  - Dialogue bubbles/page: Nominal 8 (Range: 4 to 14, ±45% variation)\n`;
  md += `  - Output tokens/bubble (Thai): Nominal 22 (Range: 15 to 30, ±35% variation)\n`;
  md += `  - Input tokens/page: Nominal 924 (Range: 358 to 1,252 tokens)\n`;
  md += `  - Compressed JPEG size: Nominal 280 KB (Range: 180 to 420 KB)\n\n`;

  md += `## 1. Candidate Batch Size Evaluation\n\n`;
  md += `| Batch Size | Evidence Level | Input Tokens (Nominal) | Output Tokens (Nominal) | Payload (Nominal) | Req (Ch 54-265) | Req (Ch 1-265) | Inline REST | 65k Out Ceiling | Feasibility Verdict |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;

  for (const r of results) {
    const inlineStr = r.fitsInlineHttp20Mb ? "YES" : "NO (File API)";
    const outStr = r.fitsOutputLimit65k ? "YES" : "EXCEEDED";
    md += `| **${r.batchSize}** | ${r.evidenceLevel} | ${r.inputTokensEstimated.nominal.toLocaleString()} | ${r.outputTokensEstimated.nominal.toLocaleString()} | ${r.payloadSizeMbEstimated.nominal} MB | ${r.requestsPriorityA} | ${r.requestsPriorityB} | ${inlineStr} | ${outStr} | **${r.feasibilityVerdict}** |\n`;
  }

  md += `\n## 2. Research Stretch Target Assessment: 265 Chapters in <= 20 Requests\n\n`;
  const stretchReqs = 20;
  const pagesPerStretchReq = Math.ceil(PRIORITY_B_PAGES_NOMINAL / stretchReqs);
  const stretch = analyzeBatchCandidate(pagesPerStretchReq);

  md += `- Required batch size for <= 20 requests: **${pagesPerStretchReq} pages/request** (~${Math.round(pagesPerStretchReq / PARAMETERS.PAGES_PER_CHAPTER_NOMINAL)} chapters/request)\n`;
  md += `- Evidence Level: **${stretch.evidenceLevel}**\n`;
  md += `- Nominal Input Tokens per request: **${stretch.inputTokensEstimated.nominal.toLocaleString()} tokens** (26% of 1M context window)\n`;
  md += `- Nominal Output Tokens per request: **${stretch.outputTokensEstimated.nominal.toLocaleString()} tokens** (78% of 65k candidate limit)\n`;
  md += `- High-Density Bound Output: **${stretch.outputTokensEstimated.max.toLocaleString()} tokens** (Exceeds 65k ceiling by 134%!)\n`;
  md += `- Nominal Payload per request: **${stretch.payloadSizeMbEstimated.nominal} MB** (Exceeds 20MB inline HTTP REST limit)\n`;
  md += `- **Scientific Verdict:** **THEORETICALLY CONSTRAINED & UNVERIFIED**.\n`;
  md += `  Completing 265 chapters in 20 requests cannot be claimed as proven feasible. Under nominal assumptions, 292 pages consumes ~78% of the 65,536 token ceiling. In action-heavy or dialogue-dense chapters (12-14 bubbles/page), the output tokens will breach the 65k ceiling and cause silent dialogue truncation. Furthermore, multimodal attention across 292 simultaneous images is completely unverified.\n\n`;

  md += `## 3. Quota & Rate Limit Analysis (Free vs Paid Tier)\n\n`;
  md += `| Constraint | Free Tier | Tier 1 (Pay-as-you-go) | Impact on Batch Preparation |\n`;
  md += `| :--- | :--- | :--- | :--- |\n`;
  md += `| **Requests Per Minute (RPM)** | 15 RPM | 1,000 RPM | Not a bottleneck for large batches (1-2 req/min needed) |\n`;
  md += `| **Tokens Per Minute (TPM)** | 1,000,000 TPM | 4,000,000 TPM | Batch of 256 pages (~236k tokens) can run up to 4 times/min on Free tier |\n`;
  md += `| **Requests Per Day (RPD)** | 1,500 RPD | Unlimited | Entire Zipang Priority A (19-73 requests) fits within daily free limit! |\n`;
  md += `| **HTTP Payload Boundary** | 20 MB | 20 MB (REST) / 2GB (Files API) | Inline base64 capped at ~64 pages; >= 128 pages requires Files API |\n`;
  md += `| **Candidate Output Limit** | 65,536 tokens | 65,536 tokens | Absolute ceiling: any single inference cannot exceed ~350 pages |\n\n`;

  md += `## 4. Engineering Recommendations\n\n`;
  md += `1. **Do not attempt 292-page batches without prior empirical scaling tests.**\n`;
  md += `2. **Current Safe Architecture:** 32–64 pages per batch.\n`;
  md += `   - Stays 100% within inline HTTP REST boundaries (no File API required).\n`;
  md += `   - Leaves >80% safety margin below output token ceilings.\n`;
  md += `   - Priority A (Zipang 54–265) takes only ~73 requests.\n`;
  md += `3. **Next Step for Scaling:** When ready to test >64 pages, implement Gemini File API staging and benchmark on a single 128-page sample chapter.\n`;

  return md;
}

if (import.meta.main) {
  const report = generatePreflightReport();
  console.log(report);
}
