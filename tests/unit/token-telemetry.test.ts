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
        { pageId: "p1", translations: ["คำแปล 1"] },
        { pageId: "p2", translations: ["คำแปล 2"] },
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
});
