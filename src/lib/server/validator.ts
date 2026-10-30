/**
 * Schema validator for LLM translation responses.
 * Validates the translations array, coerces item types, and self-heals
 * count mismatches (pad short arrays with "", truncate long ones) so a
 * single dropped box — typically an empty OCR box the model merged away —
 * never fails the whole page. Pass `{ strict: true }` to restore the
 * previous throw-on-mismatch behaviour.
 */

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

export interface ValidatedTranslation {
  translations: Translations;
  sourceTexts?: string[];
  context?: {
    summary: string;
    dictionary: string;
  };
  usageMetadata?: GeminiUsageMetadata;
}

export interface ValidateOptions {
  /** When true, throw on count mismatch instead of padding/truncating. */
  strict?: boolean;
}

/**
 * Robust JSON extractor and parser for LLM outputs.
 * Handles markdown codeblocks, preamble conversational text, and raw JSON.
 */
export function parseLlmJson(content: string): any {
  const trimmed = content.trim();

  // 1. Direct JSON parse
  try {
    return JSON.parse(trimmed);
  } catch {}

  // 2. Extract markdown code block ```json ... ``` or ``` ... ``` anywhere in content
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch?.[1]) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {}
  }

  // 3. Extract outermost JSON object { ... }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  // 4. Extract outermost JSON array [ ... ]
  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(trimmed.slice(firstBracket, lastBracket + 1));
    } catch {}
  }

  throw new Error(
    `Failed to parse server JSON: Unexpected format\nRaw: ${content.substring(0, 500)}`,
  );
}

export function validateTranslationResult(
  raw: unknown,
  expectedCount: number,
  options?: ValidateOptions,
): ValidatedTranslation {
  if (!raw || typeof raw !== "object") {
    throw new Error("API Schema Error: Response is not an object.");
  }

  const obj = raw as Record<string, any>;

  if (!Array.isArray(obj.translations)) {
    throw new Error("API Schema Error: 'translations' must be an array.");
  }

  // Coerce non-string items instead of throwing: null/undefined → "",
  // primitives via String(), objects via JSON. Empty stays empty so the
  // output index still mirrors the OCR box index.
  const translations: string[] = obj.translations.map((item) => {
    if (typeof item === "string") return item;
    if (item === null || item === undefined) return "";
    if (typeof item === "object") {
      try {
        return JSON.stringify(item);
      } catch {
        return "";
      }
    }
    return String(item);
  });

  if (translations.length !== expectedCount) {
    if (options?.strict) {
      throw new Error(
        `API Schema Error: Translation count mismatch. Expected ${expectedCount} items to match bubbles, received ${translations.length}.`,
      );
    }
    if (translations.length < expectedCount) {
      console.warn(
        `[validator] padding translations: received ${translations.length}, expected ${expectedCount} — filling missing slots with ""`,
      );
      while (translations.length < expectedCount) translations.push("");
    } else {
      console.warn(
        `[validator] truncating translations: received ${translations.length}, expected ${expectedCount} — dropping extras`,
      );
      translations.length = expectedCount;
    }
  }

  let sourceTexts: string[] | undefined = undefined;
  if (obj.sourceTexts !== undefined) {
    if (!Array.isArray(obj.sourceTexts)) {
      throw new Error("API Schema Error: 'sourceTexts' must be an array.");
    }
    sourceTexts = obj.sourceTexts.map((s) => (typeof s === "string" ? s : String(s)));
  }

  let context: { summary: string; dictionary: string } | undefined = undefined;
  if (obj.context && typeof obj.context === "object") {
    context = {
      summary: typeof obj.context.summary === "string" ? obj.context.summary : "",
      dictionary: typeof obj.context.dictionary === "string" ? obj.context.dictionary : "",
    };
  }

  const usageMetadata: GeminiUsageMetadata | undefined =
    obj.usageMetadata && typeof obj.usageMetadata === "object"
      ? {
          promptTokenCount: obj.usageMetadata.promptTokenCount,
          candidatesTokenCount: obj.usageMetadata.candidatesTokenCount,
          thoughtsTokenCount: obj.usageMetadata.thoughtsTokenCount,
          totalTokenCount: obj.usageMetadata.totalTokenCount,
        }
      : undefined;

  return { translations, sourceTexts, context, ...(usageMetadata ? { usageMetadata } : {}) };
}

export interface ExpectedBatchPage {
  pageId: string;
  expectedCount: number;
}

export interface ValidatedBatchPageResult {
  pageId: string;
  translations: string[];
  sourceTexts?: string[];
}

export interface ValidatedBatchResult {
  pages: ValidatedBatchPageResult[];
  context?: {
    summary: string;
    dictionary: string;
  };
  usageMetadata?: GeminiUsageMetadata;
}

/**
 * Validates a multi-page batch translation response from Gemini Vision.
 * Strict rules (M1.3.1 Requirements):
 * 1. Must contain a 'pages' array matching the expected page count.
 * 2. Every page must strictly match its expected pageId and box count.
 * 3. NO positional order fallbacks: identity must be explicitly proven by matching pageId.
 * 4. Never silently fill missing translations or pad missing sourceTexts.
 * 5. If source dialogue is detected in a box but translation is empty, reject as incomplete.
 * 6. Never confuse or swap dialogue between pages.
 */
