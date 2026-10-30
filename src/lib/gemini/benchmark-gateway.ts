/**
 * Controlled Benchmark Transport Gateway & Enforceable Request Ledger (M1.5 / M1.5.1)
 *
 * Guarantees:
 * 1. Strict cross-process single-writer exclusive reservation via atomic lockfile.
 * 2. Fail-closed handling: corrupted ledger halts execution immediately (never resets budget).
 * 3. Strict per-trial POST attempt limit = 1 (Zero automatic retries).
 * 4. Strict mission-wide POST budget = 3 maximum.
 * 5. Durable attempt reservation in persistent storage BEFORE HTTP transmission.
 * 6. Ambiguous dispatch (timeout, network error, 429, 503) marked as consumed.
 * 7. Direct single-shot transport: completely bypasses background/offscreen retry loops.
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

export function resolveDefaultLedgerPath(): string {
  if (process.env.BENCHMARK_LEDGER_PATH && process.env.BENCHMARK_LEDGER_PATH.trim().length > 0) {
    return path.resolve(process.env.BENCHMARK_LEDGER_PATH.trim());
  }
  // Search upward from current working directory to project root containing package.json or benchmark-ledger.json
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidateLedger = path.join(dir, "benchmark-ledger.json");
    const packageJson = path.join(dir, "package.json");
    if (fs.existsSync(candidateLedger)) {
      return path.resolve(candidateLedger);
    }
    if (fs.existsSync(packageJson)) {
      return path.resolve(candidateLedger);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd(), "benchmark-ledger.json");
}

export class BenchmarkTransportGateway {
  public readonly ledgerPath: string;
  public readonly lockFilePath: string;
  private inMemoryLocked: boolean = false;
  private lockFd: number | null = null;
  private readonly MAX_MISSION_ATTEMPTS = 3;

  constructor(customLedgerPath?: string) {
    this.ledgerPath = customLedgerPath
      ? path.resolve(customLedgerPath)
      : resolveDefaultLedgerPath();
    this.lockFilePath = `${this.ledgerPath}.lock`;
  }

  /**
   * Reads and parses the durable ledger with FAIL-CLOSED integrity check.
   * If the ledger file exists on disk but is unparseable or corrupted,
   * it strictly throws rather than resetting attempts to zero.
   */
  getLedgerState(): BenchmarkLedgerState {
    if (!fs.existsSync(this.ledgerPath)) {
      return {
        missionBudgetLimit: this.MAX_MISSION_ATTEMPTS,
        missionAttemptsConsumed: 0,
        entries: [],
      };
    }

    const raw = fs.readFileSync(this.ledgerPath, "utf8");
    let state: any;
    try {
      state = JSON.parse(raw);
    } catch (e: any) {
      throw new Error(
        `FAIL-CLOSED INTEGRITY ERROR: Corrupted benchmark ledger at '${this.ledgerPath}': ${e.message}. ` +
          `Refusing to proceed to prevent unauthorized budget reset.`,
      );
    }

    if (
      !state ||
      typeof state !== "object" ||
      typeof state.missionAttemptsConsumed !== "number" ||
      !Array.isArray(state.entries)
    ) {
      throw new Error(
        `FAIL-CLOSED INTEGRITY ERROR: Ledger at '${this.ledgerPath}' violates schema contract. ` +
          `Refusing to proceed.`,
      );
    }

    return state as BenchmarkLedgerState;
  }

  /**
   * Persists ledger state atomically using write-to-temp and atomic rename.
   */
  saveLedgerState(state: BenchmarkLedgerState): void {
    const tmpPath = `${this.ledgerPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmpPath, this.ledgerPath);
  }

  /**
   * Strictly isolates test resets to dedicated test ledger files.
   * Never allows wiping the production ledger!
   */
  resetLedgerForTesting(): void {
    if (!this.ledgerPath.toLowerCase().includes("test")) {
      throw new Error(
        `SAFETY REJECTION: Refusing to reset production ledger '${this.ledgerPath}'. ` +
          `Tests must use an explicit test ledger path containing 'test'.`,
      );
    }

    if (fs.existsSync(this.ledgerPath)) {
      fs.unlinkSync(this.ledgerPath);
    }
    this.releaseLock();
  }

  /**
   * Acquires cross-process lock via atomic file creation flag 'wx'.
   */
  private acquireLock(): void {
    if (this.inMemoryLocked) {
      throw new Error(
        "Benchmark concurrency violation (in-process): Another benchmark inference request is currently active in this process!",
      );
    }

    try {
      // Atomic cross-process lock creation: fails with EEXIST if lockfile exists
      this.lockFd = fs.openSync(this.lockFilePath, "wx");
      fs.writeSync(this.lockFd, `pid:${process.pid}\ntime:${Date.now()}\n`);
    } catch (err: any) {
      if (err.code === "EEXIST") {
        throw new Error(
          `Benchmark concurrency violation (cross-process): Lockfile '${this.lockFilePath}' is currently held by another process!`,
        );
      }
      throw err;
    }

    this.inMemoryLocked = true;
  }

  /**
   * Releases both in-process and cross-process locks cleanly.
   */
  private releaseLock(): void {
    if (this.lockFd !== null) {
      try {
        fs.closeSync(this.lockFd);
      } catch {}
      this.lockFd = null;
    }

    if (fs.existsSync(this.lockFilePath)) {
      try {
        fs.unlinkSync(this.lockFilePath);
      } catch {}
    }

    this.inMemoryLocked = false;
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
    this.acquireLock();

    try {
      const state = this.getLedgerState();

      // Check mission-wide budget limit
      if (state.missionAttemptsConsumed >= state.missionBudgetLimit) {
        throw new Error(
          `HARD SAFETY GATE: Mission budget exhausted! Attempted ${state.missionAttemptsConsumed + 1} of ${state.missionBudgetLimit} allowed requests. Zero new requests permitted.`,
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
      const totalBboxes = params.expectedPages.reduce(
        (acc, p) => acc + (p.expectedCount >= 0 ? p.expectedCount : 0),
        0,
      );
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
        missionBudgetRemaining: state.missionBudgetLimit - state.missionAttemptsConsumed,
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

      entry.dispatchStatus = "SUCCESS";
      this.saveLedgerState(state);

      return {
        success: true,
        entry,
        recovered: recovery,
        rawText: resultText,
      };
    } finally {
      this.releaseLock();
    }
  }
}
