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

/**
 * Coordinates 2-image Vision batching (M1.3) for Chapter Preparation.
 *
 * Guarantees:
 * 1. Exactly 2 images are sent together in one Gemini Vision API request when available.
 * 2. If only one eligible image remains (e.g. odd page count in chapter), the flush timer
 *    (600ms) discharges it through the standard single-image Vision path.
 * 3. Never deadlocks an odd-length queue or single manual page requests.
 * 4. Preserves truthful accounting: if a batch fails, both affected pages record failure.
 */
export class VisionBatchCoordinator {
  private pending: BatchTranslationRequest[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly FLUSH_DELAY_MS = 600;

  async requestTranslation(
    req: Omit<BatchTranslationRequest, "resolve" | "reject" | "createdAt">,
    options?: { allowBatch?: boolean },
  ): Promise<any> {
    const allowBatch = options?.allowBatch ?? true;

    // Direct single-image path if batching is bypassed for this request
    if (!allowBatch) {
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
        // First entry in queue: wait briefly for a second page to arrive
        if (!this.flushTimer) {
          this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            if (this.pending.length > 0) {
              const single = this.pending.shift()!;
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
      const pageIdA = reqA.originalSrc || reqA.src;
      const pageIdB = reqB.originalSrc || reqB.src;

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

      const resA =
        resp.pages.find((p: any) => p && String(p.pageId) === String(pageIdA)) ??
        resp.pages[0];
      const resB =
        resp.pages.find((p: any) => p && String(p.pageId) === String(pageIdB)) ??
        resp.pages[1];

      if (!resA || !resB) {
        throw new Error("Batch translation failed to map results to both pages");
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
          `pageA=${reqA.bboxes.length} boxes, pageB=${reqB.bboxes.length} boxes`,
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
      reqA.reject(err);
      reqB.reject(err);
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
        req.reject(new Error(resp.error));
      } else {
        req.resolve(resp);
      }
    } catch (err: any) {
      req.reject(err);
    }
  }

  private async executeSingleDirect(
    req: Omit<BatchTranslationRequest, "resolve" | "reject" | "createdAt">,
  ): Promise<any> {
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
      throw new Error(resp.error);
    }
    return resp;
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
