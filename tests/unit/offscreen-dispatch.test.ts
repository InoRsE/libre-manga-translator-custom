import { describe, it, expect, mock } from "bun:test";

describe("Offscreen Translation Dispatch Diagnostic & Guard", () => {
  it("proves Gemini translation completes and responds immediately without blocking on hanging WebGPU requestAdapter", async () => {
    let capturedListener: any = null;
    (globalThis as any).browser = {
      runtime: {
        getURL: (path: string) => `chrome-extension://mock/${path}`,
        onMessage: {
          addListener: (fn: any) => {
            capturedListener = fn;
          },
        },
      },
    };

    await import("../../src/entrypoints/offscreen/main");

    // Mock Gemini API fetch to return instantly with valid translations
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("generateContent")) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        translations: ["ข้อความทดสอบ"],
                        sourceTexts: ["Test text"],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    }) as any;

    // Mock document and Image for drawNumberedBboxes
    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === "canvas") {
          return {
            width: 100,
            height: 100,
            getContext: () => ({
              drawImage: () => {},
              strokeRect: () => {},
              fillRect: () => {},
              measureText: () => ({ width: 10 }),
              fillText: () => {},
            }),
            toDataURL: () => "data:image/jpeg;base64,mockdata",
          };
        }
        return {};
      },
    };

    (globalThis as any).Image = class {
      width = 100;
      height = 100;
      onload: any = null;
      onerror: any = null;
      set src(val: string) {
        setTimeout(() => this.onload?.(), 1);
      }
    };

    // Simulate deadlocked WebGPU driver where requestAdapter promise NEVER settles
    (globalThis as any).navigator = {
      gpu: {
        requestAdapter: () => new Promise(() => {}), // hangs forever
      },
    };

    let responseData: any = null;
    const sendResponse = (data: any) => {
      responseData = data;
    };

    const msg = {
      type: "OFFSCREEN_TRANSLATE_IMAGE",
      config: {
        currentMode: "gemini",
        geminiWorkflow: "vision",
        geminiKey: "mock-key",
        geminiModel: "gemini-3.7-flash",
        targetLang: "Thai",
        sourceLang: "English",
      },
      data: {
        src: "data:image/jpeg;base64,mock",
        bboxes: [{ x1: 0, y1: 0, x2: 10, y2: 10 }],
      },
    };

    // Execute handler
    capturedListener(msg, {}, sendResponse);

    // Wait 50ms
    await new Promise((r) => setTimeout(r, 50));

    // VERIFICATION: With the fix, responseData is NOT blocked by hanging requestAdapter!
    // It returns immediately with valid translations.
    expect(responseData).toBeDefined();
    expect(responseData.translations).toEqual(["ข้อความทดสอบ"]);
    expect(responseData.geminiWorkflow).toBe("vision");
    expect(responseData.backend).toBeUndefined();
  });
});
