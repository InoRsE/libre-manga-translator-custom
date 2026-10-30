import { describe, it, expect, mock, afterEach } from "bun:test";
import { sendRequestToGemini, translateBatchWithGemini } from "@/lib/gemini/main";
import { validateBatchTranslationResult } from "@/lib/server/validator";

describe("Gemini Token Telemetry (M1.4 ACTION D)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("extracts usageMetadata from Gemini API response and preserves token counts", async () => {
    const mockUsage = {
      promptTokenCount: 1540,
      candidatesTokenCount: 220,
      thoughtsTokenCount: 0,
      totalTokenCount: 1760,
    };

    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      translations: ["สวัสดี 1", "สวัสดี 2"],
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: mockUsage,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as any;

    const res = await sendRequestToGemini(
      "system prompt",
      "user prompt",
      "valid-key-xyz",
      "gemini-3.7-flash",
      0.2,
    );

    expect(res).toBeDefined();
    expect(res.translations).toEqual(["สวัสดี 1", "สวัสดี 2"]);
    expect(res.usageMetadata).toBeDefined();
    expect(res.usageMetadata.promptTokenCount).toBe(1540);
    expect(res.usageMetadata.candidatesTokenCount).toBe(220);
    expect(res.usageMetadata.totalTokenCount).toBe(1760);
  });

  it("propagates usageMetadata through validateBatchTranslationResult", () => {
    const raw = {
      pages: [
        { pageId: "p1", translations: ["คำแปล 1"], sourceTexts: ["dialogue 1"] },
        { pageId: "p2", translations: ["คำแปล 2"], sourceTexts: ["dialogue 2"] },
      ],
      usageMetadata: {
        promptTokenCount: 2100,
        candidatesTokenCount: 340,
        totalTokenCount: 2440,
      },
    };

    const validated = validateBatchTranslationResult(raw, [
      { pageId: "p1", expectedCount: 1 },
      { pageId: "p2", expectedCount: 1 },
    ]);

    expect(validated.pages.length).toBe(2);
    expect(validated.usageMetadata).toBeDefined();
    expect(validated.usageMetadata?.promptTokenCount).toBe(2100);
    expect(validated.usageMetadata?.candidatesTokenCount).toBe(340);
    expect(validated.usageMetadata?.totalTokenCount).toBe(2440);
  });

  it("M1.5.1 Section 4: candidatesTokenCount and thoughtsTokenCount are separate metrics and never subtracted", async () => {
    // When Gemini Thinking generates reasoning tokens, thoughtsTokenCount is reported alongside candidatesTokenCount
    const mockThinkingUsage = {
      promptTokenCount: 1800,
      candidatesTokenCount: 500,
      thoughtsTokenCount: 320,
      totalTokenCount: 2620,
    };

    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      translations: ["แปล 1"],
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: mockThinkingUsage,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as any;

    const res = await sendRequestToGemini(
      "system prompt",
      "user prompt",
      "valid-key-xyz",
      "gemini-3.8-flash",
      0.2,
    );

    expect(res.usageMetadata).toBeDefined();
    // Distinct, un-subtracted instrumented counters
    expect(res.usageMetadata.candidatesTokenCount).toBe(500);
    expect(res.usageMetadata.thoughtsTokenCount).toBe(320);
    expect(res.usageMetadata.totalTokenCount).toBe(2620);
    // Explicitly verify they are NOT subtracted (i.e. candidatesTokenCount is not 500 - 320 = 180)
    expect(res.usageMetadata.candidatesTokenCount).not.toBe(500 - 320);
  });
});
