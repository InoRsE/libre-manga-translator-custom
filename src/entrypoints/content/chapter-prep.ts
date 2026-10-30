import type { SiteRule } from "@/lib/adapters";
import { resolveActiveSiteRule, getSiteRule } from "@/lib/adapters";
import type { MangaTargetElement } from "@/lib/canvas";
import { getElementSrc } from "@/lib/canvas";
import * as Registry from "./translation-registry";
import type { AutoTranslateOrchestrator } from "./auto-translate";

export type ChapterPrepStatus =
  | "idle"
  | "preparing"
  | "ready"
  | "partial"
  | "failed";

export interface ChapterPrepProgress {
  status: ChapterPrepStatus;
  discovered: number;
  completed: number;
  failed: number;
  inFlight: number;
  chapterTitle: string;
  message: string;
  startTime?: number;
  endTime?: number;
  elapsedSeconds?: number;
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

  return validImages;
}

/**
 * Manages full chapter preparation in document order, tracking truthful
 * completed / discovered / failed counters and background-tab keep-alives.
 */
export class ChapterPreparationManager {
  private orchestrator: AutoTranslateOrchestrator;
  private status: ChapterPrepStatus = "idle";
  private discovered = 0;
  private completedKeys = new Set<string>();
  private failedKeys = new Set<string>();
  private inFlightKeys = new Set<string>();
  private targetKeys = new Set<string>();
  private chapterTitle = "";
  private message = "Ready to prepare chapter.";
  private startTime?: number;
  private endTime?: number;
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
          this.updateProgressMessage();
          this.emitProgress();
        }
        return;
      }

      if (detail.status === "done") {
        if (this.targetKeys.has(k)) {
          this.inFlightKeys.delete(k);
          this.completedKeys.add(k);
          this.failedKeys.delete(k);
          this.targetKeys.delete(k);
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

  private checkSettled(): void {
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
        if (this.shouldNotify) {
          this.sendNotification(
            "Chapter Ready!",
            `All ${done} pages of ${this.chapterTitle || "chapter"} are translated and ready to read.`,
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

    const activeRule =
      this.orchestrator.getActiveRule() ?? (await resolveActiveSiteRule());
    try {
      const siteRule = await getSiteRule();
      this.chapterTitle =
        siteRule.seriesName && siteRule.chapterId
          ? `${siteRule.seriesName} · Ch.${siteRule.chapterId}`
          : document.title;
    } catch {
      this.chapterTitle = document.title;
    }

    const images = findChapterImages(activeRule);
    this.discovered = images.length;

    if (this.discovered === 0) {
      this.status = "failed";
      this.message = "No manga chapter images discovered on this page.";
      this.emitProgress();
      return this.getProgress();
    }

    this.status = "preparing";
    const pendingImages: MangaTargetElement[] = [];

    // Preload image headers and identify already completed pages
    for (const img of images) {
      const src = getElementSrc(img);
      const k = Registry.srcKeyOf(src);
      if (Registry.getStatus(k) === "done") {
        this.completedKeys.add(k);
      } else {
        this.targetKeys.add(k);
        pendingImages.push(img);
      }
    }

    if (this.targetKeys.size === 0) {
      this.status = "ready";
      this.message = `Ready! All ${this.discovered} pages already translated from cache.`;
      this.endTime = Date.now();
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
      discovered: this.discovered,
      completed: this.completedKeys.size,
      failed: this.failedKeys.size,
      inFlight: this.inFlightKeys.size,
      chapterTitle: this.chapterTitle,
      message: this.message,
      startTime: this.startTime,
      endTime: this.endTime,
      elapsedSeconds,
    };
  }
}
