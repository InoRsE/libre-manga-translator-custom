import { MAKE_SITE_RULE_PROMPT } from "../adapters";
import { DefaultConfig } from "../configs";
import { drawNumberedBboxes } from "./utils";
import { buildTranslationPrompts } from "../prompts";
import {
  parseLlmJson,
  validateTranslationResult,
  validateBatchTranslationResult,
  type ValidatedBatchResult,
} from "../server/validator";

export interface GeminiBatchPageInput {
  pageId: string;
  imageSrc: string;
  bboxes: Bbox[];
}

export type GeminiPartData =
  | {
      mimeType: string;
      data: string;
    }
  | Array<{
      text?: string;
      inlineData?: {
        mimeType: string;
        data: string;
      };
    }>;

export async function translateTextWithGemini(
  ocrTexts: string[],
  apiKey: string,
  targetLang: string,
  sourceLang: string,
  seriesContext?: SeriesContext,
  model = DefaultConfig.geminiModels[0].id,
  temperature = DefaultConfig.llmTemperature,
): Promise<TranslateResult> {
  if (!ocrTexts || ocrTexts.length === 0) {
    return { translations: [], sourceTexts: [] };
  }

  const { systemPrompt, userPrompt } = buildTranslationPrompts(
    ocrTexts,
    targetLang,
    sourceLang,
    seriesContext,
  );

  const raw = await sendRequestToGemini(
    systemPrompt,
    userPrompt,
    apiKey,
    model,
    temperature,
  );

  const validated = validateTranslationResult(raw, ocrTexts.length);
  return {
    ...validated,
    sourceTexts: ocrTexts,
  };
}

export async function translateWithGemini(
  imageSrc: string,
  bboxes: Bbox[],
  apiKey: string,
  targetLang: string,
  sourceLang: string,
  seriesContext?: SeriesContext,
  model = DefaultConfig.geminiModels[0].id,
  temperature = DefaultConfig.llmTemperature,
): Promise<TranslateResult> {
  const cleanBase64 = (await drawNumberedBboxes(imageSrc, bboxes)).replace(
    /^data:image\/(png|jpeg|webp);base64,/,
    "",
  );
  const needsContext =
    !seriesContext?.summary ||
    !seriesContext?.dictionary ||
    (seriesContext?.translatedCount ?? 0) % DefaultConfig.minTranslations === 0;

  const systemPrompt = `You are a professional manga translator${seriesContext?.seriesName ? ` working on "${seriesContext.seriesName}"` : ""}.
Translate the text in the numbered bounding boxes in the provided image${sourceLang !== "Auto-Detect" ? ` FROM ${sourceLang.toUpperCase()}` : ""} INTO ${targetLang.toUpperCase()}.
Maintain the tone and context of the scene.
${seriesContext?.summary ? `\nSeries context: ${seriesContext.summary}` : ""}
${seriesContext?.dictionary ? `\nTerm dictionary (always use these): ${seriesContext.dictionary}` : ""}
${seriesContext?.recentHistory?.length ? `\nPrevious pages for continuity:\n${seriesContext.recentHistory.map((h, i) => `Page -${seriesContext.recentHistory.length - i}: ${h.text}`).join("\n")}` : ""}

CRITICAL LANGUAGE INSTRUCTIONS:
1. The dialogue inside the "translations" array MUST be strictly in ${targetLang.toUpperCase()}. DO NOT transcribe or copy the original text from the image. You must output the translated meaning.
2. The "sourceTexts" array MUST contain the ORIGINAL text exactly as it appears in each numbered box, transcribed verbatim (not translated). If a box's text is illegible or empty, use an empty string.
${needsContext ? `3. The "summary" and "dictionary" fields MUST remain strictly in ENGLISH to act as a system memory pivot.` : ""}

Output strictly as valid JSON matching this structure without markdown formatting:
{
  "translations": ["translation for box 1", "translation for box 2"],
  "sourceTexts": ["original text in box 1", "original text in box 2"]${
    needsContext
      ? `,\n  "context": {\n    "summary": "...",\n    "dictionary": "..."\n  }`
      : ""
  }
}`;

  const userPrompt = `Please process the dialogue boxes found in the provided image.
${
  needsContext
    ? `\nAlso infer from this page:
1. A 1-2 sentence summary of the series tone, setting, and genre IN ENGLISH.
2. Any character names, places, or unique terms visible, formatted as "Original Term -> English Translation". If no specific terms are visible, output strictly "None". Do not explain or write sentences.`
    : ""
}`;

  const raw = await sendRequestToGemini(
    systemPrompt,
    userPrompt,
    apiKey,
    model,
    temperature,
    {
      mimeType: "image/jpeg",
      data: cleanBase64,
    },
  );

  return validateTranslationResult(raw, bboxes.length);
}

