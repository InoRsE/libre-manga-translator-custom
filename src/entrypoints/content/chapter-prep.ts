import type { SiteRule } from "@/lib/adapters";
import { resolveActiveSiteRule, getSiteRule } from "@/lib/adapters";
import type { MangaTargetElement } from "@/lib/canvas";
import { getElementSrc } from "@/lib/canvas";
import * as Registry from "./translation-registry";
import type { AutoTranslateOrchestrator } from "./auto-translate";
import {
  saveChapterRecord,
  getChapterRecord,
  savePageRecord,
  getChapterPages,
  markChapterExported,
  generateChapterKey,
  type StoredChapter,
  type StoredPage,
} from "@/lib/artifacts/chapter-store";
import {
  createCbzBlob,
  formatCbzFilename,
  dataUrlToUint8Array,
  uint8ArrayToBase64,
  detectImageSignature,
  type CbzFileEntry,
} from "@/lib/export/cbz";
import { storage } from "#imports";
import { DefaultConfig } from "@/lib/configs";

export type ChapterPrepStatus =
  | "idle"
  | "preparing"
  | "ready"
  | "partial"
  | "failed";

export type ChapterDownloadState =
  | "not_started"
  | "archive_ready"
  | "download_started"
  | "download_completed"
  | "download_failed";

export interface ChapterPrepProgress {
  status: ChapterPrepStatus;
  downloadState?: ChapterDownloadState;
  expectedCount?: number;
  discovered: number;
  discoveredCount?: number;
  fetchedCount?: number;
  completed: number;
  verifiedCount?: number;
  failed: number;
  inFlight: number;
  chapterTitle: string;
  message: string;
  startTime?: number;
  endTime?: number;
  elapsedSeconds?: number;
  exportStatus?: "not_exported" | "exported";
  exportedFilename?: string;
}

/**
 * Normalizes lazy-loading attributes on an image element so the browser
 * begins downloading its source even while off-screen or in a background tab.
 */
export function normalizeImageSrc(img: HTMLImageElement): void {
  const dataSrc =
    img.getAttribute("data-src") ||
    img.getAttribute("data-lazy-src") ||
    img.getAttribute("data-original") ||
    img.getAttribute("data-url") ||
    img.getAttribute("data-page-url");

  if (dataSrc) {
    const cur = img.getAttribute("src") || "";
    if (
      !cur ||
      cur.startsWith("data:image/svg") ||
      cur.includes("placeholder") ||
      (typeof window !== "undefined" && cur === window.location.href)
    ) {
      img.src = dataSrc;
    }
  }

  if (img.loading === "lazy") {
    img.loading = "eager";
  }
}

/**
 * Determines whether an element qualifies as a candidate manga page image.
 * Strictly excludes advertisements, thumbnails, user avatars, and navigation icons.
 */
export function isCandidateMangaImage(
  img: MangaTargetElement,
  activeRule: SiteRule | null,
): boolean {
  if (typeof HTMLElement !== "undefined" && img instanceof HTMLElement) {
    // Check if element or parent matches known ad/sidebar patterns
    try {
      if (
        img.matches(
          ".ad, .banner, .promo, [id*='google_ads'], [class*='advertisement'], [class*='sponsor'], [class*='sidebar']",
        ) ||
        img.closest(
          ".ad, .banner, .promo, [id*='google_ads'], [class*='advertisement'], [class*='sponsor'], [class*='sidebar'], footer, header, nav",
        )
      ) {
        return false;
      }
    } catch {}
  }

  if (activeRule?.imageSelector) {
    try {
      if (img.matches(activeRule.imageSelector)) return true;
    } catch {
      // Ignore selector syntax error
    }
  }

  const naturalW = "naturalWidth" in img ? img.naturalWidth : img.width;
  const naturalH = "naturalHeight" in img ? img.naturalHeight : img.height;
  const clientW = img.clientWidth || img.offsetWidth;
  const clientH = img.clientHeight || img.offsetHeight;

  if (naturalW > 0 && naturalH > 0) {
    return naturalW > 300 || naturalH > 300;
  }
  if (clientW > 0 && clientH > 0) {
    return clientW > 300 || clientH > 300;
  }

  // Pre-loaded lazy images might have 0 dimensions initially; check data-src
  if (typeof HTMLImageElement !== "undefined" && img instanceof HTMLImageElement) {
    const hasDataSrc =
      img.hasAttribute("data-src") ||
      img.hasAttribute("data-lazy-src") ||
      img.hasAttribute("data-original");
    if (hasDataSrc) return true;
  }

  return false;
}

