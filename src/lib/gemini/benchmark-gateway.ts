/**
 * Controlled Benchmark Transport Gateway & Enforceable Request Ledger (M1.5 Section 5)
 *
 * Guarantees:
 * 1. Strict concurrency limit = 1.
 * 2. Strict per-trial POST attempt limit = 1 (Zero automatic retries).
 * 3. Strict mission-wide POST budget = 3 maximum.
 * 4. Durable attempt reservation in persistent storage BEFORE HTTP transmission.
 * 5. Ambiguous dispatch (timeout, network error, 429, 503) marked as consumed.
 * 6. Direct single-shot transport: completely bypasses background/offscreen retry loops.
 */

import fs from "fs";
import path from "path";
import { recoverValidatedBatchPages, type RecoveredBatchResult } from "./resilient-recovery";
import type { ExpectedBatchPage } from "../server/validator";

export interface LedgerEntry {
  experimentId: string;
  trialId: string;
  fingerprint: string;
  attemptNumber: number;
  missionBudgetUsed: number;
  missionBudgetRemaining: number;
  timestamp: number;
  model: string;
  thinkingConfig: { thinkingLevel: string };
  temperature: number;
  maxOutputTokens: number;
  inputMethod: "inline_rest" | "file_api";
  inputStats: {
    pageCount: number;
    pageIds: string[];
    bboxCount: number;
    totalImageBytes: number;
    promptTokenCountEstimated?: number;
  };
  dispatchStatus: "RESERVED" | "DISPATCHED" | "SUCCESS" | "FAILED" | "TIMEOUT" | "REJECTED_QUOTA";
  httpStatus?: number;
  finishReason?: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  recoveryResult?: {
    completedPagesCount: number;
    unfinishedPagesCount: number;
    isFullyComplete: boolean;
    isTruncated: boolean;
  };
  timingMs?: number;
  error?: string;
}

export interface BenchmarkLedgerState {
  missionBudgetLimit: number;
  missionAttemptsConsumed: number;
  entries: LedgerEntry[];
}

export class BenchmarkTransportGateway {
  private ledgerPath: string;
  private isLocked: boolean = false;
  private readonly MAX_MISSION_ATTEMPTS = 3;

  constructor(customLedgerPath?: string) {
    this.ledgerPath =
      customLedgerPath ||
      path.resolve(process.cwd(), "benchmark-ledger.json");
  }

  getLedgerState(): BenchmarkLedgerState {
    if (fs.existsSync(this.ledgerPath)) {
      try {
        const raw = fs.readFileSync(this.ledgerPath, "utf8");
        return JSON.parse(raw);
      } catch {}
    }
    return {
      missionBudgetLimit: this.MAX_MISSION_ATTEMPTS,
      missionAttemptsConsumed: 0,
      entries: [],
    };
  }

  saveLedgerState(state: BenchmarkLedgerState): void {
    fs.writeFileSync(this.ledgerPath, JSON.stringify(state, null, 2), "utf8");
  }

  resetLedgerForTesting(): void {
    if (fs.existsSync(this.ledgerPath)) {
      fs.unlinkSync(this.ledgerPath);
    }
    this.isLocked = false;
  }

