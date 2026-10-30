function getBrowser() {
  if (typeof browser !== "undefined" && browser?.runtime) {
    return browser;
  }
  if (typeof globalThis !== "undefined" && (globalThis as any).browser?.runtime) {
    return (globalThis as any).browser;
  }
  throw new Error("Extension browser runtime environment not available");
}

export interface BatchTranslationRequest {
  src: string;
  originalSrc: string;
  bboxes: Bbox[];
  seriesContext?: SeriesContext;
  config: any;
  resolve: (res: any) => void;
  reject: (err: any) => void;
  createdAt: number;
}

export interface BatchCoordinatorStats {
  batchesDispatched: number;
  singlesFlushed: number;
  singlesDirect: number;
}

/**
 * Coordinates 2-image Vision batching (M1.3.1) for Chapter Preparation.
 *
 * Guarantees:
 * 1. Exactly 2 images are sent together in one Gemini Vision API request when available.
 * 2. Strict page identity: matching only by exact pageId. No positional fallbacks!
 * 3. If only one eligible image remains (e.g. odd page count in chapter or no companion),
 *    discharges it through standard single-image Vision path without deadlocks.
 * 4. Error safety: pipeline errors resolve to `{ error: message }` conforming to the
 *    runtime message contract, so Overlays and queues settle into idle/failed gracefully.
 * 5. Complete accounting of paired vs flushed requests.
 */
