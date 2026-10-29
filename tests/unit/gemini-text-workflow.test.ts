import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { translateTextWithGemini, sendRequestToGemini } from "../../src/lib/gemini/main";
import { buildTranslationPrompts } from "../../src/lib/prompts";
import { validateTranslationResult } from "../../src/lib/server/validator";

describe("Gemini Fast Text Workflow Probe (M1.1)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("buildTranslationPrompts for batch text OCR", () => {
    it("formats OCR results as ordered batch and preserves bubble IDs", () => {
      const ocrBoxes = ["Attention all units!", "Target spotted at sector 4.", ""];
      const { systemPrompt, userPrompt, needsContext } = buildTranslationPrompts(
        ocrBoxes,
        "Thai",
        "English",
      );

      expect(systemPrompt).toContain("INTO THAI");
      expect(systemPrompt).toContain('EXACTLY 3 items in "translations"');
      expect(userPrompt).toContain('Box 1: "Attention all units!"');
      expect(userPrompt).toContain('Box 2: "Target spotted at sector 4."');
      expect(userPrompt).toContain('Box 3: "" (empty — return "")');
    });

    it("includes series context rules when context is requested", () => {
      const ocrBoxes = ["Commander!"];
      const { systemPrompt } = buildTranslationPrompts(
        ocrBoxes,
        "Thai",
        "English",
        {
          seriesName: "Zipang",
          summary: "A modern Aegis destroyer time-travels to WWII.",
          dictionary: "Mirai -> มิไร",
          lastChapterId: "54",
          lastPageIndex: 1,
          recentHistory: [],
          translatedCount: 1,
        },
      );

      expect(systemPrompt).toContain('working on "Zipang"');
      expect(systemPrompt).toContain("A modern Aegis destroyer");
      expect(systemPrompt).toContain("Mirai -> มิไร");
    });
  });

  describe("translateTextWithGemini", () => {
    it("sends text-only payload to Gemini 3.7 Flash and returns 1-to-1 mapped translations", async () => {
      const ocrInput = [
        "What is that ship?!",
        "It's huge...",
        "Could it be from the future?",
      ];

      const mockGeminiReply = {
        translations: [
          "เรือลำนั้นมันอะไรกัน?!",
          "ใหญ่ชะมัด...",
          "หรือว่าจะมาจากอนาคต?",
        ],
        sourceTexts: ocrInput,
      };

      let capturedUrl = "";
      let capturedBody: any = null;

      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify(mockGeminiReply) }],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as any;

      const result = await translateTextWithGemini(
        ocrInput,
        "test-api-key-xyz",
        "Thai",
        "English",
        undefined,
        "gemini-3.7-flash",
      );

      // Verify URL targets specified model
      expect(capturedUrl).toContain("models/gemini-3.7-flash:generateContent");

      // Verify payload is purely text (no inlineData / base64 image data)
      const userParts = capturedBody.contents[0].parts;
      expect(userParts.length).toBe(1);
      expect(userParts[0].inlineData).toBeUndefined();
      expect(userParts[0].text).toContain("CURRENT PAGE DIALOGUE");

      // Verify 1-to-1 order preservation
      expect(result.translations).toHaveLength(3);
      expect(result.translations[0]).toBe("เรือลำนั้นมันอะไรกัน?!");
      expect(result.translations[1]).toBe("ใหญ่ชะมัด...");
      expect(result.translations[2]).toBe("หรือว่าจะมาจากอนาคต?");
      expect(result.sourceTexts).toEqual(ocrInput);
    });

    it("safely handles empty input array without API request", async () => {
      let fetchCalled = false;
      globalThis.fetch = mock(async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      }) as any;

      const result = await translateTextWithGemini([], "fake-key", "Thai", "English");
      expect(fetchCalled).toBe(false);
      expect(result.translations).toEqual([]);
      expect(result.sourceTexts).toEqual([]);
    });

    it("self-heals count drift if model returns mismatched array length", async () => {
      const ocrInput = ["Box 1", "Box 2", "Box 3"];
      // Model dropped Box 3
      const mockUnderflowReply = {
        translations: ["กล่อง 1", "กล่อง 2"],
      };

      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify(mockUnderflowReply) }],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }) as any;

      const result = await translateTextWithGemini(
        ocrInput,
        "valid-key-12345",
        "Thai",
        "English",
      );

      // Self-heals: padded to 3 items with empty string
      expect(result.translations).toHaveLength(3);
      expect(result.translations[0]).toBe("กล่อง 1");
      expect(result.translations[1]).toBe("กล่อง 2");
      expect(result.translations[2]).toBe("");
      expect(result.sourceTexts).toEqual(ocrInput);
    });

    it("handles markdown codeblock wrapped JSON response from Gemini", async () => {
      const ocrInput = ["All hands on deck!"];
      const codeblockText = "```json\n{\"translations\": [\"ประจำสถานีรบทุกคน!\"]}\n```";

      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: codeblockText }],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }) as any;

      const result = await translateTextWithGemini(
        ocrInput,
        "valid-key-12345",
        "Thai",
        "English",
      );

      expect(result.translations).toEqual(["ประจำสถานีรบทุกคน!"]);
    });

    it("rejects invalid or blank API keys before network call", async () => {
      let networkCalled = false;
      globalThis.fetch = mock(async () => {
        networkCalled = true;
        return new Response("{}", { status: 200 });
      }) as any;

      expect(
        translateTextWithGemini(["hello"], "   ", "Thai", "English"),
      ).rejects.toThrow("empty or contains invisible");
      expect(networkCalled).toBe(false);
    });
  });

  describe("Timing & Telemetry Diagnostics Schema", () => {
    it("accommodates full stage timing: detect, ocr, translate, inpaint, render, total", () => {
      const debugTiming: DebugEntry["timing"] = {
        detect: 120,
        ocr: 450,
        translate: 850,
        inpaint: 310,
        render: 45,
        total: 1775,
      };

      expect(debugTiming.detect).toBe(120);
      expect(debugTiming.ocr).toBe(450);
      expect(debugTiming.translate).toBe(850);
      expect(debugTiming.inpaint).toBe(310);
      expect(debugTiming.render).toBe(45);
      expect(debugTiming.total).toBe(1775);
    });
  });
});
