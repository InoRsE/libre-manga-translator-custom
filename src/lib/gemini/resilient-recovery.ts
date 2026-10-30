/**
 * Resilient Partial-Result Page Recovery Parser (M1.5)
 *
 * Recovers all complete, valid page records from a Gemini Vision batch translation
 * response, even when the response JSON was truncated by max output tokens,
 * network cutoff, or stream interruption.
 *
 * Page Acceptance Contract (M1.5 Section 6):
 * 1. Stable Page ID must match one submitted input page.
 * 2. Dialogue region array count must match expected bounding box count.
 * 3. Translations and sourceTexts arrays must pass validation (no non-strings).
 * 4. Truthful completeness: no empty translations if source text was detected.
 * 5. No duplicate or conflicting page IDs.
 * 6. Trailing cut-off / partial page objects are strictly discarded (never counted).
 */

import type { ExpectedBatchPage, ValidatedBatchPageResult } from "../server/validator";

export interface RecoveredBatchResult {
  completedPages: ValidatedBatchPageResult[];
  unfinishedPageIds: string[];
  isFullyComplete: boolean;
  isTruncated: boolean;
  totalExpected: number;
  totalRecovered: number;
  rawPageRecordsExtracted: number;
}

/**
 * Extracts complete JSON page objects from potentially truncated text.
 * Uses balanced-brace scanning inside the "pages" array.
 */
export function extractPageObjectsFromRawText(rawText: string): any[] {
  if (!rawText || typeof rawText !== "string") return [];

  // 1. If clean JSON parses directly, return its pages array
  try {
    const parsed = JSON.parse(rawText.trim());
    if (parsed && Array.isArray(parsed.pages)) {
      return parsed.pages;
    }
  } catch {}

  // 2. Clean markdown code blocks if present
  let clean = rawText.trim();
  const codeBlockMatch = clean.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/i);
  if (codeBlockMatch?.[1]) {
    clean = codeBlockMatch[1].trim();
  }

  // 3. Locate the "pages" array start
  const pagesKeyIdx = clean.search(/"pages"\s*:\s*\[/);
  if (pagesKeyIdx === -1) {
    // Check if the content is directly an array of pages
    const arrayStart = clean.indexOf("[");
    if (arrayStart === -1) return [];
    return scanBalancedObjectsFromArray(clean, arrayStart);
  }

  const arrayStart = clean.indexOf("[", pagesKeyIdx);
  if (arrayStart === -1) return [];

  return scanBalancedObjectsFromArray(clean, arrayStart);
}

function scanBalancedObjectsFromArray(text: string, startIndex: number): any[] {
  const objects: any[] = [];
  let inString = false;
  let escape = false;
  let depth = 0;
  let objStart = -1;

  for (let i = startIndex + 1; i < text.length; i++) {
    const char = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === "\\") {
      escape = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        objStart = i;
      }
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0 && objStart !== -1) {
        const objStr = text.slice(objStart, i + 1);
        try {
          const parsed = JSON.parse(objStr);
          if (parsed && typeof parsed === "object") {
            objects.push(parsed);
          }
        } catch {}
        objStart = -1;
      }
    } else if (char === "]" && depth === 0) {
      // End of pages array reached cleanly
      break;
    }
  }

  return objects;
}

/**
 * Validates and filters extracted page records against the Page Acceptance Contract.
 */
export function recoverValidatedBatchPages(
  rawTextOrJson: unknown,
  expectedPages: ExpectedBatchPage[],
): RecoveredBatchResult {
  const expectedMap = new Map<string, ExpectedBatchPage>();
  for (const exp of expectedPages) {
    expectedMap.set(String(exp.pageId).trim(), exp);
  }

  let rawPageCandidates: any[] = [];
  let isTruncated = false;

  if (typeof rawTextOrJson === "string") {
    rawPageCandidates = extractPageObjectsFromRawText(rawTextOrJson);
    // If text does not end with a closed brace, it is truncated
    const trimmed = rawTextOrJson.trim();
    if (!trimmed.endsWith("}") && !trimmed.endsWith("```")) {
      isTruncated = true;
    }
  } else if (rawTextOrJson && typeof rawTextOrJson === "object") {
    if (Array.isArray((rawTextOrJson as any).pages)) {
      rawPageCandidates = (rawTextOrJson as any).pages;
    }
  }

  const completedPages: ValidatedBatchPageResult[] = [];
  const seenIds = new Set<string>();

  for (const candidate of rawPageCandidates) {
    if (!candidate || typeof candidate !== "object") continue;
    if (typeof candidate.pageId === "undefined") continue;

    const pid = String(candidate.pageId).trim();
    if (!expectedMap.has(pid)) {
      // Discard unexpected page ID not in input submission
      continue;
    }

    if (seenIds.has(pid)) {
      // Discard duplicate page IDs
      continue;
    }

    const expected = expectedMap.get(pid)!;

    // Check translations array
    if (!Array.isArray(candidate.translations)) continue;
    if (expected.expectedCount >= 0 && candidate.translations.length !== expected.expectedCount) {
      continue;
    }

    // Check types
    let validTranslations = true;
    const cleanTranslations: string[] = [];
    for (const t of candidate.translations) {
      if (t === null || t === undefined || typeof t !== "string") {
        validTranslations = false;
        break;
      }
      cleanTranslations.push(t);
    }
    if (!validTranslations) continue;

    // Check sourceTexts if provided
    let cleanSourceTexts: string[] | undefined = undefined;
    if (Array.isArray(candidate.sourceTexts)) {
      const matchCount = expected.expectedCount >= 0 ? expected.expectedCount : cleanTranslations.length;
      if (candidate.sourceTexts.length === matchCount) {
        cleanSourceTexts = candidate.sourceTexts.map((s: any) =>
          typeof s === "string" ? s : String(s || ""),
        );
      }
    }

    // Truthful completeness: if source text exists, translation cannot be silently empty
    if (cleanSourceTexts) {
      let droppedDialogue = false;
      const countToCheck = expected.expectedCount >= 0 ? expected.expectedCount : cleanTranslations.length;
      for (let i = 0; i < countToCheck; i++) {
        const src = cleanSourceTexts[i]?.trim();
        const trans = cleanTranslations[i]?.trim();
        if (src && src.length > 0 && (!trans || trans.length === 0)) {
          droppedDialogue = true;
          break;
        }
      }
      if (droppedDialogue) continue; // Reject incomplete translation
    }

    completedPages.push({
      pageId: pid,
      translations: cleanTranslations,
      ...(cleanSourceTexts ? { sourceTexts: cleanSourceTexts } : {}),
    });
    seenIds.add(pid);
  }

  const unfinishedPageIds = expectedPages
    .map((p) => String(p.pageId).trim())
    .filter((id) => !seenIds.has(id));

  return {
    completedPages,
    unfinishedPageIds,
    isFullyComplete: unfinishedPageIds.length === 0,
    isTruncated: isTruncated || unfinishedPageIds.length > 0,
    totalExpected: expectedPages.length,
    totalRecovered: completedPages.length,
    rawPageRecordsExtracted: rawPageCandidates.length,
  };
}