/**
 * Extracts total expected page count from page metadata, reader controls, or DOM.
 * Does not assume any fixed count per chapter.
 */
export function extractExpectedPageCount(
  doc: Document = document,
  activeRule?: SiteRule | null,
): number | undefined {
  // 1. Next.js reader state (e.g. comix.to, Next.js manga readers)
  const nextDataEl = doc.getElementById("__NEXT_DATA__");
  if (nextDataEl?.textContent) {
    try {
      const data = JSON.parse(nextDataEl.textContent);
      const findCount = (obj: any, depth = 0): number | undefined => {
        if (!obj || typeof obj !== "object" || depth > 7) return undefined;
        if (Array.isArray(obj.images) && obj.images.length > 0) return obj.images.length;
        if (Array.isArray(obj.pages) && obj.pages.length > 0) return obj.pages.length;
        if (typeof obj.total_pages === "number" && obj.total_pages > 0) return obj.total_pages;
        if (typeof obj.totalPages === "number" && obj.totalPages > 0) return obj.totalPages;
        if (typeof obj.pageCount === "number" && obj.pageCount > 0) return obj.pageCount;
        if (typeof obj.page_count === "number" && obj.page_count > 0) return obj.page_count;
        for (const k of Object.keys(obj)) {
          const res = findCount(obj[k], depth + 1);
          if (res) return res;
        }
        return undefined;
      };
      const found = findCount(data);
      if (found) return found;
    } catch {}
  }

  // 2. Active rule custom selector/regex
  if (activeRule?.pageCountSelector) {
    try {
      const targets = doc.querySelectorAll(activeRule.pageCountSelector);
      for (const el of targets) {
        if (el instanceof HTMLSelectElement && el.options.length > 1) {
          return el.options.length;
        }
        const text = el.textContent || "";
        const rx = activeRule.expectedCountRegex
          ? new RegExp(activeRule.expectedCountRegex, "i")
          : /\b(?:\/|of)\s*(\d{1,4})\b/i;
        const match = text.match(rx);
        if (match && match[1]) {
          const val = parseInt(match[1], 10);
          if (val > 0 && val < 2000) return val;
        }
      }
    } catch {}
  }

  // 3. Page select dropdown (common across MangaDex, MangaFire, Comix)
  const select = doc.querySelector<HTMLSelectElement>(
    "select[name='page'], select.page-select, select[id*='page'], .reader-page-select select",
  );
  if (select && select.options.length > 1) {
    return select.options.length;
  }

  // 4. Page indicator labels: e.g. "1 / 22" or "Page 1 of 22"
  const indicators = doc.querySelectorAll(
    "[class*='page-total'], [class*='total-pages'], [data-total-pages], [class*='page-count'], .pagination, footer, header",
  );
  for (const el of indicators) {
    const text = el.textContent || "";
    const match = text.match(/\b\d+\s*(?:\/|of)\s*(\d{1,4})\b/i);
    if (match && match[1]) {
      const val = parseInt(match[1], 10);
      if (val > 0 && val < 2000) return val;
    }
  }

  // 5. Placeholder wrapper elements in reader container
  const placeholders = doc.querySelectorAll(
    "[data-page], [data-page-index], [data-page-number], .reader-page, .page-item, .comic-page",
  );
  if (placeholders.length > 1) {
    return placeholders.length;
  }

  return undefined;
}

/**
 * Discovers currently mounted chapter manga page images in document order.
 */