export function validateBatchTranslationResult(
  raw: unknown,
  expectedPages: ExpectedBatchPage[],
): ValidatedBatchResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("Batch translation response is not a valid JSON object");
  }

  const obj = raw as Record<string, any>;
  const pagesRaw = obj.pages;

  if (!Array.isArray(pagesRaw)) {
    throw new Error("Batch translation response missing 'pages' array");
  }

  if (pagesRaw.length !== expectedPages.length) {
    throw new Error(
      `Batch translation page count mismatch: received ${pagesRaw.length} pages, expected ${expectedPages.length}`,
    );
  }

  // Prevent duplicate pageIds in response
  const seenRawIds = new Set<string>();
  for (const p of pagesRaw) {
    if (p && typeof p.pageId !== "undefined") {
      const pid = String(p.pageId).trim();
      if (seenRawIds.has(pid)) {
        throw new Error(`Batch translation returned duplicate pageId '${pid}'`);
      }
      seenRawIds.add(pid);
    }
  }

  const validatedPages: ValidatedBatchPageResult[] = [];

  for (let i = 0; i < expectedPages.length; i++) {
    const expected = expectedPages[i];
    const expectedId = String(expected.pageId).trim();

    // STRICT IDENTITY: Exact match on pageId only. No positional fallbacks!
    const pageData = pagesRaw.find(
      (p) => p && typeof p.pageId !== "undefined" && String(p.pageId).trim() === expectedId,
    );

    if (!pageData) {
      throw new Error(
        `Batch translation response missing exact data for expected pageId '${expected.pageId}'`,
      );
    }

    if (!Array.isArray(pageData.translations)) {
      throw new Error(
        `Batch translation for page '${expected.pageId}' missing 'translations' array`,
      );
    }

    // STRICT CHECK: Box count must match exactly
    if (pageData.translations.length !== expected.expectedCount) {
      throw new Error(
        `Batch translation box count mismatch on page '${expected.pageId}': received ${pageData.translations.length}, expected ${expected.expectedCount}`,
      );
    }

    // TRUTHFUL COMPLETENESS: Reject null, undefined, or non-string items
    const translations: string[] = [];
    for (let idx = 0; idx < pageData.translations.length; idx++) {
      const item = pageData.translations[idx];
      if (item === null || item === undefined || typeof item !== "string") {
        throw new Error(
          `Batch translation on page '${expected.pageId}' contains invalid non-string item at index ${idx}`,
        );
      }
      translations.push(item);
    }

    let sourceTexts: string[] | undefined = undefined;
    if (pageData.sourceTexts !== undefined) {
      if (!Array.isArray(pageData.sourceTexts)) {
        throw new Error(
          `Batch translation for page '${expected.pageId}' has invalid non-array 'sourceTexts'`,
        );
      }
      // STRICT CHECK: sourceTexts must not drift or be silently padded
      if (pageData.sourceTexts.length !== expected.expectedCount) {
        throw new Error(
          `Batch translation sourceTexts count mismatch on page '${expected.pageId}': received ${pageData.sourceTexts.length}, expected ${expected.expectedCount}`,
        );
      }
      sourceTexts = pageData.sourceTexts.map((item: any, idx: number) => {
        if (item === null || item === undefined || typeof item !== "string") {
          throw new Error(
            `Batch translation on page '${expected.pageId}' contains invalid non-string sourceText at index ${idx}`,
          );
        }
        return item;
      });
    } else if (expected.expectedCount > 0) {
      // M1.4.1 REPAIR E: A multi-image Vision Batch with dialogue boxes must not accept a
      // response with an entirely omitted 'sourceTexts' field as fully verified.
      throw new Error(
        `Batch translation for page '${expected.pageId}' missing required 'sourceTexts' transcription array for ${expected.expectedCount} dialogue boxes`,
      );
    }

    // TRUTHFUL COMPLETENESS CHECK:
    // If a box has recognizable source dialogue but an empty translation,
    // dialogue was dropped! Reject the page rather than caching incomplete results.
    if (sourceTexts && Array.isArray(sourceTexts)) {
      for (let idx = 0; idx < expected.expectedCount; idx++) {
        const srcDialogue = sourceTexts[idx]?.trim() ?? "";
        const translatedDialogue = translations[idx]?.trim() ?? "";
        if (srcDialogue.length > 0 && translatedDialogue.length === 0) {
          throw new Error(
            `Batch translation incomplete on page '${expected.pageId}': box ${idx + 1} has source dialogue ("${srcDialogue.substring(0, 30)}") but translation is empty`,
          );
        }
      }
    }

    validatedPages.push({
      pageId: expected.pageId,
      translations,
      ...(sourceTexts !== undefined ? { sourceTexts } : {}),
    });
  }

  let context: { summary: string; dictionary: string } | undefined = undefined;
  if (obj.context && typeof obj.context === "object") {
    context = {
      summary: typeof obj.context.summary === "string" ? obj.context.summary : "",
      dictionary: typeof obj.context.dictionary === "string" ? obj.context.dictionary : "",
    };
  }

  const usageMetadata: GeminiUsageMetadata | undefined =
    obj.usageMetadata && typeof obj.usageMetadata === "object"
      ? {
          promptTokenCount: obj.usageMetadata.promptTokenCount,
          candidatesTokenCount: obj.usageMetadata.candidatesTokenCount,
          thoughtsTokenCount: obj.usageMetadata.thoughtsTokenCount,
          totalTokenCount: obj.usageMetadata.totalTokenCount,
        }
      : undefined;

  return { pages: validatedPages, context, ...(usageMetadata ? { usageMetadata } : {}) };
}