export class VisionBatchCoordinator {
  private pending: BatchTranslationRequest[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly FLUSH_DELAY_MS = 800;

  private stats: BatchCoordinatorStats = {
    batchesDispatched: 0,
    singlesFlushed: 0,
    singlesDirect: 0,
  };

  getStats(): BatchCoordinatorStats {
    return { ...this.stats };
  }

  async requestTranslation(
    req: Omit<BatchTranslationRequest, "resolve" | "reject" | "createdAt">,
    options?: { allowBatch?: boolean; hasPendingCompanion?: boolean },
  ): Promise<any> {
    const allowBatch = options?.allowBatch ?? true;
    const hasPendingCompanion = options?.hasPendingCompanion ?? true;

    // Direct single-image path if batching is bypassed for this request (e.g. manual click)
    if (!allowBatch) {
      this.stats.singlesDirect++;
      return this.executeSingleDirect(req);
    }

    // If no other images exist in the chapter prep queue, flush immediately with 0ms delay!
    if (!hasPendingCompanion && this.pending.length === 0) {
      this.stats.singlesFlushed++;
      return this.executeSingleDirect(req);
    }

    return new Promise((resolve, reject) => {
      const entry: BatchTranslationRequest = {
        ...req,
        resolve,
        reject,
        createdAt: performance.now(),
      };

      this.pending.push(entry);

      if (this.pending.length >= 2) {
        if (this.flushTimer) {
          clearTimeout(this.flushTimer);
          this.flushTimer = null;
        }
        const pair = this.pending.splice(0, 2);
        this.executeBatch(pair);
      } else {
        // First entry in queue: wait briefly for companion page's detection to land
        if (!this.flushTimer) {
          this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            if (this.pending.length > 0) {
              const single = this.pending.shift()!;
              this.stats.singlesFlushed++;
              this.executeSingle(single);
            }
          }, this.FLUSH_DELAY_MS);
        }
      }
    });
  }

  private async executeBatch(pair: BatchTranslationRequest[]): Promise<void> {
    const [reqA, reqB] = pair;
    try {
      const pageIdA = String(reqA.originalSrc || reqA.src).trim();
      const pageIdB = String(reqB.originalSrc || reqB.src).trim();

      if (pageIdA === pageIdB) {
        throw new Error(`Cannot batch duplicate pageId '${pageIdA}' with itself`);
      }

      this.stats.batchesDispatched++;
      const tBatchStart = performance.now();
      const resp = await getBrowser().runtime.sendMessage({
        type: "TRANSLATE_BATCH_IMAGES",
        data: {
          pages: [
            { pageId: pageIdA, imageSrc: reqA.src, bboxes: reqA.bboxes },
            { pageId: pageIdB, imageSrc: reqB.src, bboxes: reqB.bboxes },
          ],
          seriesContext: reqA.seriesContext ?? reqB.seriesContext,
        },
        config: reqA.config,
      });

      const batchDuration = performance.now() - tBatchStart;

      if (resp?.error) {
        throw new Error(resp.error);
      }

      if (!resp?.pages || !Array.isArray(resp.pages)) {
        throw new Error("Batch translation response missing 'pages' array");
      }

      // STRICT IDENTITY: Match explicitly by pageId. NO positional fallback!
      const resA = resp.pages.find(
        (p: any) => p && String(p.pageId).trim() === pageIdA,
      );
      const resB = resp.pages.find(
        (p: any) => p && String(p.pageId).trim() === pageIdB,
      );

      if (!resA) {
        throw new Error(`Batch translation missing exact result for pageId '${pageIdA}'`);
      }
      if (!resB) {
        throw new Error(`Batch translation missing exact result for pageId '${pageIdB}'`);
      }

      // Strictly verify counts
      if (resA.translations.length !== reqA.bboxes.length) {
        throw new Error(
          `Page 1 translations count mismatch: expected ${reqA.bboxes.length}, got ${resA.translations.length}`,
        );
      }
      if (resB.translations.length !== reqB.bboxes.length) {
        throw new Error(
          `Page 2 translations count mismatch: expected ${reqB.bboxes.length}, got ${resB.translations.length}`,
        );
      }

      console.log(
        `[LMT Batch Vision] 2 pages translated together in ${batchDuration.toFixed(0)}ms: ` +
          `pageA=${reqA.bboxes.length} boxes, pageB=${reqB.bboxes.length} boxes ` +
          `(batch #${this.stats.batchesDispatched}, totalSinglesFlushed=${this.stats.singlesFlushed})`,
      );

      reqA.resolve({
        translations: resA.translations,
        sourceTexts: resA.sourceTexts ?? new Array(reqA.bboxes.length).fill(""),
        context: resp.context,
        gateSkip: new Array(reqA.bboxes.length).fill(null),
        gate: { mode: "off", checked: 0, skipped: 0, unavailable: false },
        timing: { translate: batchDuration },
        geminiWorkflow: "vision-batch",
        fallback: false,
        batchInfo: {
          batchSize: 2,
          isBatch: true,
          batchDurationMs: Math.round(batchDuration),
          companionSrc: reqB.originalSrc,
        },
      });

      reqB.resolve({
        translations: resB.translations,
        sourceTexts: resB.sourceTexts ?? new Array(reqB.bboxes.length).fill(""),
        context: resp.context,
        gateSkip: new Array(reqB.bboxes.length).fill(null),
        gate: { mode: "off", checked: 0, skipped: 0, unavailable: false },
        timing: { translate: batchDuration },
        geminiWorkflow: "vision-batch",
        fallback: false,
        batchInfo: {
          batchSize: 2,
          isBatch: true,
          batchDurationMs: Math.round(batchDuration),
          companionSrc: reqA.originalSrc,
        },
      });
    } catch (err: any) {
      console.warn("LMT: Vision batch request failed:", err?.message);
      // Fulfill promise with error contract so overlay catches and releases queue slot cleanly
      const errPayload = { error: err?.message ?? "Batch translation failed" };
      reqA.resolve(errPayload);
      reqB.resolve(errPayload);
    }
  }

  private async executeSingle(req: BatchTranslationRequest): Promise<void> {
    try {
      const resp = await getBrowser().runtime.sendMessage({
        type: "TRANSLATE_IMAGE",
        data: {
          src: req.src,
          bboxes: req.bboxes,
          seriesContext: req.seriesContext,
        },
        config: req.config,
      });

      if (resp?.error) {
        req.resolve({ error: resp.error });
      } else {
        req.resolve(resp);
      }
    } catch (err: any) {
      console.warn("LMT: Single translation request failed:", err?.message);
      req.resolve({ error: err?.message ?? "Single translation failed" });
    }
  }

  private async executeSingleDirect(
    req: Omit<BatchTranslationRequest, "resolve" | "reject" | "createdAt">,
  ): Promise<any> {
    try {
      const resp = await getBrowser().runtime.sendMessage({
        type: "TRANSLATE_IMAGE",
        data: {
          src: req.src,
          bboxes: req.bboxes,
          seriesContext: req.seriesContext,
        },
        config: req.config,
      });
      return resp;
    } catch (err: any) {
      return { error: err?.message ?? "Direct single translation failed" };
    }
  }

  clear(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const remaining = this.pending.splice(0, this.pending.length);
    for (const r of remaining) {
      this.executeSingle(r);
    }
  }
}