export function findChapterImages(
  activeRule: SiteRule | null,
): MangaTargetElement[] {
  let queriedElements: MangaTargetElement[] = [];

  if (activeRule?.imageSelector) {
    const root = activeRule.containerSelector
      ? document.querySelector(activeRule.containerSelector) ?? document
      : document;
    try {
      const queried = Array.from(
        root.querySelectorAll<MangaTargetElement>(activeRule.imageSelector),
      );
      if (queried.length > 0) {
        queriedElements = queried;
      }
    } catch {
      // Ignore selector error
    }
  }

  if (queriedElements.length === 0) {
    const readerRoots = document.querySelectorAll(
      ".reader-container, #reader, .reader, #chapter-images, .chapter-images, [data-reader], .comic-container",
    );
    for (const root of readerRoots) {
      const found = Array.from(
        root.querySelectorAll<MangaTargetElement>("img, canvas"),
      );
      if (found.length > 0) {
        queriedElements = found;
        break;
      }
    }
  }

  if (queriedElements.length === 0) {
    queriedElements = Array.from(
      document.querySelectorAll<MangaTargetElement>("img, canvas"),
    );
  }

  // Filter qualifying candidates, normalize attributes, and preserve document order
  const validImages: MangaTargetElement[] = [];
  const seenSrcs = new Set<string>();

  for (const el of queriedElements) {
    if (el instanceof HTMLImageElement) {
      normalizeImageSrc(el);
    }
    if (isCandidateMangaImage(el, activeRule)) {
      const src = getElementSrc(el);
      const k = src ? Registry.srcKeyOf(src) : "";
      if (k && !seenSrcs.has(k)) {
        seenSrcs.add(k);
        validImages.push(el);
      } else if (!k && !validImages.includes(el)) {
        validImages.push(el);
      }
    }
  }

  // Sort strictly by DOM position (document order)
  if (
    validImages.length > 1 &&
    typeof validImages[0]?.compareDocumentPosition === "function"
  ) {
    const FOLLOWING =
      typeof Node !== "undefined" ? Node.DOCUMENT_POSITION_FOLLOWING : 4;
    const PRECEDING =
      typeof Node !== "undefined" ? Node.DOCUMENT_POSITION_PRECEDING : 2;
    validImages.sort((a, b) => {
      if (a === b) return 0;
      try {
        const pos = a.compareDocumentPosition(b);
        if (pos & FOLLOWING) return -1;
        if (pos & PRECEDING) return 1;
      } catch {}
      return 0;
    });
  }

  return validImages;
}

/**
 * Progressively triggers discovery on virtualized/lazy-scrolling readers.
 * Accumulates unique page identities across scrolling steps so pages unmounted
 * by the virtualizer are preserved.
 */
export async function discoverChapterImagesProgressive(
  activeRule: SiteRule | null,
  options?: {
    expectedCount?: number;
    maxScrollAttempts?: number;
    scrollDelayMs?: number;
  },
): Promise<{
  images: MangaTargetElement[];
  expectedCount: number;
  discoveredCount: number;
}> {
  const detectedExpected =
    options?.expectedCount ?? extractExpectedPageCount(document, activeRule);

  // Accumulate pages across all scroll steps to prevent virtualized unmount loss
  const accumulatedMap = new Map<string, MangaTargetElement>();
  const initialImages = findChapterImages(activeRule);
  for (const img of initialImages) {
    const src = getElementSrc(img);
    const k = src ? Registry.srcKeyOf(src) : "";
    if (k && !accumulatedMap.has(k)) {
      accumulatedMap.set(k, img);
    }
  }

  const expectedCount = detectedExpected ?? accumulatedMap.size;

  // If already discovered all expected pages (or no expected count known and 0 found)
  if (accumulatedMap.size >= expectedCount && expectedCount > 0) {
    return {
      images: Array.from(accumulatedMap.values()),
      expectedCount,
      discoveredCount: accumulatedMap.size,
    };
  }

  // Virtualized reader detected: container only mounts visible elements.
  // Scroll through reader container or document to trigger mounting of remaining pages.
  const container = activeRule?.containerSelector
    ? document.querySelector<HTMLElement>(activeRule.containerSelector)
    : (document.scrollingElement as HTMLElement) || document.documentElement;

  const originalScrollTop = container
    ? container.scrollTop
    : typeof window !== "undefined"
      ? window.scrollY
      : 0;
  const maxAttempts = options?.maxScrollAttempts ?? 25;
  const delayMs = options?.scrollDelayMs ?? 40;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const scrollStep = container?.clientHeight
      ? Math.max(800, container.clientHeight * 0.8)
      : 1000;
    if (container && container !== document.documentElement) {
      container.scrollTop += scrollStep;
    } else if (
      typeof window !== "undefined" &&
      typeof window.scrollBy === "function"
    ) {
      window.scrollBy(0, scrollStep);
    }

    try {
      if (container) {
        container.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("scroll"));
      }
    } catch {}

    await new Promise((r) => setTimeout(r, delayMs));

    const stepImages = findChapterImages(activeRule);
    for (const img of stepImages) {
      const src = getElementSrc(img);
      const k = src ? Registry.srcKeyOf(src) : "";
      if (k && !accumulatedMap.has(k)) {
        accumulatedMap.set(k, img);
      }
    }

    if (expectedCount > 0 && accumulatedMap.size >= expectedCount) {
      break;
    }

    // Check if bottom reached
    if (
      container &&
      container.scrollTop + container.clientHeight >= container.scrollHeight - 50
    ) {
      break;
    }
  }

  // Restore scroll position
  if (container && container !== document.documentElement) {
    container.scrollTop = originalScrollTop;
  } else if (
    typeof window !== "undefined" &&
    typeof window.scrollTo === "function"
  ) {
    window.scrollTo(0, originalScrollTop);
  }

  const finalImages = Array.from(accumulatedMap.values());
  return {
    images: finalImages,
    expectedCount: Math.max(expectedCount, finalImages.length),
    discoveredCount: finalImages.length,
  };
}