  /**
   * Executes a single, strictly controlled benchmark inference request.
   * NEVER retries. Rejects if budget exhausted or trialId already seen.
   */
  async executeBenchmarkInference(params: {
    experimentId: string;
    trialId: string;
    apiKey: string;
    model?: string;
    temperature?: number;
    maxOutputTokens?: number;
    thinkingLevel?: "low" | "medium" | "high";
    systemPrompt: string;
    userPrompt: string;
    parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
    expectedPages: ExpectedBatchPage[];
    timeoutMs?: number;
    customFetch?: typeof fetch;
  }): Promise<{
    success: boolean;
    entry: LedgerEntry;
    recovered?: RecoveredBatchResult;
    rawText?: string;
  }> {
    if (this.isLocked) {
      throw new Error("Benchmark concurrency violation: Another benchmark inference request is currently active!");
    }

    this.isLocked = true;

    try {
      const state = this.getLedgerState();

      // Check mission-wide budget limit
      if (state.missionAttemptsConsumed >= this.MAX_MISSION_ATTEMPTS) {
        throw new Error(
          `HARD SAFETY GATE: Mission budget exhausted! Attempted ${state.missionAttemptsConsumed + 1} of ${this.MAX_MISSION_ATTEMPTS} allowed requests. Zero new requests permitted.`,
        );
      }

      // Prevent duplicate trial IDs
      const duplicate = state.entries.find((e) => e.trialId === params.trialId);
      if (duplicate) {
        throw new Error(
          `HARD SAFETY GATE: Duplicate trial ID '${params.trialId}' detected! This trial was already executed or reserved at ${new Date(duplicate.timestamp).toISOString()}.`,
        );
      }

      const attemptNum = state.missionAttemptsConsumed + 1;
      const model = params.model || "gemini-3.8-flash";
      const temperature = params.temperature ?? 0.2;
      const maxOutputTokens = params.maxOutputTokens ?? 65536;
      const thinkingLevel = params.thinkingLevel || "medium";
      const timeoutMs = params.timeoutMs ?? 180_000;

      const pageIds = params.expectedPages.map((p) => p.pageId);
      const totalBboxes = params.expectedPages.reduce((acc, p) => acc + p.expectedCount, 0);
      const totalImageBytes = params.parts.reduce((acc, part) => {
        if (part.inlineData?.data) {
          return acc + Math.round((part.inlineData.data.length * 3) / 4);
        }
        return acc;
      }, 0);

      // STEP 1: RESERVE ATTEMPT IN DURABLE STORAGE BEFORE TRANSMISSION
      state.missionAttemptsConsumed++;
      const entry: LedgerEntry = {
        experimentId: params.experimentId,
        trialId: params.trialId,
        fingerprint: `trial-${params.trialId}-${Date.now()}`,
        attemptNumber: attemptNum,
        missionBudgetUsed: state.missionAttemptsConsumed,
        missionBudgetRemaining: this.MAX_MISSION_ATTEMPTS - state.missionAttemptsConsumed,
        timestamp: Date.now(),
        model,
        thinkingConfig: { thinkingLevel },
        temperature,
        maxOutputTokens,
        inputMethod: "inline_rest",
        inputStats: {
          pageCount: pageIds.length,
          pageIds,
          bboxCount: totalBboxes,
          totalImageBytes,
        },
        dispatchStatus: "RESERVED",
      };

      state.entries.push(entry);
      this.saveLedgerState(state);

      // STEP 2: DISPATCH REQUEST (SINGLE SHOT - ZERO RETRIES)
      entry.dispatchStatus = "DISPATCHED";
      this.saveLedgerState(state);

      const tStart = performance.now();
      const requestParts = [
        ...params.parts.map((item) =>
          item.inlineData
            ? { inlineData: item.inlineData }
            : { text: item.text ?? "" },
        ),
        { text: params.userPrompt },
      ];

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const fetchImpl = params.customFetch || fetch;

      // AbortController for strict timeout
      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": params.apiKey.trim(),
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: params.systemPrompt }],
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
              maxOutputTokens,
              thinkingConfig: {
                thinkingLevel,
              },
            },
          }),
          signal: controller.signal,
        });
      } catch (err: any) {
        clearTimeout(timeoutTimer);
        const durationMs = Math.round(performance.now() - tStart);
        entry.timingMs = durationMs;

        if (err.name === "AbortError" || String(err).includes("timeout")) {
          entry.dispatchStatus = "TIMEOUT";
          entry.error = `Request timed out after ${timeoutMs / 1000}s`;
        } else {
          entry.dispatchStatus = "FAILED";
          entry.error = err?.message || String(err);
        }

        this.saveLedgerState(state);
        return { success: false, entry };
      }

      clearTimeout(timeoutTimer);
      const durationMs = Math.round(performance.now() - tStart);
      entry.timingMs = durationMs;
      entry.httpStatus = response.status;

      if (!response.ok) {
        let errBody = "";
        try {
          errBody = await response.text();
        } catch {}

        if (response.status === 429) {
          entry.dispatchStatus = "REJECTED_QUOTA";
          entry.error = `HTTP 429 Rate Limit / Quota Exceeded: ${errBody}`;
        } else {
          entry.dispatchStatus = "FAILED";
          entry.error = `HTTP ${response.status} ${response.statusText}: ${errBody}`;
        }

        this.saveLedgerState(state);
        return { success: false, entry };
      }

      // STEP 3: PARSE AND RECOVER PARTIAL RESULTS
      const resultJson = await response.json();
      const candidate = resultJson.candidates?.[0];
      const resultText = candidate?.content?.parts?.[0]?.text || "";
      entry.finishReason = candidate?.finishReason || "UNKNOWN";

      if (resultJson.usageMetadata) {
        entry.usageMetadata = {
          promptTokenCount: resultJson.usageMetadata.promptTokenCount,
          candidatesTokenCount: resultJson.usageMetadata.candidatesTokenCount,
          thoughtsTokenCount: resultJson.usageMetadata.thoughtsTokenCount,
          totalTokenCount: resultJson.usageMetadata.totalTokenCount,
        };
      }

      // Recover valid page records using the Resilient Page Recovery Parser
      const recovery = recoverValidatedBatchPages(resultText, params.expectedPages);

      entry.recoveryResult = {
        completedPagesCount: recovery.completedPages.length,
        unfinishedPagesCount: recovery.unfinishedPageIds.length,
        isFullyComplete: recovery.isFullyComplete,
        isTruncated: recovery.isTruncated,
      };

      entry.dispatchStatus = recovery.isFullyComplete ? "SUCCESS" : "SUCCESS"; // HTTP succeeded, output recorded
      this.saveLedgerState(state);

      return {
        success: true,
        entry,
        recovered: recovery,
        rawText: resultText,
      };
    } finally {
      this.isLocked = false;
    }
  }
}

