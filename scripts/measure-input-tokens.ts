/**
 * Empirical Gemini 3.8 Flash Input Token Measurement Tool (M1.5)
 * Uses the official countTokens endpoint to measure real token overheads
 * across multimodal manga inputs, system instructions, and candidate batch sizes.
 *
 * ZERO generateContent translation inference quota is consumed.
 */

import fs from "fs";
import path from "path";
import { getBenchmarkApiKey } from "./get-api-key";
import { extractAllZipang54Pages } from "C:/Users/champ/.gemini/antigravity/brain/74e28695-8273-4cf0-ac12-5fb4547b7953/scratch/extract_cached_corpus";

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
You are provided with ${pageCount} sequential manga pages in reading order: ${dummyPages.map((p, idx) => `Page ${idx + 1} (ID: "${p.pageId}")`).join(", ")}.
Each page has red numbered bounding boxes marking dialogue regions (numbered starting from 1 on EACH page).
Translate the text in the numbered bounding boxes for each page FROM JAPANESE INTO THAI.
Maintain the tone, continuity, and context across the scene between all pages.

CRITICAL INSTRUCTIONS:
1. Output strictly valid JSON matching this schema:
{
  "pages": [
${dummyPages
  .map(
    (p) =>
      `    {\n      "pageId": "${p.pageId}",\n      "translations": [${p.bboxes.map((_, b) => `"translation for box ${b + 1}"`).join(", ")}],\n      "sourceTexts": [${p.bboxes.map((_, b) => `"original text in box ${b + 1}"`).join(", ")}]\n    }`,
  )
  .join(",\n")}
  ]
}
2. The "translations" array for each page MUST match the EXACT number of bounding boxes for that page:
${dummyPages.map((p) => `   - Page "${p.pageId}": exactly ${p.bboxes.length} items`).join("\n")}
3. Dialogue inside "translations" MUST be strictly in THAI. DO NOT copy or transcribe the original untranslated text into "translations".
4. "sourceTexts" MUST contain the original text transcribed verbatim from the boxes.
5. NEVER mix up or swap dialogue between pages. Maintain strict page assignment.
6. If a box is empty, illegible, or has no text, use "" in translations and sourceTexts.
`;

  const userPrompt = `Please process the dialogue boxes for the ${pageCount} provided pages in document order.
${dummyPages.map((p, idx) => `Page ${idx + 1} ID: "${p.pageId}" (${p.bboxes.length} boxes)`).join("\n")}`;

  return { systemPrompt, userPrompt, dummyPages };
}

async function runMeasurements() {
  console.log("=== GEMINI 3.8 FLASH INPUT TOKEN EMPIRICAL MEASUREMENT ===");

  // 1. Measure Fixed System Prompt (Preamble alone, 0 pages)
  const basePreamble = `You are a professional manga translator working on "Zipang". Translate dialogue into Thai.`;
  const baseRes = await callCountTokens({
    contents: [{ parts: [{ text: basePreamble }] }],
  });
  console.log(`\n1. Minimal Base Prompt Tokens: ${baseRes.totalTokens}`);

  // 2. Measure Real Image Tokens on Zipang Pages
  const pages = extractAllZipang54Pages();
  const blobDir = path.join(
    process.env.LOCALAPPDATA || "",
    "Google/Chrome/User Data/Default/IndexedDB/https_comix.to_0.indexeddb.blob/1/00"
  );

  console.log("\n2. Real Multimodal Page Tokens (Individual Sample):");
  console.log("| Page | Dimensions | File Size | Text Tokens | Image Tokens | Total Tokens |");
  console.log("|---:|---:|---:|---:|---:|---:|");

  const imageTokenCounts: number[] = [];
  const sampleIndices = [0, 1, 2, 4, 19, 21]; // Single pages + spreads

  for (const idx of sampleIndices) {
    const p = pages[idx];
    const raw = fs.readFileSync(path.join(blobDir, p.file));
    const dataUrlIdx = raw.indexOf(Buffer.from("data:image"));
    let endIdx = raw.indexOf(Buffer.from('"'), dataUrlIdx);
    if (endIdx === -1) endIdx = raw.length;
    const base64 = raw.toString("utf8", dataUrlIdx, endIdx).replace(/^data:image\/[a-z]+;base64,/, "");

    const tokenRes = await callCountTokens({
      contents: [
        {
          parts: [
            { text: `Page ${p.pageNumber} (pageId: "${p.id}"):` },
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: base64,
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

  // 3. Batch Input Token Measurement with Complete Production Prompt Structure
  console.log("\n3. Batch Input Scaling & Marginal Token Cost Analysis:");
  console.log("| Batch Size N | System Prompt Tokens | User Prompt Tokens | Image Tokens (Est) | Total Input Tokens | Input MB (Base64) | Fits Inline (20MB) |");
  console.log("|---:|---:|---:|---:|---:|---:|:---:|");

  // Representative batch candidate sizes from M1.5 requirements:
  const candidateNs = [1, 2, 8, 16, 22, 64, 128, 192, 234, 256, 292, 384, 512];
  const avgImageTokensPerPage = imageTokenCounts.reduce((a, b) => a + b, 0) / imageTokenCounts.length; // e.g. 768 to 1032
  const avgBase64BytesPerPage = 331_417; // ~323 KB

  for (const n of candidateNs) {
    const { systemPrompt, userPrompt } = buildProductionPrompts(n, 8);

    // Call countTokens for the combined instructions
    const promptTokenRes = await callCountTokens({
      contents: [
        { role: "user", parts: [{ text: systemPrompt }, { text: userPrompt }] }
      ],
    });

    const sysTokens = await callCountTokens({
      contents: [{ parts: [{ text: systemPrompt }] }],
    });

    const userTokens = await callCountTokens({
      contents: [{ parts: [{ text: userPrompt }] }],
    });

    const totalImageTokensEst = Math.round(n * avgImageTokensPerPage);
    const totalInputTokensEst = promptTokenRes.totalTokens + totalImageTokensEst;
    const estPayloadMb = (n * avgBase64BytesPerPage) / (1024 * 1024);
    const fitsInline = estPayloadMb <= 20.0;

    console.log(
      `| ${n} | ${sysTokens.totalTokens} | ${userTokens.totalTokens} | ${totalImageTokensEst} | ${totalInputTokensEst} | ${estPayloadMb.toFixed(2)} MB | ${fitsInline ? "YES" : "NO (Exceeds 20MB)"} |`
    );
  }
}

runMeasurements().catch(console.error);
