import { describe, expect, it, beforeEach } from "bun:test";
import {
  validateBatchTranslationResult,
  type ExpectedBatchPage,
} from "@/lib/server/validator";
import { VisionBatchCoordinator } from "@/lib/gemini/batch-coordinator";

describe("Gemini Vision 2-Image Batching (M1.3)", () => {
  describe("validateBatchTranslationResult — Strict Schema & Mapping", () => {
    const expectedPages: ExpectedBatchPage[] = [
      { pageId: "page-1", expectedCount: 3 },
      { pageId: "page-2", expectedCount: 2 },
    ];

    it("strictly maps translations and sourceTexts to each expected page by ID", () => {
      const raw = {
        pages: [
          {
            pageId: "page-1",
            translations: ["ข้อความ 1", "ข้อความ 2", "ข้อความ 3"],
            sourceTexts: ["Text 1", "Text 2", "Text 3"],
          },
          {
            pageId: "page-2",
            translations: ["ข้อความ A", "ข้อความ B"],
            sourceTexts: ["Text A", "Text B"],
          },
        ],
        context: {
          summary: "A naval historical manga",
          dictionary: "Mirai -> เรือมิไร",
        },
      };

      const validated = validateBatchTranslationResult(raw, expectedPages);
      expect(validated.pages.length).toBe(2);
      expect(validated.pages[0].pageId).toBe("page-1");
      expect(validated.pages[0].translations).toEqual(["ข้อความ 1", "ข้อความ 2", "ข้อความ 3"]);
      expect(validated.pages[0].sourceTexts).toEqual(["Text 1", "Text 2", "Text 3"]);

      expect(validated.pages[1].pageId).toBe("page-2");
      expect(validated.pages[1].translations).toEqual(["ข้อความ A", "ข้อความ B"]);
      expect(validated.pages[1].sourceTexts).toEqual(["Text A", "Text B"]);

      expect(validated.context?.summary).toBe("A naval historical manga");
      expect(validated.context?.dictionary).toBe("Mirai -> เรือมิไร");
    });

    it("correctly preserves page mapping even if Gemini reorders pages in response array", () => {
      const raw = {
        pages: [
          {
            pageId: "page-2",
            translations: ["ข้อความ A", "ข้อความ B"],
            sourceTexts: ["Text A", "Text B"],
          },
          {
            pageId: "page-1",
            translations: ["ข้อความ 1", "ข้อความ 2", "ข้อความ 3"],
            sourceTexts: ["Text 1", "Text 2", "Text 3"],
          },
        ],
      };

      const validated = validateBatchTranslationResult(raw, expectedPages);
      expect(validated.pages[0].pageId).toBe("page-1");
      expect(validated.pages[0].translations).toEqual(["ข้อความ 1", "ข้อความ 2", "ข้อความ 3"]);
      expect(validated.pages[1].pageId).toBe("page-2");
      expect(validated.pages[1].translations).toEqual(["ข้อความ A", "ข้อความ B"]);
    });

    it("strictly throws if returned translations count does not match expected box count", () => {
      const rawWithMissingBox = {
        pages: [
          {
            pageId: "page-1",
            translations: ["ข้อความ 1", "ข้อความ 2"], // Expected 3! Missing 1
            sourceTexts: ["Text 1", "Text 2"],
          },
          {
            pageId: "page-2",
            translations: ["ข้อความ A", "ข้อความ B"],
            sourceTexts: ["Text A", "Text B"],
          },
        ],
      };

      expect(() =>
        validateBatchTranslationResult(rawWithMissingBox, expectedPages),
      ).toThrow(/count mismatch on page 'page-1'/i);
    });

    it("strictly throws if a pageId is missing and cannot be resolved", () => {
      const rawMissingPage = {
        pages: [
          {
            pageId: "wrong-id",
            translations: ["1", "2", "3"],
          },
        ],
      };

      expect(() =>
        validateBatchTranslationResult(rawMissingPage, expectedPages),
      ).toThrow(/page count mismatch/i);
    });

    it("strictly throws if duplicate pageIds are returned", () => {
      const rawDuplicate = {
        pages: [
          {
            pageId: "page-1",
            translations: ["1", "2", "3"],
          },
          {
            pageId: "page-1", // duplicate!
            translations: ["A", "B"],
          },
        ],
      };

      expect(() =>
        validateBatchTranslationResult(rawDuplicate, expectedPages),
      ).toThrow(/duplicate pageId/i);
    });

    it("safely handles 0-bounding-box pages", () => {
      const zeroExpected: ExpectedBatchPage[] = [
        { pageId: "art-page", expectedCount: 0 },
        { pageId: "dialogue-page", expectedCount: 1 },
      ];
      const raw = {
        pages: [
          { pageId: "art-page", translations: [], sourceTexts: [] },
          { pageId: "dialogue-page", translations: ["สวัสดี"], sourceTexts: ["Hello"] },
        ],
      };

      const validated = validateBatchTranslationResult(raw, zeroExpected);
      expect(validated.pages[0].translations).toEqual([]);
      expect(validated.pages[1].translations).toEqual(["สวัสดี"]);
    });
  });

  describe("VisionBatchCoordinator — Queue Lifecycle & Pair Dispatch", () => {
    let coordinator: VisionBatchCoordinator;

    beforeEach(() => {
      coordinator = new VisionBatchCoordinator();
    });

    it("can instantiate and clear without error", () => {
      expect(coordinator).toBeDefined();
      coordinator.clear();
    });

    it("bypasses batching when allowBatch is false (direct single execution)", async () => {
      // Mock global browser.runtime.sendMessage
      let sentType = "";
      (globalThis as any).browser = {
        runtime: {
          sendMessage: async (msg: any) => {
            sentType = msg.type;
            return {
              translations: ["Thai 1"],
              sourceTexts: ["Eng 1"],
            };
          },
        },
      };

      const res = await coordinator.requestTranslation(
        {
          src: "image-1.jpg",
          originalSrc: "image-1.jpg",
          bboxes: [{ x1: 0, y1: 0, x2: 10, y2: 10, confidence: 1 }],
          config: {},
        },
        { allowBatch: false },
      );

      expect(sentType).toBe("TRANSLATE_IMAGE");
      expect(res.translations).toEqual(["Thai 1"]);
    });

    it("batches 2 concurrent requests into 1 TRANSLATE_BATCH_IMAGES call", async () => {
      let sentType = "";
      let sentPagesCount = 0;

      (globalThis as any).browser = {
        runtime: {
          sendMessage: async (msg: any) => {
            sentType = msg.type;
            if (msg.type === "TRANSLATE_BATCH_IMAGES") {
              sentPagesCount = msg.data.pages.length;
              return {
                pages: [
                  {
                    pageId: "pageA.jpg",
                    translations: ["ข้อความ A1", "ข้อความ A2"],
                    sourceTexts: ["A1", "A2"],
                  },
                  {
                    pageId: "pageB.jpg",
                    translations: ["ข้อความ B1"],
                    sourceTexts: ["B1"],
                  },
                ],
              };
            }
            return { error: "Unexpected single call" };
          },
        },
      };

      const pA = coordinator.requestTranslation({
        src: "pageA.jpg",
        originalSrc: "pageA.jpg",
        bboxes: [
          { x1: 0, y1: 0, x2: 10, y2: 10, confidence: 1 },
          { x1: 10, y1: 10, x2: 20, y2: 20, confidence: 1 },
        ],
        config: {},
      });

      const pB = coordinator.requestTranslation({
        src: "pageB.jpg",
        originalSrc: "pageB.jpg",
        bboxes: [{ x1: 0, y1: 0, x2: 10, y2: 10, confidence: 1 }],
        config: {},
      });

      const [resA, resB] = await Promise.all([pA, pB]);

      expect(sentType).toBe("TRANSLATE_BATCH_IMAGES");
      expect(sentPagesCount).toBe(2);

      expect(resA.translations).toEqual(["ข้อความ A1", "ข้อความ A2"]);
      expect(resA.batchInfo.isBatch).toBe(true);
      expect(resA.batchInfo.batchSize).toBe(2);

      expect(resB.translations).toEqual(["ข้อความ B1"]);
      expect(resB.batchInfo.isBatch).toBe(true);
      expect(resB.batchInfo.batchSize).toBe(2);
    });

    it("flushes odd page through TRANSLATE_IMAGE if companion does not arrive", async () => {
      let singleCalls = 0;

      (globalThis as any).browser = {
        runtime: {
          sendMessage: async (msg: any) => {
            if (msg.type === "TRANSLATE_IMAGE") {
              singleCalls++;
              return {
                translations: ["Single Thai"],
                sourceTexts: ["Single Eng"],
              };
            }
            return { error: "Unexpected batch call" };
          },
        },
      };

      // Only 1 page request queued (odd page at end of chapter)
      const resPromise = coordinator.requestTranslation({
        src: "odd-page.jpg",
        originalSrc: "odd-page.jpg",
        bboxes: [{ x1: 0, y1: 0, x2: 10, y2: 10, confidence: 1 }],
        config: {},
      });

      // The coordinator timer will fire at ~600ms
      const res = await resPromise;
      expect(singleCalls).toBe(1);
      expect(res.translations).toEqual(["Single Thai"]);
    });

    it("propagates failure to both pages if a batch request rejects", async () => {
      (globalThis as any).browser = {
        runtime: {
          sendMessage: async (msg: any) => {
            if (msg.type === "TRANSLATE_BATCH_IMAGES") {
              return { error: "Gemini API Quota Exceeded (429)" };
            }
            return {};
          },
        },
      };

      const pA = coordinator.requestTranslation({
        src: "pageA.jpg",
        originalSrc: "pageA.jpg",
        bboxes: [{ x1: 0, y1: 0, x2: 10, y2: 10, confidence: 1 }],
        config: {},
      });

      const pB = coordinator.requestTranslation({
        src: "pageB.jpg",
        originalSrc: "pageB.jpg",
        bboxes: [{ x1: 0, y1: 0, x2: 10, y2: 10, confidence: 1 }],
        config: {},
      });

      const [resA, resB] = await Promise.allSettled([pA, pB]);
      expect(resA.status).toBe("rejected");
      expect((resA as PromiseRejectedResult).reason.message).toContain("Quota Exceeded");
      expect(resB.status).toBe("rejected");
      expect((resB as PromiseRejectedResult).reason.message).toContain("Quota Exceeded");
    });
  });
});