/**
 * Manages full chapter preparation in document order, tracking truthful
 * completed / discovered / failed counters, durable write ordering, and automatic CBZ export.
 */
export class ChapterPreparationManager {
  private orchestrator: AutoTranslateOrchestrator;
  private status: ChapterPrepStatus = "idle";
  private downloadState: ChapterDownloadState = "not_started";
  private expectedCount = 0;
  private discovered = 0;
  private fetchedCount = 0;
  private verifiedCount = 0;
  private completedKeys = new Set<string>();
  private failedKeys = new Set<string>();
  private inFlightKeys = new Set<string>();
  private savingKeys = new Set<string>();
  private targetKeys = new Set<string>();
  private imageIndexMap = new Map<string, number>();
  private orderedImages: MangaTargetElement[] = [];
  private seriesName = "MANGA";
  private chapterId = "001";
  private chapterKey = "";
  private chapterTitle = "";
  private message = "Ready to prepare chapter.";
  private startTime?: number;
  private endTime?: number;
  private exportStatus: "not_exported" | "exported" = "not_exported";
  private exportedFilename?: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private statusListener: ((e: Event) => void) | null = null;
  private shouldNotify = true;

  constructor(orchestrator: AutoTranslateOrchestrator) {
    this.orchestrator = orchestrator;

    this.statusListener = (e: Event) => {
      const detail = (
        e as CustomEvent<{ src?: string; status?: string }>
      ).detail;
      if (!detail?.src) return;
      const k = Registry.srcKeyOf(detail.src);

      if (detail.status === "pending") {
        if (this.targetKeys.has(k)) {
          this.inFlightKeys.add(k);
          this.fetchedCount++;
          this.updateProgressMessage();
          this.emitProgress();
        }
        return;
      }

      if (detail.status === "done") {
        if (this.targetKeys.has(k)) {
          this.targetKeys.delete(k);
          this.inFlightKeys.delete(k);

          // M1.4.1 REPAIR B: Verify rendered image asset before marking verified
          const rendered = Registry.getRenderedResult(detail.src);
          const renderedUrl = rendered?.renderedUrl;
          const isValidDataUrl =
            typeof renderedUrl === "string" &&
            (renderedUrl.startsWith("data:image/") || renderedUrl.startsWith("blob:"));

          if (!isValidDataUrl) {
            console.warn(`[LMT] Rendered image missing or invalid for page: ${detail.src}`);
            this.failedKeys.add(k);
            this.checkSettled();
            return;
          }

          const pageIdx = this.imageIndexMap.get(k) ?? -1;
          if (pageIdx < 0) {
            console.warn(`[LMT] Page index not mapped for page: ${detail.src}`);
            this.failedKeys.add(k);
            this.checkSettled();
            return;
          }

          // Await durable write before counting as verified (no fire-and-forget race!)
          this.savingKeys.add(k);
          savePageRecord({
            id: `${this.chapterKey}__page_${pageIdx}`,
            chapterKey: this.chapterKey,
            pageIndex: pageIdx,
            pageNumber: pageIdx + 1,
            src: detail.src,
            mimeType: "image/png",
            renderedDataUrl: renderedUrl,
            translations: rendered?.translations ?? [],
            sourceTexts: rendered?.sourceTexts,
            verified: true,
            status: "done",
            updatedAt: Date.now(),
          })
            .then(() => {
              this.completedKeys.add(k);
              this.verifiedCount++;
              this.failedKeys.delete(k);
            })
            .catch((err) => {
              console.error(`[LMT] Durable write failed for page ${pageIdx + 1}:`, err);
              this.failedKeys.add(k);
            })
            .finally(() => {
              this.savingKeys.delete(k);
              this.checkSettled();
            });
        }
        return;
      }

      if (detail.status === "idle") {
        if (this.targetKeys.has(k)) {
          this.inFlightKeys.delete(k);
          this.failedKeys.add(k);
          this.targetKeys.delete(k);
          this.checkSettled();
        }
      }
    };

    document.addEventListener("lmt:translation-status", this.statusListener);
  }

