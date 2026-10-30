import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import fs from "fs";
import path from "path";
import {
  BenchmarkTransportGateway,
  type BenchmarkLedgerState,
} from "../../src/lib/gemini/benchmark-gateway";
import {
  extractPageObjectsFromRawText,
  recoverValidatedBatchPages,
} from "../../src/lib/gemini/resilient-recovery";
import type { ExpectedBatchPage } from "../../src/lib/server/validator";

const TEST_LEDGER_PATH = path.resolve(process.cwd(), "test-benchmark-ledger.json");

describe("Hard Safety Gate & Resilient Recovery (M1.5)", () => {
  let gateway: BenchmarkTransportGateway;

  beforeEach(() => {
    if (fs.existsSync(TEST_LEDGER_PATH)) {
      fs.unlinkSync(TEST_LEDGER_PATH);
    }
    gateway = new BenchmarkTransportGateway(TEST_LEDGER_PATH);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_LEDGER_PATH)) {
      fs.unlinkSync(TEST_LEDGER_PATH);
    }
  });

  // ==========================================================================
  // SECTION 5: HARD SAFETY GATE TESTS
  // ==========================================================================
  describe("Section 5: Hard Safety Gate & Request Ledger Integrity", () => {
    const dummyExpectedPages: ExpectedBatchPage[] = [
      { pageId: "page_1", expectedCount: 2 },
    ];

    it("HTTP 429 Rate Limit -> Exactly 1 POST attempt maximum, zero retries", async () => {
      let postCount = 0;
      const customFetch = mock(async () => {
        postCount++;
        return new Response("RESOURCE_EXHAUSTED: Rate limit exceeded", {
          status: 429,
          statusText: "Too Many Requests",
        });
      }) as any;

      const res = await gateway.executeBenchmarkInference({
        experimentId: "exp-429",
        trialId: "trial-429-1",
        apiKey: "test-key",
        systemPrompt: "sys",
        userPrompt: "usr",
        parts: [],
        expectedPages: dummyExpectedPages,
        customFetch,
      });

      expect(postCount).toBe(1); // STRICTLY 1 POST
      expect(res.success).toBe(false);
      expect(res.entry.dispatchStatus).toBe("REJECTED_QUOTA");
      expect(res.entry.attemptNumber).toBe(1);
      expect(res.entry.missionBudgetUsed).toBe(1);
      expect(res.entry.missionBudgetRemaining).toBe(2);

      // Verify ledger persisted to disk
      const state = gateway.getLedgerState();
      expect(state.missionAttemptsConsumed).toBe(1);
      expect(state.entries.length).toBe(1);
      expect(state.entries[0].dispatchStatus).toBe("REJECTED_QUOTA");
    });

    it("Timeout -> Exactly 1 POST attempt maximum, zero retries, marked consumed", async () => {
      let postCount = 0;
      const customFetch = mock(async (_url: string, opts: any) => {
        postCount++;
        // Simulate hanging request that triggers abort
        return new Promise<Response>((_, reject) => {
          opts.signal.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }) as any;

      const res = await gateway.executeBenchmarkInference({
        experimentId: "exp-timeout",
        trialId: "trial-timeout-1",
        apiKey: "test-key",
        systemPrompt: "sys",
        userPrompt: "usr",
        parts: [],
        expectedPages: dummyExpectedPages,
        timeoutMs: 50, // 50ms fast timeout
        customFetch,
      });

      expect(postCount).toBe(1); // STRICTLY 1 POST
      expect(res.success).toBe(false);
      expect(res.entry.dispatchStatus).toBe("TIMEOUT");

      const state = gateway.getLedgerState();
      expect(state.missionAttemptsConsumed).toBe(1);
      expect(state.entries[0].dispatchStatus).toBe("TIMEOUT");
    });

    it("Crash / Network error -> Exactly 1 POST attempt, never retried", async () => {
      let postCount = 0;
      const customFetch = mock(async () => {
        postCount++;
        throw new Error("TypeError: Failed to fetch (Connection reset by peer)");
      }) as any;

      const res = await gateway.executeBenchmarkInference({
        experimentId: "exp-crash",
        trialId: "trial-crash-1",
        apiKey: "test-key",
        systemPrompt: "sys",
        userPrompt: "usr",
        parts: [],
        expectedPages: dummyExpectedPages,
        customFetch,
      });

      expect(postCount).toBe(1);
      expect(res.success).toBe(false);
      expect(res.entry.dispatchStatus).toBe("FAILED");
      expect(res.entry.error).toContain("Connection reset by peer");
    });

    it("Duplicate trial ID / command -> Rejects duplicate and makes 0 POSTs", async () => {
      let postCount = 0;
      const customFetch = mock(async () => {
        postCount++;
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        pages: [
                          {
                            pageId: "page_1",
                            translations: ["แปล 1", "แปล 2"],
                            sourceTexts: ["src 1", "src 2"],
                          },
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }) as any;

      // First run succeeds
      await gateway.executeBenchmarkInference({
        experimentId: "exp-dup",
        trialId: "trial-dup-unique",
        apiKey: "test-key",
        systemPrompt: "sys",
        userPrompt: "usr",
        parts: [],
        expectedPages: dummyExpectedPages,
        customFetch,
      });
      expect(postCount).toBe(1);

      // Second run with same trial ID must throw immediately
      expect(
        gateway.executeBenchmarkInference({
          experimentId: "exp-dup",
          trialId: "trial-dup-unique", // DUPLICATE!
          apiKey: "test-key",
          systemPrompt: "sys",
          userPrompt: "usr",
          parts: [],
          expectedPages: dummyExpectedPages,
          customFetch,
        }),
      ).rejects.toThrow(/Duplicate trial ID 'trial-dup-unique' detected/i);

      expect(postCount).toBe(1); // ZERO NEW POSTS
    });

    it("Mission budget exhausted -> Refuses 4th request and sends 0 POSTs", async () => {
      let postCount = 0;
      const customFetch = mock(async () => {
        postCount++;
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        pages: [
                          {
                            pageId: "page_1",
                            translations: ["1", "2"],
                            sourceTexts: ["1", "2"],
                          },
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }) as any;

      // Exhaust 3 attempts
      for (let i = 1; i <= 3; i++) {
        await gateway.executeBenchmarkInference({
          experimentId: "exp-budget",
          trialId: `trial-budget-${i}`,
          apiKey: "test-key",
          systemPrompt: "sys",
          userPrompt: "usr",
          parts: [],
          expectedPages: dummyExpectedPages,
          customFetch,
        });
      }

      expect(postCount).toBe(3);

      // Attempt 4 must be blocked hard by the ledger
      expect(
        gateway.executeBenchmarkInference({
          experimentId: "exp-budget",
          trialId: "trial-budget-4", // 4TH ATTEMPT!
          apiKey: "test-key",
          systemPrompt: "sys",
          userPrompt: "usr",
          parts: [],
          expectedPages: dummyExpectedPages,
          customFetch,
        }),
      ).rejects.toThrow(/HARD SAFETY GATE: Mission budget exhausted!/i);

      expect(postCount).toBe(3); // ZERO NEW POSTS CONSUMED
    });

    it("Concurrency Lock -> Blocks concurrent requests", async () => {
      const slowFetch = mock(async () => {
        await new Promise((r) => setTimeout(r, 100));
        return new Response(JSON.stringify({}), { status: 200 });
      }) as any;

      const p1 = gateway.executeBenchmarkInference({
        experimentId: "exp-lock",
        trialId: "trial-lock-1",
        apiKey: "test-key",
        systemPrompt: "sys",
        userPrompt: "usr",
        parts: [],
        expectedPages: dummyExpectedPages,
        customFetch: slowFetch,
      });

      // Simultaneous call must reject immediately
      expect(
        gateway.executeBenchmarkInference({
          experimentId: "exp-lock",
          trialId: "trial-lock-2",
          apiKey: "test-key",
          systemPrompt: "sys",
          userPrompt: "usr",
          parts: [],
          expectedPages: dummyExpectedPages,
          customFetch: slowFetch,
        }),
      ).rejects.toThrow(/Benchmark concurrency violation/i);

      await p1;
    });
  });

  // ==========================================================================
  // SECTION 6: RESILIENT PARTIAL RECOVERY TESTS
  // ==========================================================================
  describe("Section 6: Resilient Partial-Result Page Recovery", () => {
    const expectedPages: ExpectedBatchPage[] = [
      { pageId: "p1", expectedCount: 2 },
      { pageId: "p2", expectedCount: 2 },
      { pageId: "p3", expectedCount: 2 },
    ];

    it("extracts completed pages from truncated JSON cut off mid-stream", () => {
      // Stream cuts off while generating p3!
      const truncatedJson = `
      {
        "pages": [
          {
            "pageId": "p1",
            "translations": ["สวัสดี 1", "สวัสดี 2"],
            "sourceTexts": ["Hello 1", "Hello 2"]
          },
          {
            "pageId": "p2",
            "translations": ["ยินดีต้อนรับ", "ขอบคุณ"],
            "sourceTexts": ["Welcome", "Thank you"]
          },
          {
            "pageId": "p3",
            "translations": ["ข้อความที่สาม
      `;

      // Standard JSON.parse throws SyntaxError on this string!
      expect(() => JSON.parse(truncatedJson)).toThrow();

      // Resilient recovery extracts p1 and p2, discards truncated p3
      const recovery = recoverValidatedBatchPages(truncatedJson, expectedPages);

      expect(recovery.completedPages.length).toBe(2);
      expect(recovery.completedPages[0].pageId).toBe("p1");
      expect(recovery.completedPages[0].translations).toEqual(["สวัสดี 1", "สวัสดี 2"]);
      expect(recovery.completedPages[1].pageId).toBe("p2");
      expect(recovery.completedPages[1].translations).toEqual(["ยินดีต้อนรับ", "ขอบคุณ"]);

      expect(recovery.unfinishedPageIds).toEqual(["p3"]);
      expect(recovery.isFullyComplete).toBe(false);
      expect(recovery.isTruncated).toBe(true);
      expect(recovery.totalRecovered).toBe(2);
      expect(recovery.totalExpected).toBe(3);
    });

    it("strictly discards pages with incomplete dialogue coverage (truthful completeness)", () => {
      const partialDialogueJson = `
      {
        "pages": [
          {
            "pageId": "p1",
            "translations": ["แปล 1", "แปล 2"],
            "sourceTexts": ["Text 1", "Text 2"]
          },
          {
            "pageId": "p2",
            "translations": ["แปล 1", ""],
            "sourceTexts": ["Text 1", "Text 2 (Dialogue exists but translation dropped!)"]
          }
        ]
      }`;

      const recovery = recoverValidatedBatchPages(partialDialogueJson, expectedPages.slice(0, 2));

      // p1 is accepted
      expect(recovery.completedPages.length).toBe(1);
      expect(recovery.completedPages[0].pageId).toBe("p1");

      // p2 is rejected because translation was empty despite source dialogue existing
      expect(recovery.unfinishedPageIds).toContain("p2");
    });

    it("strictly discards duplicate page records", () => {
      const duplicateJson = `
      {
        "pages": [
          { "pageId": "p1", "translations": ["1", "2"], "sourceTexts": ["1", "2"] },
          { "pageId": "p1", "translations": ["DUP 1", "DUP 2"], "sourceTexts": ["1", "2"] }
        ]
      }`;

      const recovery = recoverValidatedBatchPages(duplicateJson, expectedPages.slice(0, 1));
      expect(recovery.completedPages.length).toBe(1);
      expect(recovery.completedPages[0].translations).toEqual(["1", "2"]);
    });

    it("recovers all pages cleanly when JSON is fully complete and closed", () => {
      const completeJson = `
      {
        "pages": [
          { "pageId": "p1", "translations": ["1", "2"], "sourceTexts": ["1", "2"] },
          { "pageId": "p2", "translations": ["A", "B"], "sourceTexts": ["A", "B"] },
          { "pageId": "p3", "translations": ["X", "Y"], "sourceTexts": ["X", "Y"] }
        ]
      }`;

      const recovery = recoverValidatedBatchPages(completeJson, expectedPages);
      expect(recovery.completedPages.length).toBe(3);
      expect(recovery.unfinishedPageIds.length).toBe(0);
      expect(recovery.isFullyComplete).toBe(true);
      expect(recovery.isTruncated).toBe(false);
    });
  });
});

