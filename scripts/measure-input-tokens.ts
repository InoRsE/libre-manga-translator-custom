/**
 * Empirical Gemini 3.8 Flash Input Token Measurement Tool (M1.5.1 Section A & B)
 *
 * Uses the official countTokens endpoint to measure real token overheads
 * across multimodal manga inputs, system instructions, and candidate batch sizes.
 *
 * Evidence Classification (M1.5.1 Section A):
 * - [VERIFIED-MEASURED-MULTIMODAL]: Actual countTokens on single image samples.
 * - [VERIFIED-MEASURED-TEXT]: Actual countTokens on text prompt templates.
 * - [CALCULATED-PROJECTION]: Linear batch projections derived from measured components.
 *   (Note: Large batches like 234/292/512 are calculated projections, NOT measured full payloads).
 *
 * ZERO generateContent translation inference quota is consumed.
 */

import { getBenchmarkApiKey } from "./get-api-key";
import { getZipangCorpusPages, type ExtractedCorpusPage } from "./corpus-adapter";

const MODEL = "gemini-3.8-flash";
const COUNT_TOKENS_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:countTokens`;

interface CountTokensResponse {
  totalTokens: number;
  promptTokensDetails?: Array<{
    modality: "TEXT" | "IMAGE" | "AUDIO" | "VIDEO";
    tokenCount: number;
  }>;
}

async function callCountTokens(payload: any): Promise<CountTokensResponse> {
  const apiKey = getBenchmarkApiKey();
  const res = await fetch(COUNT_TOKENS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`countTokens error (${res.status}): ${errText}`);
  }

  return await res.json();
}

function buildProductionPrompts(pageCount: number, bboxesPerPage: number = 8) {
  const dummyPages = Array.from({ length: pageCount }, (_, idx) => ({
    pageId: `zipang__54__page_${idx}`,
    bboxes: Array.from({ length: bboxesPerPage }, (_, b) => ({
      x1: 100, y1: 100, x2: 200, y2: 200, confidence: 0.9,
    })),
  }));

  const systemPrompt = `You are a professional manga translator working on "Zipang".
The source manga scanlation is in ENGLISH. Your task is to translate all dialogue into natural, accurate, immersive THAI (ภาษาไทย).
Target Workflow: English dialogue -> Thai translation (EN->TH).
You are provided with ${pageCount} sequential manga pages in reading order: ${dummyPages.map((p, idx) => `Page ${idx + 1} (ID: "${p.pageId}")`).join(", ")}.
Each page has red numbered bounding boxes marking dialogue regions (numbered starting from 1 on EACH page).
Translate the text in the numbered bounding boxes for each page FROM ENGLISH INTO THAI.
Maintain the military/naval terminology, tone, continuity, and context across the scene between all pages.

CRITICAL INSTRUCTIONS:
1. Output strictly valid JSON matching this schema:
{
  "pages": [
${dummyPages
  .map(
    (p) =>
      `    {\n      "pageId": "${p.pageId}",\n      "translations": [${p.bboxes.map((_, b) => `"คำแปลสำหรับกล่องที่ ${b + 1}"`).join(", ")}],\n      "sourceTexts": [${p.bboxes.map((_, b) => `"original English text in box ${b + 1}"`).join(", ")}]\n    }`,
  )
  .join(",\n")}
  ]
}
2. The "translations" array for each page MUST match the EXACT number of bounding boxes for that page:
${dummyPages.map((p) => `   - Page "${p.pageId}": exactly ${p.bboxes.length} items`).join("\n")}
3. Dialogue inside "translations" MUST be strictly in THAI. The source text is English scanlation.
4. "sourceTexts" MUST contain the original English text transcribed verbatim from the boxes.
5. NEVER mix up or swap dialogue between pages. Maintain strict page assignment.
6. If a box is empty, illegible, or has no text, use "" in translations and sourceTexts.
`;

  const userPrompt = `Please process the dialogue boxes for the ${pageCount} provided pages in document order.
