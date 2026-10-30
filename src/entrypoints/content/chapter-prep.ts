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

export interface ChapterPrepProgress {
  status: ChapterPrepStatus;
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
 */
export function isCandidateMangaImage(
  img: MangaTargetElement,
  activeRule: SiteRule | null,
): boolean {
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
  if (img instanceof HTMLImageElement) {
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
 * Discovers all chapter manga page images in document order without
 * requiring IntersectionObserver viewport intersection.
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
      const pos = a.compareDocumentPosition(b);
      if (pos & FOLLOWING) return -1;
      if (pos & PRECEDING) return 1;
      return 0;
    });
  }

  return validImages;
}

/**
 * Progressively triggers discovery on virtualized/lazy-scrolling readers until
 * all expected pages are mounted into the DOM.
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
  const expectedCount =
    options?.expectedCount ??
    extractExpectedPageCount(document, activeRule) ??
    findChapterImages(activeRule).length;

  let images = findChapterImages(activeRule);

  // If we already discovered all expected pages (or no expected count known), return immediately
  if (images.length >= expectedCount || expectedCount === 0) {
    return {
      images,
      expectedCount: Math.max(expectedCount, images.length),
      discoveredCount: images.length,
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
    } else if (typeof window !== "undefined") {
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

    images = findChapterImages(activeRule);
    if (images.length >= expectedCount) {
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
  } else if (typeof window !== "undefined") {
    window.scrollTo(0, originalScrollTop);
  }

  return {
    images,
    expectedCount: Math.max(expectedCount, images.length),
    discoveredCount: images.length,
  };
}

/**
 * Manages full chapter preparation in document order, tracking truthful
 * completed / discovered / failed counters and background-tab keep-alives.
 */
export class ChapterPreparationManager {
  private orchestrator: AutoTranslateOrchestrator;
  private status: ChapterPrepStatus = "idle";
  private expectedCount = 0;
  private discovered = 0;
  private fetchedCount = 0;
  private verifiedCount = 0;
  private completedKeys = new Set<string>();
  private failedKeys = new Set<string>();
  private inFlightKeys = new Set<string>();
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
          this.inFlightKeys.delete(k);
          this.completedKeys.add(k);
          this.verifiedCount++;
          this.failedKeys.delete(k);
          this.targetKeys.delete(k);

          // Save page to durable offline store
          const pageIdx = this.imageIndexMap.get(k) ?? (this.completedKeys.size - 1);
          const rendered = Registry.getRenderedResult(detail.src);
          savePageRecord({
            id: `${this.chapterKey}__page_${pageIdx}`,
            chapterKey: this.chapterKey,
            pageIndex: pageIdx,
            pageNumber: pageIdx + 1,
            src: detail.src,
            mimeType: "image/png",
            renderedDataUrl: rendered?.renderedUrl,
            translations: rendered?.translations ?? [],
            sourceTexts: rendered?.sourceTexts,
            verified: true,
            status: "done",
            updatedAt: Date.now(),
          }).catch((err) => {
            console.warn("LMT: Failed to persist page to offline store:", err);
          });

          this.checkSettled();
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
      const total = this.discovered;
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

