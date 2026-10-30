/**
 * Schema validator for LLM translation responses.
 * Validates the translations array, coerces item types, and self-heals
 * count mismatches (pad short arrays with "", truncate long ones) so a
 * single dropped box — typically an empty OCR box the model merged away —
 * never fails the whole page. Pass `{ strict: true }` to restore the
 * previous throw-on-mismatch behaviour.
 */

export interface ValidatedTranslation {
  translations: Translations;
  sourceTexts?: string[];
  context?: {
    summary: string;
    dictionary: string;
  };
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

  return { translations, sourceTexts, context };
}

export interface ExpectedBatchPage {
  pageId: string;
  expectedCount: number;
}

export interface ValidatedBatchPageResult {
  pageId: string;
  translations: string[];
  sourceTexts: string[];
}

export interface ValidatedBatchResult {
  pages: ValidatedBatchPageResult[];
  context?: {
    summary: string;
    dictionary: string;
  };
}

/**
 * Validates a multi-page batch translation response from Gemini Vision.
 * Strict rules (M1.3 Requirements):
 * 1. Must contain a 'pages' array matching the expected page count.
 * 2. Every page must strictly match its expected pageId and box count.
 * 3. Never silently fill missing translations (throws on count mismatch).
 * 4. Never confuse or swap dialogue between pages.
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
  const seenIds = new Set<string>();
  const validatedPages: ValidatedBatchPageResult[] = [];

  for (let i = 0; i < expectedPages.length; i++) {
    const expected = expectedPages[i];

    // Find page data matching pageId (or fallback to exact index order if pageId is missing/mangled)
    let pageData = pagesRaw.find(
      (p) => p && String(p.pageId).trim() === String(expected.pageId).trim(),
    );

    if (!pageData) {
      // If exactly expectedPages.length items exist and index i has translations, match by positional order
      if (pagesRaw[i] && Array.isArray(pagesRaw[i].translations)) {
        pageData = pagesRaw[i];
      } else {
        throw new Error(
          `Batch translation response missing data for page '${expected.pageId}'`,
        );
      }
    }

    const effectiveId = String(pageData.pageId ?? expected.pageId).trim();
    if (seenIds.has(effectiveId)) {
      throw new Error(`Batch translation returned duplicate pageId '${effectiveId}'`);
    }
    seenIds.add(effectiveId);

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

    const translations = pageData.translations.map((item: any) => {
      if (typeof item === "string") return item;
      if (item === null || item === undefined) return "";
      return String(item);
    });

    let sourceTexts: string[] = [];
    if (Array.isArray(pageData.sourceTexts)) {
      sourceTexts = pageData.sourceTexts.map((item: any) =>
        typeof item === "string" ? item : String(item ?? ""),
      );
      while (sourceTexts.length < expected.expectedCount) sourceTexts.push("");
      if (sourceTexts.length > expected.expectedCount) {
        sourceTexts.length = expected.expectedCount;
      }
    } else {
      sourceTexts = new Array(expected.expectedCount).fill("");
    }

    validatedPages.push({
      pageId: expected.pageId,
      translations,
      sourceTexts,
    });
  }

  let context: { summary: string; dictionary: string } | undefined = undefined;
  if (obj.context && typeof obj.context === "object") {
    context = {
      summary: typeof obj.context.summary === "string" ? obj.context.summary : "",
      dictionary: typeof obj.context.dictionary === "string" ? obj.context.dictionary : "",
    };
  }

  return { pages: validatedPages, context };
}