export async function translateBatchWithGemini(
  pages: GeminiBatchPageInput[],
  apiKey: string,
  targetLang: string,
  sourceLang: string,
  seriesContext?: SeriesContext,
  model = DefaultConfig.geminiModels[0].id,
  temperature = DefaultConfig.llmTemperature,
): Promise<ValidatedBatchResult> {
  if (!pages || pages.length === 0) {
    return { pages: [] };
  }

  // Pre-draw numbered bboxes on each page
  const preparedPages = await Promise.all(
    pages.map(async (page) => {
      if (page.bboxes.length === 0) {
        return {
          pageId: page.pageId,
          cleanBase64: "",
          bboxCount: 0,
        };
      }
      const numberedBase64 = (
        await drawNumberedBboxes(page.imageSrc, page.bboxes)
      ).replace(/^data:image\/(png|jpeg|webp);base64,/, "");
      return {
        pageId: page.pageId,
        cleanBase64: numberedBase64,
        bboxCount: page.bboxes.length,
      };
    }),
  );

  const needsContext =
    !seriesContext?.summary ||
    !seriesContext?.dictionary ||
    (seriesContext?.translatedCount ?? 0) % DefaultConfig.minTranslations === 0;

  const systemPrompt = `You are a professional manga translator${seriesContext?.seriesName ? ` working on "${seriesContext.seriesName}"` : ""}.
You are provided with ${pages.length} sequential manga pages in reading order: ${pages.map((p, idx) => `Page ${idx + 1} (ID: "${p.pageId}")`).join(", ")}.
Each page has red numbered bounding boxes marking dialogue regions (numbered starting from 1 on EACH page).
Translate the text in the numbered bounding boxes for each page${sourceLang !== "Auto-Detect" ? ` FROM ${sourceLang.toUpperCase()}` : ""} INTO ${targetLang.toUpperCase()}.
Maintain the tone, continuity, and context across the scene between all pages.
${seriesContext?.summary ? `\nSeries context: ${seriesContext.summary}` : ""}
${seriesContext?.dictionary ? `\nTerm dictionary (always use these): ${seriesContext.dictionary}` : ""}
${seriesContext?.recentHistory?.length ? `\nPrevious pages for continuity:\n${seriesContext.recentHistory.map((h, i) => `Page -${seriesContext.recentHistory.length - i}: ${h.text}`).join("\n")}` : ""}

CRITICAL INSTRUCTIONS:
1. Output strictly valid JSON matching this schema:
{
  "pages": [
${pages
  .map(
    (p) =>
      `    {\n      "pageId": "${p.pageId}",\n      "translations": [${p.bboxes.map((_, b) => `"translation for box ${b + 1}"`).join(", ")}],\n      "sourceTexts": [${p.bboxes.map((_, b) => `"original text in box ${b + 1}"`).join(", ")}]\n    }`,
  )
  .join(",\n")}
  ]${needsContext ? `,\n  "context": {\n    "summary": "...",\n    "dictionary": "..."\n  }` : ""}
}
2. The "translations" array for each page MUST match the EXACT number of bounding boxes for that page:
${pages.map((p) => `   - Page "${p.pageId}": exactly ${p.bboxes.length} items`).join("\n")}
3. Dialogue inside "translations" MUST be strictly in ${targetLang.toUpperCase()}. DO NOT copy or transcribe the original untranslated text into "translations".
4. "sourceTexts" MUST contain the original text transcribed verbatim from the boxes.
5. NEVER mix up or swap dialogue between pages. Maintain strict page assignment.
6. If a box is empty, illegible, or has no text, use "" in translations and sourceTexts.
${needsContext ? `7. The "summary" and "dictionary" fields MUST remain strictly in ENGLISH to act as a system memory pivot.` : ""}
`;

  const userPrompt = `Please process the dialogue boxes for the ${pages.length} provided pages in document order.
${pages.map((p, idx) => `Page ${idx + 1} ID: "${p.pageId}" (${p.bboxes.length} boxes)`).join("\n")}
${
  needsContext
    ? `\nAlso infer from these pages:
1. A 1-2 sentence summary of the series tone, setting, and genre IN ENGLISH.
2. Any character names, places, or unique terms visible, formatted as "Original Term -> English Translation". If no specific terms are visible, output strictly "None". Do not explain or write sentences.`
    : ""
}`;

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
  preparedPages.forEach((p, idx) => {
    parts.push({ text: `Page ${idx + 1} (pageId: "${p.pageId}"):` });
    if (p.cleanBase64) {
      parts.push({
        inlineData: {
          mimeType: "image/jpeg",
          data: p.cleanBase64,
        },
      });
    }
  });

  const raw = await sendRequestToGemini(
    systemPrompt,
    userPrompt,
    apiKey,
    model,
    temperature,
    parts,
  );

  return validateBatchTranslationResult(
    raw,
    pages.map((p) => ({ pageId: p.pageId, expectedCount: p.bboxes.length })),
  );
}

export async function makeSiteRuleWithGemini(
  title: string,
  path: string,
  apiKey: string,
  model = DefaultConfig.geminiModels[0].id,
  temperature = DefaultConfig.llmTemperature,
) {
  const prompt = MAKE_SITE_RULE_PROMPT(title, path);

  return sendRequestToGemini(
    prompt.system,
    prompt.user,
    apiKey,
    model,
    temperature,
  );
}

export async function sendRequestToGemini(
  systemPrompt: string,
  userPrompt: string,
  apiKey: string,
  model: string,
  temperature: number,
  data?: GeminiPartData,
): Promise<any> {
  // Google API keys are printable ASCII. A key pasted with a stray space,
  // zero-width character or smart quote would otherwise reach the header and
  // make fetch() throw an opaque "invalid header value" TypeError.
  const key = apiKey.trim();
  if (!key || /[^\x21-\x7e]/.test(key)) {
    throw new Error(
      "Gemini API key is empty or contains invisible/non-ASCII characters — re-paste it",
    );
  }

  // Key travels in the header, never the URL: query strings are persisted in
  // intermediary and server-side request logs.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const requestParts = Array.isArray(data)
    ? [
        ...data.map((item) =>
          item.inlineData
            ? { inlineData: item.inlineData }
            : { text: item.text ?? "" },
        ),
        { text: userPrompt },
      ]
    : [
        { text: userPrompt },
        ...(data ? [{ inlineData: data }] : []),
      ];

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        {
          role: "user",
          parts: requestParts,
        },
      ],
      generationConfig: {
        temperature,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(
      `Gemini API Error: ${errorData.error?.message || response.statusText}`,
    );
  }

  const result = await response.json();
  const resultText = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!resultText) {
    throw new Error("Gemini API returned empty response parts");
  }

  return parseLlmJson(resultText);
}