${dummyPages.map((p, idx) => `Page ${idx + 1} ID: "${p.pageId}" (${p.bboxes.length} boxes)`).join("\n")}`;

  return { systemPrompt, userPrompt, dummyPages };
}

export async function runMeasurements() {
  console.log("=== GEMINI 3.8 FLASH INPUT TOKEN EMPIRICAL MEASUREMENT ===");

  // 1. [VERIFIED-MEASURED-TEXT]: Fixed System Prompt (Preamble alone, 0 pages)
  const basePreamble = `You are a professional manga translator working on "Zipang". Translate dialogue into Thai.`;
  const baseRes = await callCountTokens({
    contents: [{ parts: [{ text: basePreamble }] }],
  });
  console.log(`\n1. [VERIFIED-MEASURED-TEXT] Minimal Base Prompt Tokens: ${baseRes.totalTokens}`);

  // 2. [VERIFIED-MEASURED-MULTIMODAL]: Real Image Tokens on Zipang Pages
  const pages = getZipangCorpusPages();
  console.log(`\n2. [VERIFIED-MEASURED-MULTIMODAL] Real Page Tokens (Measured Samples):`);
  console.log("| Page | Dimensions | File Size | Text Tokens | Image Tokens | Total Tokens |");
  console.log("|---:|---:|---:|---:|---:|---:|");

  const imageTokenCounts: number[] = [];
  const sampleIndices = [0, 1, 2, 4, 19, 21].filter((i) => i < pages.length);

  for (const idx of sampleIndices) {
    const p = pages[idx];
    if (!p.base64Data) continue;

    const tokenRes = await callCountTokens({
      contents: [
        {
          parts: [
            { text: `Page ${p.pageNumber} (pageId: "${p.id}"):` },
            {
              inlineData: {
                mimeType: p.mimeType,
                data: p.base64Data,
              },
            },
          ],
        },
      ],
    });

    const textMod = tokenRes.promptTokensDetails?.find((d) => d.modality === "TEXT")?.tokenCount || 0;
    const imgMod = tokenRes.promptTokensDetails?.find((d) => d.modality === "IMAGE")?.tokenCount || 0;
    imageTokenCounts.push(imgMod);

    console.log(
      `| ${p.pageNumber} | index ${idx} | ${(p.jpegBytesLength / 1024).toFixed(1)} KB | ${textMod} | ${imgMod} | ${tokenRes.totalTokens} |`
    );
  }

  // 3. [CALCULATED-PROJECTION]: Batch Input Scaling & Marginal Token Cost Analysis
  // Validates the official 100MB Inline limit (Google File Input Methods documentation).
  console.log("\n3. Batch Input Scaling Projections (Derived from Measured Components):");
  console.log(
    "NOTE: N=1 to 22 use measured prompts; N >= 64 are CALCULATED PROJECTIONS, not measured full payloads.\n"
  );
  console.log(
    "| Candidate N | Evidence Level | Measured Text Tokens | Projected Image Tokens | Total Projected Input | Serialized MB | Fits Inline (100MB)? | Fits Context (1M)? |"
  );
  console.log(
    "|---:|:---|---:|---:|---:|---:|:---:|:---:|"
  );

  const candidateNs = [1, 2, 8, 16, 22, 64, 128, 192, 234, 256, 292, 384, 512];
  const avgImageTokensPerPage =
    imageTokenCounts.length > 0
      ? imageTokenCounts.reduce((a, b) => a + b, 0) / imageTokenCounts.length
      : 1088;
  const avgBase64BytesPerPage = 331_417; // ~323 KB per page

  for (const n of candidateNs) {
    const { systemPrompt, userPrompt } = buildProductionPrompts(n, 8);

    const promptTokenRes = await callCountTokens({
      contents: [
        { role: "user", parts: [{ text: systemPrompt }, { text: userPrompt }] },
      ],
    });

    const totalImageTokensEst = Math.round(n * avgImageTokensPerPage);
    const totalInputTokensEst = promptTokenRes.totalTokens + totalImageTokensEst;
    const estPayloadMb = (n * avgBase64BytesPerPage) / (1024 * 1024);
    const fitsInline100Mb = estPayloadMb <= 100.0;
    const fitsContext1M = totalInputTokensEst <= 1_048_576;
    const evidenceLevel = n <= 22 ? "VERIFIED-MEASURED-TEXT" : "CALCULATED-PROJECTION";

    console.log(
      `| ${n} | ${evidenceLevel} | ${promptTokenRes.totalTokens} | ${totalImageTokensEst} | ${totalInputTokensEst} | ${estPayloadMb.toFixed(2)} MB | ${fitsInline100Mb ? "YES" : "NO"} | ${fitsContext1M ? "YES" : "NO"} |`
    );
  }
}

if (import.meta.main) {
  runMeasurements().catch(console.error);
}