  /**
   * Returns true if Chapter Preparation is actively running.
   */
  isActive(): boolean {
    return this.status === "preparing";
  }

  /**
   * Returns true if the given image src is tracked by the active chapter prep run.
   */
  isPreparingImage(src: string): boolean {
    if (this.status !== "preparing") return false;
    const k = Registry.srcKeyOf(src);
    return this.targetKeys.has(k) || this.inFlightKeys.has(k);
  }

  /**
   * Returns true if there are other pending images in the active chapter prep run.
   * Used by VisionBatchCoordinator to determine if a companion image is forthcoming.
   */
  hasPendingCompanion(currentSrc?: string): boolean {
    if (this.status !== "preparing") return false;
    const currentKey = currentSrc ? Registry.srcKeyOf(currentSrc) : "";
    for (const k of this.targetKeys) {
      if (k !== currentKey) return true;
    }
    for (const k of this.inFlightKeys) {
      if (k !== currentKey) return true;
    }
    return false;
  }

  destroy(): void {
    this.stopHeartbeat();
    if (this.statusListener) {
      document.removeEventListener(
        "lmt:translation-status",
        this.statusListener,
      );
      this.statusListener = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      try {
        browser.runtime
          .sendMessage({ type: "CHAPTER_PREP_HEARTBEAT" })
          .catch(() => {});
      } catch {}
    }, 15000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private emitProgress(): void {
    const progress = this.getProgress();
    document.dispatchEvent(
      new CustomEvent("lmt:chapter-prep-progress", { detail: progress }),
    );
  }

  private updateProgressMessage(): void {
    if (this.status === "preparing") {
      const total = this.expectedCount || this.discovered;
      const done = this.completedKeys.size;
      const failed = this.failedKeys.size;
      const inFlight = this.inFlightKeys.size;
      this.message = `Preparing ${done}/${total} pages (${inFlight} active${failed > 0 ? `, ${failed} failed` : ""})…`;
    }
  }

  private async checkSettled(): Promise<void> {
    if (this.status !== "preparing") return;

    this.updateProgressMessage();
    this.emitProgress();

    // Settle only when all scheduled targets, in-flight operations, and durable writes finish
    if (
      this.targetKeys.size === 0 &&
      this.inFlightKeys.size === 0 &&
      this.savingKeys.size === 0
    ) {
      this.stopHeartbeat();
      this.endTime = Date.now();

      const expected = this.expectedCount;
      const discovered = this.discovered;
      const done = this.completedKeys.size;
      const failed = this.failedKeys.size;

      // M1.4.1 REPAIR A: Strict readiness check.
      // A chapter is ONLY ready if every expected page was discovered, completed, and verified without failures!
      const isCompleteDiscovery = expected > 0 && discovered === expected;
      const isAllVerified = done === expected && failed === 0;

      if (isCompleteDiscovery && isAllVerified) {
        this.status = "ready";
        this.message = `Ready! All ${done}/${expected} pages prepared and verified successfully.`;

        // Persist chapter manifest to IndexedDB
        await saveChapterRecord({
          id: this.chapterKey,
          seriesName: this.seriesName,
          chapterId: this.chapterId,
          chapterTitle: this.chapterTitle,
          url: typeof window !== "undefined" ? window.location.href : "",
          createdAt: this.startTime ?? Date.now(),
          updatedAt: this.endTime,
          expectedCount: this.expectedCount,
          discoveredCount: this.discovered,
          fetchedCount: this.fetchedCount,
          verifiedCount: this.completedKeys.size,
          status: "ready",
          exportStatus: this.exportStatus,
          exportedFilename: this.exportedFilename,
        }).catch((err) => {
          console.warn("LMT: Failed to persist chapter manifest:", err);
        });

        // Trigger automatic CBZ export & download
        await this.exportAndDownloadCbz();
      } else if (done > 0) {
        this.status = "partial";
        if (!isCompleteDiscovery) {
          this.message = `Partial: Incomplete discovery (${discovered}/${expected} pages found, ${done} prepared).`;
        } else {
          this.message = `Partial: ${done}/${expected} completed (${failed} failed).`;
        }
        if (this.shouldNotify) {
          this.sendNotification(
            "Chapter Partially Ready",
            `${done}/${expected} pages translated (${failed} failed).`,
          );
        }
      } else {
        this.status = "failed";
        this.message = `Failed: All ${failed} attempted pages failed.`;
      }

      this.emitProgress();
    }
  }

  /**
   * Packages all completed and verified pages into an ordered CBZ archive
   * and requests browser download with zero user prompts (saveAs: false).
   * M1.4.1 REPAIR C & D: Enforces exact page image count, validates binary signatures,
   * eliminates .txt placeholders, and awaits browser download completion.
   */
  async exportAndDownloadCbz(overrideChapterKey?: string): Promise<boolean> {
    try {
      if (overrideChapterKey) {
        this.chapterKey = overrideChapterKey;
      }
      if (!this.chapterKey) {
        try {
          const siteRule = await getSiteRule();
          this.seriesName = siteRule.seriesName || "MANGA";
          this.chapterId = siteRule.chapterId || "001";
          this.chapterKey = generateChapterKey(this.seriesName, this.chapterId);
          this.chapterTitle =
            siteRule.seriesName && siteRule.chapterId
              ? `${siteRule.seriesName} · Ch.${siteRule.chapterId}`
              : document.title;
        } catch {
          this.seriesName = "MANGA";
          this.chapterId = "001";
          this.chapterKey = generateChapterKey(this.seriesName, this.chapterId);
          this.chapterTitle = document.title;
        }
      }

      if (this.chapterKey) {
        const record = await getChapterRecord(this.chapterKey);
        if (record) {
          if (!this.expectedCount) this.expectedCount = record.expectedCount;
          if (record.seriesName) this.seriesName = record.seriesName;
          if (record.chapterId) this.chapterId = record.chapterId;
          if (record.chapterTitle) this.chapterTitle = record.chapterTitle;
        }
      }

      const targetLang =
        (await storage.getItem<string>("sync:target-lang")) ??
        DefaultConfig.targetLang;

      const filename = formatCbzFilename(
        this.seriesName,
        this.chapterId,
        targetLang,
      );

      // Collect rendered pages from durable offline store
      const storedPages = await getChapterPages(this.chapterKey);
      const entries: CbzFileEntry[] = [];
      const totalPages =
        this.expectedCount || storedPages.length || this.orderedImages.length;

      if (totalPages === 0) {
        throw new Error("CBZ Export Failed: Chapter has 0 pages");
      }

      for (let i = 0; i < totalPages; i++) {
        const pageNumber = i + 1;
        const stored = storedPages.find((p) => p.pageIndex === i);

        if (!stored || !stored.verified || !stored.renderedDataUrl) {
          // Strictly fail export if any expected page is missing or unverified
          throw new Error(
            `CBZ Export Failed: Page ${pageNumber} of ${totalPages} is missing or not durably verified`,
          );
        }

        const dataUrl = stored.renderedDataUrl;
        if (!dataUrl.startsWith("data:")) {
          throw new Error(
            `CBZ Export Failed: Page ${pageNumber} has invalid image data format`,
          );
        }

        const bytes = dataUrlToUint8Array(dataUrl);
        const sig = detectImageSignature(bytes);
        if (!sig) {
          // Reject corrupt or non-image data
          throw new Error(
            `CBZ Export Failed: Page ${pageNumber} contains corrupt or unrecognized image signature`,
          );
        }

        const pageFileName = `${String(pageNumber).padStart(3, "0")}.${sig.ext}`;
        entries.push({ name: pageFileName, data: bytes });
      }

      // Add manifest.json metadata inside CBZ
      const manifestPayload = {
        seriesName: this.seriesName,
        chapterId: this.chapterId,
        chapterTitle: this.chapterTitle,
        targetLanguage: targetLang,
        pageCount: entries.length,
        verifiedCount: this.completedKeys.size,
        exportedAt: new Date().toISOString(),
        generator: "Libre Manga Translator (LMT M1.4.1)",
      };
      const encoder = new TextEncoder();
      entries.push({
        name: "manifest.json",
        data: encoder.encode(JSON.stringify(manifestPayload, null, 2)),
      });

      this.downloadState = "archive_ready";
      this.emitProgress();

      const cbzArchiveBytes = createCbzBlob(entries);

      // Safe base64 conversion
      let cbzDataUrl = "";
      if (typeof FileReader !== "undefined") {
        cbzDataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(cbzArchiveBytes);
        });
      } else {
        const buffer = await cbzArchiveBytes.arrayBuffer();
        const b64 = Buffer.from(buffer).toString("base64");
        cbzDataUrl = `data:application/vnd.comicbook+zip;base64,${b64}`;
      }

      this.downloadState = "download_started";
      this.emitProgress();

      const resp = await browser.runtime.sendMessage({
        type: "DOWNLOAD_CHAPTER_CBZ",
        data: { dataUrl: cbzDataUrl, filename },
      });

      // M1.4.1 REPAIR D: Observe actual download completion before notifying
      if (resp?.success && resp?.downloadState === "download_completed") {
        this.downloadState = "download_completed";
        this.exportStatus = "exported";
        this.exportedFilename = filename;
        await markChapterExported(this.chapterKey, filename);
        console.log(`[LMT CBZ] Successfully downloaded and confirmed: ${filename}`);

        if (this.shouldNotify) {
          this.sendNotification(
            "Chapter Ready & Downloaded!",
            `All ${totalPages} pages of ${this.chapterTitle || "chapter"} prepared and exported to ${filename}.`,
          );
        }
        this.emitProgress();
        return true;
      } else {
        this.downloadState = "download_failed";
        const errMsg = resp?.error || "Browser download failed";
        console.warn("[LMT CBZ] Download failed:", errMsg);
        this.message = `Chapter ready, but download failed: ${errMsg}`;
        if (this.shouldNotify) {
          this.sendNotification("Chapter Download Failed", errMsg);
        }
        this.emitProgress();
        return false;
      }
    } catch (err: any) {
      this.downloadState = "download_failed";
      console.warn("LMT: Automatic CBZ download failed:", err?.message);
      this.message = `CBZ export error: ${err?.message}`;
      this.emitProgress();
    }
    return false;
  }

  /**
   * Re-exports an already prepared chapter directly from durable offline store
   * without triggering any Gemini inference API calls.
   */
  async reExportChapter(targetChapterKey?: string): Promise<boolean> {
    return this.exportAndDownloadCbz(targetChapterKey);
  }

  private sendNotification(title: string, message: string): void {
    try {
      browser.runtime
        .sendMessage({
          type: "SHOW_NOTIFICATION",
          data: { title, message },
        })
        .catch(() => {});
    } catch {}
  }

  async start(options?: { notify?: boolean }): Promise<ChapterPrepProgress> {
    this.shouldNotify = options?.notify ?? true;
    this.startTime = Date.now();
    this.endTime = undefined;
    this.downloadState = "not_started";
    this.completedKeys.clear();
    this.failedKeys.clear();
    this.inFlightKeys.clear();
    this.savingKeys.clear();
    this.targetKeys.clear();
    this.imageIndexMap.clear();

    const activeRule =
      this.orchestrator.getActiveRule() ?? (await resolveActiveSiteRule());

    try {
      const siteRule = await getSiteRule();
      this.seriesName = siteRule.seriesName || "MANGA";
      this.chapterId = siteRule.chapterId || "001";
      this.chapterKey = generateChapterKey(this.seriesName, this.chapterId);
      this.chapterTitle =
        siteRule.seriesName && siteRule.chapterId
          ? `${siteRule.seriesName} · Ch.${siteRule.chapterId}`
          : document.title;
    } catch {
      this.seriesName = "MANGA";
      this.chapterId = "001";
      this.chapterKey = generateChapterKey(this.seriesName, this.chapterId);
      this.chapterTitle = document.title;
    }

    // Action A: Discover all pages in document order, including virtualized readers
    const discovery = await discoverChapterImagesProgressive(activeRule);
    this.expectedCount = discovery.expectedCount;
    this.discovered = discovery.discoveredCount;
    const images = discovery.images;
    this.orderedImages = images;

    if (this.discovered === 0) {
      this.status = "failed";
      this.message = "No manga chapter images discovered on this page.";
      this.emitProgress();
      return this.getProgress();
    }

    // M1.4.1 REPAIR A: Incomplete discovery guard
    // If expected count is known and discovery is incomplete, report partial and never mark ready!
    if (this.expectedCount > 0 && this.discovered < this.expectedCount) {
      this.status = "partial";
      this.message = `Incomplete chapter discovery: found ${this.discovered} of ${this.expectedCount} pages. Chapter cannot be marked Ready.`;
      this.emitProgress();
      return this.getProgress();
    }

    this.status = "preparing";
    const pendingImages: MangaTargetElement[] = [];

    // Action B: Check durable offline store for completed pages across reload
    const storedPages = await getChapterPages(this.chapterKey);

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const src = getElementSrc(img);
      const k = Registry.srcKeyOf(src);
      this.imageIndexMap.set(k, i);

      const isStoredDone = storedPages.some(
        (p) =>
          (p.src === src || p.src === k) &&
          p.status === "done" &&
          p.verified,
      );

      if (Registry.getStatus(k) === "done" || isStoredDone) {
        this.completedKeys.add(k);
        this.verifiedCount++;
      } else {
        this.targetKeys.add(k);
        pendingImages.push(img);
      }
    }

    if (this.targetKeys.size === 0) {
      this.status = "ready";
      this.message = `Ready! All ${this.discovered} pages already translated from cache.`;
      this.endTime = Date.now();
      await saveChapterRecord({
        id: this.chapterKey,
        seriesName: this.seriesName,
        chapterId: this.chapterId,
        chapterTitle: this.chapterTitle,
        url: typeof window !== "undefined" ? window.location.href : "",
        createdAt: this.startTime ?? Date.now(),
        updatedAt: this.endTime,
        expectedCount: this.expectedCount,
        discoveredCount: this.discovered,
        fetchedCount: this.fetchedCount,
        verifiedCount: this.completedKeys.size,
        status: "ready",
        exportStatus: this.exportStatus,
        exportedFilename: this.exportedFilename,
      }).catch((err) => {
        console.warn("LMT: Failed to persist chapter manifest:", err);
      });
      await this.exportAndDownloadCbz();
      this.emitProgress();
      return this.getProgress();
    }

    this.startHeartbeat();
    this.updateProgressMessage();
    this.emitProgress();

    // Enqueue remaining images into the unified queue in document order
    for (const img of pendingImages) {
      this.orchestrator.enqueueManual(img);
    }

    return this.getProgress();
  }

  stop(): ChapterPrepProgress {
    this.stopHeartbeat();
    this.endTime = Date.now();
    this.targetKeys.clear();
    this.inFlightKeys.clear();
    this.savingKeys.clear();

    if (this.status === "preparing") {
      this.status = this.completedKeys.size > 0 ? "partial" : "idle";
      this.message = `Preparation stopped. ${this.completedKeys.size}/${this.expectedCount || this.discovered} pages completed.`;
      this.emitProgress();
    }

    return this.getProgress();
  }

  getProgress(): ChapterPrepProgress {
    const elapsedSeconds = this.startTime
      ? Math.round(
          ((this.endTime ?? Date.now()) - this.startTime) / 1000,
        )
      : undefined;

    return {
      status: this.status,
      downloadState: this.downloadState,
      expectedCount: this.expectedCount,
      discovered: this.discovered,
      discoveredCount: this.discovered,
      fetchedCount: this.fetchedCount,
      completed: this.completedKeys.size,
      verifiedCount: this.verifiedCount,
      failed: this.failedKeys.size,
      inFlight: this.inFlightKeys.size,
      chapterTitle: this.chapterTitle,
      message: this.message,
      startTime: this.startTime,
      endTime: this.endTime,
      elapsedSeconds,
      exportStatus: this.exportStatus,
      exportedFilename: this.exportedFilename,
    };
  }
}