    if (this.targetKeys.size === 0) {
      this.stopHeartbeat();
      this.endTime = Date.now();

      const total = this.discovered;
      const done = this.completedKeys.size;
      const failed = this.failedKeys.size;

      if (done === total && total > 0) {
        this.status = "ready";
        this.message = `Ready! All ${done}/${total} pages prepared successfully.`;

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

        // Trigger automatic CBZ export & download with zero confirmation prompts
        await this.exportAndDownloadCbz();

        if (this.shouldNotify) {
          this.sendNotification(
            "Chapter Ready & Downloaded!",
            `All ${done} pages of ${this.chapterTitle || "chapter"} prepared and exported to CBZ.`,
          );
        }
      } else if (done > 0) {
        this.status = "partial";
        this.message = `Partial: ${done}/${total} completed, ${failed} failed.`;
        if (this.shouldNotify) {
          this.sendNotification(
            "Chapter Partially Ready",
            `${done}/${total} pages translated (${failed} failed).`,
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
   */
  async exportAndDownloadCbz(): Promise<boolean> {
    try {
      const targetLang =
        (await storage.getItem<string>("sync:target-lang")) ??
        DefaultConfig.targetLang;

      const filename = formatCbzFilename(
        this.seriesName,
        this.chapterId,
        targetLang,
      );

      // Collect rendered pages from offline store or registry
      const storedPages = await getChapterPages(this.chapterKey);
      const entries: CbzFileEntry[] = [];

      for (let i = 0; i < this.orderedImages.length; i++) {
        const img = this.orderedImages[i];
        const src = getElementSrc(img);
        const k = Registry.srcKeyOf(src);
        const pageNumber = i + 1;
        const pageFileName = `${String(pageNumber).padStart(3, "0")}.png`;

        let dataUrl = "";
        const stored = storedPages.find((p) => p.pageIndex === i);
        if (stored?.renderedDataUrl) {
          dataUrl = stored.renderedDataUrl;
        } else {
          const liveResult = Registry.getRenderedResult(src);
          dataUrl = liveResult?.renderedUrl || "";
        }

        if (dataUrl && dataUrl.startsWith("data:")) {
          const bytes = dataUrlToUint8Array(dataUrl);
          entries.push({ name: pageFileName, data: bytes });
        } else {
          // Fallback: create placeholder text file for art spreads without text
          const encoder = new TextEncoder();
          entries.push({
            name: `${String(pageNumber).padStart(3, "0")}.txt`,
            data: encoder.encode(`Page ${pageNumber} original: ${src}`),
          });
        }
      }

      // Add manifest.json inside CBZ
      const manifestPayload = {
        seriesName: this.seriesName,
        chapterId: this.chapterId,
        chapterTitle: this.chapterTitle,
        targetLanguage: targetLang,
        pageCount: this.orderedImages.length,
        verifiedCount: this.completedKeys.size,
        exportedAt: new Date().toISOString(),
        generator: "Libre Manga Translator (LMT M1.4)",
      };
      const encoder = new TextEncoder();
      entries.push({
        name: "manifest.json",
        data: encoder.encode(JSON.stringify(manifestPayload, null, 2)),
      });

      const cbzBlob = createCbzBlob(entries);

      // Convert Blob to Data URL for Chrome download API
      let cbzDataUrl = "";
      if (typeof FileReader !== "undefined") {
        cbzDataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(cbzBlob);
        });
      } else {
        const buffer = await cbzBlob.arrayBuffer();
        const b64 = Buffer.from(buffer).toString("base64");
        cbzDataUrl = `data:application/vnd.comicbook+zip;base64,${b64}`;
      }

      const resp = await browser.runtime.sendMessage({
        type: "DOWNLOAD_CHAPTER_CBZ",
        data: { dataUrl: cbzDataUrl, filename },
      });

      if (resp?.success) {
        this.exportStatus = "exported";
        this.exportedFilename = filename;
        await markChapterExported(this.chapterKey, filename);
        console.log(`[LMT CBZ] Successfully downloaded ${filename}`);
        return true;
      }
    } catch (err: any) {
      console.warn("LMT: Automatic CBZ download failed:", err?.message);
    }
    return false;
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
    this.completedKeys.clear();
    this.failedKeys.clear();
    this.inFlightKeys.clear();
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

    if (this.status === "preparing") {
      this.status = this.completedKeys.size > 0 ? "partial" : "idle";
      this.message = `Preparation stopped. ${this.completedKeys.size}/${this.discovered} pages completed.`;
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
      expectedCount: this.expectedCount,
      discovered: this.discovered,
      discoveredCount: this.discovered,
      fetchedCount: this.fetchedCount,
      completed: this.completedKeys.size,
      verifiedCount: this.completedKeys.size,
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
