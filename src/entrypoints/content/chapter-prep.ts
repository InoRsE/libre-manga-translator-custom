import type { SiteRule } from "@/lib/adapters";
import { resolveActiveSiteRule, getSiteRule } from "@/lib/adapters";
import type { MangaTargetElement } from "@/lib/canvas";
import { getElementSrc } from "@/lib/canvas";
import * as Registry from "./translation-registry";
import {
  type AutoTranslateOrchestrator,
  findMountedImage,
} from "./auto-translate";
import { resolveImagePageIndex } from "./utils";
import {
  saveChapterRecord,
  getChapterRecord,
  savePageRecord,
  getPageRecord,
  getChapterPages,
  markChapterExported,
  generateChapterKey,
  generatePageKey,
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

export type CollectorVerdict =
  | "COLLECTOR_LIVE_VERIFIED"
  | "READY_FOR_OWNER_RETEST"
  | "READY_FOR_OWNER_BROWSER_ACCEPTANCE"
  | "PARTIAL_WITH_VERIFIED_BLOCKERS"
  | "COLLECTOR_PARTIAL_WITH_BLOCKERS"
  | "BLOCKED"
  | "BLOCKED_ARCHITECTURE"
  | "ELIGIBLE_FOR_PROCESSING"
  | "INCOMPLETE_DISCOVERY"
  | "UNKNOWN_EXPECTED_COUNT"
  | "DETACHED_ASSETS";

export interface ChapterPageItem {
  pageNumber: number; // 1-based (1, 2, ... 22)
  pageIndex: number;  // 0-based
  src: string;
  srcKey: string;
  element?: MangaTargetElement;
  isMounted: boolean;
  isUsableAsset: boolean;
  isAcquired?: boolean;
  width?: number;
  height?: number;
  byteLength?: number;
  hash?: string;
}

export interface ChapterDiagnosticResult {
  seriesName: string;
  chapterId: string;
  chapterInternalId?: string;
  chapterTitle: string;
  url: string;
  strategy?: string;
  expectedCount: number; // 0 if unknown
  discoveredCount: number;
  mountedCount?: number;
  acquiredCount?: number;
  persistedCount?: number;
  usableAssetCount: number;
  missingPageNumbers: number[];
  pages: Array<{
    pageNumber: number;
    pageIndex: number;
    src: string;
    isMounted: boolean;
    isAcquired?: boolean;
    isUsableAsset: boolean;
    hasCachedTranslation: boolean;
    fetchStatus?: number | string;
    error?: string;
    width?: number;
    height?: number;
    byteLength?: number;
    hash?: string;
  }>;
  verdict: CollectorVerdict;
  message: string;
  timestamp?: number;
}

export interface ChapterPrepProgress {
  status: ChapterPrepStatus;
  downloadState?: ChapterDownloadState;
  expectedCount?: number;
  discovered: number;
  discoveredCount?: number;
  usableAssetCount?: number;
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
 * Reads captured chapter pages intercepted at document_start in the MAIN world
 * from Comix.to / Next.js encrypted chapter payload decoders.
 */
export function getCapturedPagesFromBridge(doc: Document = document): Array<{
  pageNumber: number;
  pageIndex: number;
  src: string;
  width?: number;
  height?: number;
}> {
  try {
    const raw = doc.documentElement?.getAttribute("data-lmt-captured-pages");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((item, idx) => ({
          pageNumber: item.pageNumber ?? (item.index !== undefined ? item.index + 1 : idx + 1),
          pageIndex: item.index ?? (item.pageNumber ? item.pageNumber - 1 : idx),
          src: item.src || item.url,
          width: item.width,
          height: item.height,
        }));
      }
    }
  } catch {}

  if (typeof window !== "undefined") {
    const winPages = (window as any).__lmt_captured_pages;
    if (Array.isArray(winPages) && winPages.length > 0) {
      return winPages.map((item, idx) => ({
        pageNumber: item.pageNumber ?? (item.index !== undefined ? item.index + 1 : idx + 1),
        pageIndex: item.index ?? (item.pageNumber ? item.pageNumber - 1 : idx),
        src: item.src || item.url,
        width: item.width,
        height: item.height,
      }));
    }
  }

  return [];
}

/**
 * Ensures native reader preloading is activated on Comix.to / Comix.ws.
 * Comix stores user reader preferences in localStorage under 'reader.default.v3'
 * and 'reader.webtoon.v3'. Setting preload to 'all' instructs the React reader
 * to mount and preload all chapter page images eagerly.
 */
export function applyComixNativePreload(): boolean {
  try {
    if (typeof window === "undefined" || !window.localStorage) return false;
    let modified = false;
    for (const key of ["reader.default.v3", "reader.webtoon.v3"]) {
      const item = window.localStorage.getItem(key);
      if (item) {
        try {
          const parsed = JSON.parse(item);
          if (parsed && typeof parsed === "object" && parsed.preload !== "all") {
            parsed.preload = "all";
            window.localStorage.setItem(key, JSON.stringify(parsed));
            modified = true;
          }
        } catch {}
      } else {
        window.localStorage.setItem(key, JSON.stringify({ preload: "all" }));
        modified = true;
      }
    }
    return modified;
  } catch {
    return false;
  }
}

/**
 * Extracts clean chapter identity (series title, clean chapter number, internal ID, display title)
 * strictly distinguishing user-visible chapter "54" from internal API ID "3196390".
 */
export function extractChapterIdentity(doc: Document = document): {
  seriesName: string;
  chapterId: string;
  chapterInternalId?: string;
  chapterTitle: string;
} {
  let seriesName = "MANGA";
  let chapterId = "001";
  let chapterInternalId: string | undefined = undefined;

  // 1. Inspect Comix.to / Next.js #initial-data JSON
  try {
    const initEl = doc.getElementById("initial-data");
    if (initEl?.textContent) {
      const parsed = JSON.parse(initEl.textContent);
      if (parsed.read && typeof parsed.read === "object") {
        if (parsed.read.chapterNumber !== undefined && parsed.read.chapterNumber !== null) {
          chapterId = String(parsed.read.chapterNumber);
        }
        if (parsed.read.chapterId) {
          chapterInternalId = String(parsed.read.chapterId);
        }
        if (parsed.read.mangaTitle || parsed.read.title) {
          seriesName = parsed.read.mangaTitle || parsed.read.title;
        }
      }
      if (chapterId === "001" && parsed.chapterNumber !== undefined && parsed.chapterNumber !== null) {
        chapterId = String(parsed.chapterNumber);
      }
      if (!chapterInternalId && parsed.chapterId) {
        chapterInternalId = String(parsed.chapterId);
      }
      if (seriesName === "MANGA" && (parsed.title || parsed.mangaTitle || parsed.seriesTitle)) {
        seriesName = parsed.title || parsed.mangaTitle || parsed.seriesTitle;
      }
      if (seriesName === "MANGA" && parsed.queries && typeof parsed.queries === "object") {
        for (const k of Object.keys(parsed.queries)) {
          const q = parsed.queries[k];
          if (q?.title) {
            seriesName = q.title;
            break;
          }
        }
      }
    }
  } catch {}

  // 2. Fall back to title regex: e.g. "Zipang · Ch.54" or "Zipang - Chapter 54"
  const titleText = doc.title || "";
  const titleMatch = titleText.match(/^(.*?)\s*(?:·|-|–|—)\s*Ch(?:apter)?\.?\s*([\d.]+)/i);
  if (titleMatch) {
    if (seriesName === "MANGA" && titleMatch[1]?.trim()) {
      seriesName = titleMatch[1].trim();
    }
    if (chapterId === "001" && titleMatch[2]?.trim()) {
      chapterId = titleMatch[2].trim();
    }
  }

  // 3. Fall back to URL pattern: e.g. /title/gqwx-zipang/3196390-chapter-54
  if (typeof location !== "undefined" && (seriesName === "MANGA" || chapterId === "001")) {
    const pathname = location.pathname;
    const chMatch = pathname.match(/(?:-chapter-|·\s*Ch\.)([\d.]+)/i);
    if (chapterId === "001" && chMatch?.[1]) {
      chapterId = chMatch[1];
    }
    const seriesMatch = pathname.match(/\/title\/[a-z0-9]+-([^\/]+)/i);
    if (seriesName === "MANGA" && seriesMatch?.[1]) {
      seriesName = seriesMatch[1]
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
    const idMatch = pathname.match(/\/(\d+)-chapter-/i);
    if (!chapterInternalId && idMatch?.[1]) {
      chapterInternalId = idMatch[1];
    }
  }

  const chapterTitle = `${seriesName} · Ch.${chapterId}`;
  return { seriesName, chapterId, chapterInternalId, chapterTitle };
}

/**
 * Specialized slot-based discovery for Comix.to / Comix.ws and modern readers
 * that maintain explicit page slot containers (e.g. .rpage-page[data-page]).
 * Iterates expected page slots, extracts child images, and performs bounded
 * container scrolling on .rpage-main if virtualized slots need mounting.
 */
export async function discoverSlotBasedPages(
  doc: Document = document,
  activeRule?: SiteRule | null,
  options?: {
    expectedCount?: number;
    maxScrollAttempts?: number;
    scrollDelayMs?: number;
  },
): Promise<ChapterPageItem[] | null> {
  const slotElements = Array.from(
    doc.querySelectorAll<HTMLElement>(".rpage-page[data-page], .rpage-page"),
  );
  if (slotElements.length === 0) {
    return null; // Not a Comix-style slot-based reader
  }

  // Determine total slot count
  const targetCount = options?.expectedCount || slotElements.length;

  // Find scroll container (.rpage-main)
  const container =
    doc.querySelector<HTMLElement>(".rpage-main") ||
    (activeRule?.containerSelector
      ? doc.querySelector<HTMLElement>(activeRule.containerSelector)
      : null);

  const maxAttempts = options?.maxScrollAttempts ?? 15;
  const delayMs = options?.scrollDelayMs ?? 40;

  // Helper to extract page items from current DOM slots
  const extractItems = (): Map<
    number,
    { el?: MangaTargetElement; src: string; isMounted: boolean; width?: number; height?: number }
  > => {
    const map = new Map<
      number,
      { el?: MangaTargetElement; src: string; isMounted: boolean; width?: number; height?: number }
    >();
    const currentSlots = doc.querySelectorAll<HTMLElement>(".rpage-page[data-page], .rpage-page");

    currentSlots.forEach((slot, index) => {
      const dataPage = slot.getAttribute("data-page");
      const pageNum = dataPage ? parseInt(dataPage, 10) : index + 1;
      if (isNaN(pageNum) || pageNum <= 0) return;

      const img = slot.querySelector<MangaTargetElement>("img.rpage-page__img, img, canvas");
      if (img) {
        if (img instanceof HTMLImageElement) {
          normalizeImageSrc(img);
        }
        const src = getElementSrc(img) || (img instanceof HTMLImageElement ? img.src : "");
        if (src && !src.startsWith("data:image/svg") && !src.includes("placeholder")) {
          const isMounted = doc.body?.contains(img) === true;
          const w = "naturalWidth" in img ? img.naturalWidth : img.width;
          const h = "naturalHeight" in img ? img.naturalHeight : img.height;
          map.set(pageNum, {
            el: isMounted ? img : undefined,
            src,
            isMounted,
            width: w > 0 ? w : undefined,
            height: h > 0 ? h : undefined,
          });
        }
      }
    });
    return map;
  };

  let pageMap = extractItems();

  // If some slots are unmounted and container exists, perform bounded scroll
  if (container && pageMap.size < targetCount) {
    const originalScrollTop = container.scrollTop;
    const scrollStep = Math.max(600, Math.floor(container.clientHeight * 0.75));

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (pageMap.size >= targetCount) break;

      container.scrollTop += scrollStep;
      try {
        container.dispatchEvent(new Event("scroll", { bubbles: true }));
      } catch {}

      await new Promise((r) => setTimeout(r, delayMs));

      const updated = extractItems();
      for (const [pNum, info] of updated.entries()) {
        if (!pageMap.has(pNum) || !pageMap.get(pNum)?.src) {
          pageMap.set(pNum, info);
        }
      }

      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 20) {
        break;
      }
    }

    // Restore scroll position
    container.scrollTop = originalScrollTop;
  }

  if (pageMap.size === 0) {
    return null;
  }

  // Convert to ordered ChapterPageItem array 1..N
  const sortedPageNums = Array.from(pageMap.keys()).sort((a, b) => a - b);
  const items: ChapterPageItem[] = sortedPageNums.map((pNum) => {
    const info = pageMap.get(pNum)!;
    const isUsable =
      info.isMounted && ((info.width ?? 0) > 0 || (info.height ?? 0) > 0 || !!info.src);
    return {
      pageNumber: pNum,
      pageIndex: pNum - 1,
      src: info.src,
      srcKey: Registry.srcKeyOf(info.src),
      element: info.el,
      isMounted: info.isMounted,
      isUsableAsset: isUsable,
      width: info.width,
      height: info.height,
    };
  });

  return items;
}

/**
 * Acquires a chapter page's binary asset independently of DOM mounting or virtualization,
 * verifies its dimensions and SHA-256 hash, and durably persists it in IndexedDB.
 */
export async function acquirePageAsset(
  page: ChapterPageItem,
  chapterKey: string,
  referer?: string,
): Promise<{
  success: boolean;
  byteLength?: number;
  width?: number;
  height?: number;
  hash?: string;
  fetchStatus?: number | string;
  error?: string;
}> {
  // 1. Check if already persisted with valid image data in IndexedDB
  try {
    const existing = await getPageRecord(chapterKey, page.pageIndex);
    if (existing?.originalDataUrl || existing?.renderedDataUrl) {
      page.isAcquired = true;
      page.isUsableAsset = true;
      page.width = existing.width;
      page.height = existing.height;
      page.byteLength = existing.byteLength;
      page.hash = existing.hash;
      return {
        success: true,
        byteLength: existing.byteLength,
        width: existing.width,
        height: existing.height,
        hash: existing.hash,
        fetchStatus: "cached",
      };
    }
  } catch {}

  // 2. Fast-path: Direct Canvas extraction if image is already mounted and complete
  if (
    typeof document !== "undefined" &&
    page.element instanceof HTMLImageElement &&
    page.element.complete &&
    page.element.naturalWidth > 0 &&
    page.element.naturalHeight > 0
  ) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = page.element.naturalWidth;
      canvas.height = page.element.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(page.element, 0, 0);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.95);
        if (dataUrl && dataUrl.startsWith("data:image/jpeg;base64,")) {
          const bytes = dataUrlToUint8Array(dataUrl);
          const hashBuffer = await crypto.subtle.digest("SHA-256", bytes as any);
          const hashArray = Array.from(new Uint8Array(hashBuffer));
          const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

          await savePageRecord({
            id: generatePageKey(chapterKey, page.pageIndex),
            chapterKey,
            pageIndex: page.pageIndex,
            pageNumber: page.pageNumber,
            src: page.src,
            mimeType: "image/jpeg",
            originalDataUrl: dataUrl,
            width: canvas.width,
            height: canvas.height,
            hash: hashHex,
            byteLength: bytes.length,
            translations: [],
            verified: false,
            status: "acquired",
            updatedAt: Date.now(),
          });

          page.isAcquired = true;
          page.isUsableAsset = true;
          page.width = canvas.width;
          page.height = canvas.height;
          page.byteLength = bytes.length;
          page.hash = hashHex;

          return {
            success: true,
            byteLength: bytes.length,
            width: canvas.width,
            height: canvas.height,
            hash: hashHex,
            fetchStatus: "dom_canvas",
          };
        }
      }
    } catch {
      // Canvas tainted (CORS) or drawing error; continue to background fetch
    }
  }

  // 3. Fetch via background proxy
  try {
    if (typeof browser === "undefined" || !browser.runtime?.sendMessage) {
      return { success: false, error: "Browser runtime messaging unavailable" };
    }

    const isComix =
      (typeof window !== "undefined" &&
        (window.location.hostname.includes("comix.to") ||
          window.location.hostname.includes("comix.ws"))) ||
      page.src.includes(".rxn.") ||
      page.src.includes("comix.to") ||
      page.src.includes("comix.ws");

    const ref = referer || (typeof window !== "undefined" ? window.location.href : "https://comix.to/");
    const res = await browser.runtime.sendMessage({
      type: "FETCH_CHAPTER_PAGE_IMAGE",
      data: {
        url: page.src,
        referer: isComix ? "" : ref,
        noReferer: isComix,
      },
    });

    if (!res?.success || !res?.dataUrl) {
      return {
        success: false,
        fetchStatus: res?.httpStatus || 400,
        error: res?.error || `Background fetch failed (status: ${res?.httpStatus ?? "unknown"})`,
      };
    }

    await savePageRecord({
      id: generatePageKey(chapterKey, page.pageIndex),
      chapterKey,
      pageIndex: page.pageIndex,
      pageNumber: page.pageNumber,
      src: page.src,
      mimeType: res.mimeType || "image/jpeg",
      originalDataUrl: res.dataUrl,
      width: res.width,
      height: res.height,
      hash: res.hash,
      byteLength: res.byteLength,
      translations: [],
      verified: false,
      status: "acquired",
      updatedAt: Date.now(),
    });

    page.isAcquired = true;
    page.isUsableAsset = true;
    page.width = res.width;
    page.height = res.height;
    page.byteLength = res.byteLength;
    page.hash = res.hash;

    return {
      success: true,
      byteLength: res.byteLength,
      width: res.width,
      height: res.height,
      hash: res.hash,
      fetchStatus: res.httpStatus || 200,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || String(err),
    };
  }
}

/**
 * Concurrently acquires binary assets for an entire chapter's page list.
 */
export async function acquireChapterAssets(
  pages: ChapterPageItem[],
  chapterKey: string,
  concurrency = 3,
  onProgress?: (acquired: number, total: number) => void,
): Promise<{
  total: number;
  acquired: number;
  failed: number;
  results: Array<{
    pageNumber: number;
    success: boolean;
    byteLength?: number;
    error?: string;
  }>;
}> {
  const results: Array<{
    pageNumber: number;
    success: boolean;
    byteLength?: number;
    error?: string;
  }> = [];
  let acquiredCount = 0;
  let failedCount = 0;

  const queue = [...pages];
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, queue.length)) },
    async () => {
      while (queue.length > 0) {
        const page = queue.shift();
        if (!page) break;
        const res = await acquirePageAsset(page, chapterKey);
        if (res.success) {
          acquiredCount++;
          results.push({
            pageNumber: page.pageNumber,
            success: true,
            byteLength: res.byteLength,
          });
        } else {
          failedCount++;
          results.push({
            pageNumber: page.pageNumber,
            success: false,
            error: res.error,
          });
        }
        onProgress?.(acquiredCount, pages.length);
      }
    },
  );

  await Promise.all(workers);
  return {
    total: pages.length,
    acquired: acquiredCount,
    failed: failedCount,
    results,
  };
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
  // 0. Captured pages from bridge (M1.4.3)
  const captured = getCapturedPagesFromBridge(doc);
  if (captured.length > 0) {
    return captured.length;
  }

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

  // 1b. Reader initial-data script (Comix.to Next.js / TanStack format)
  const initialDataEl = doc.getElementById("initial-data");
  if (initialDataEl?.textContent) {
    try {
      const data = JSON.parse(initialDataEl.textContent);
      if (data.read && typeof data.read === "object") {
        if (typeof data.read.totalPages === "number" && data.read.totalPages > 0) return data.read.totalPages;
        if (typeof data.read.total_pages === "number" && data.read.total_pages > 0) return data.read.total_pages;
        if (typeof data.read.pageCount === "number" && data.read.pageCount > 0) return data.read.pageCount;
      }
      if (Array.isArray(data.pages) && data.pages.length > 0) return data.pages.length;
      if (Array.isArray(data.images) && data.images.length > 0) return data.images.length;
      if (typeof data.totalPages === "number" && data.totalPages > 0) return data.totalPages;
      if (typeof data.total_pages === "number" && data.total_pages > 0) return data.total_pages;
      if (typeof data.pageCount === "number" && data.pageCount > 0) return data.pageCount;
    } catch {}
  }

  // 1c. Comix.to / modern reader page slot containers
  const comixSlots = doc.querySelectorAll(".rpage-page[data-page], .rpage-page");
  if (comixSlots.length > 1) {
    return comixSlots.length;
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
 *
 * M1.4.2 REPAIR 3: Strictly distinguishes expectedCount, discoveredCount, and usableAssetCount.
 * Does NOT infer expectedCount from discoveredCount when expected count is unknown.
 * Determines deterministic page order by resolving page numbers from URLs/attributes.
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
  pages: ChapterPageItem[];
  expectedCount: number;
  discoveredCount: number;
  usableAssetCount: number;
  strategy?: "native_preload" | "slot_discovery" | "bridge_intercept" | "dom_scroll";
}> {
  // Ensure native preload settings are applied if running on Comix.to / Comix.ws
  applyComixNativePreload();

  const doc = typeof document !== "undefined" ? document : undefined;
  const capturedBridgePages = doc ? getCapturedPagesFromBridge(doc) : [];

  let detectedExpected =
    options?.expectedCount ?? (doc ? extractExpectedPageCount(doc, activeRule) : undefined);

  if ((!detectedExpected || detectedExpected <= 0) && capturedBridgePages.length > 0) {
    detectedExpected = capturedBridgePages.length;
  }

  // M1.4.2 REPAIR 3: Never infer expectedCount from discoveredCount when unknown.
  // If metadata doesn't specify expected page count, expectedCount remains 0 (unknown).
  const expectedCount =
    detectedExpected && detectedExpected > 0 ? detectedExpected : 0;

  // Case A: Bridge captured page descriptors directly from reader decoders (M1.4.3)
  if (capturedBridgePages.length > 0) {
    capturedBridgePages.sort((a, b) => a.pageNumber - b.pageNumber);

    const pages: ChapterPageItem[] = capturedBridgePages.map((item) => {
      let mountedImg: MangaTargetElement | undefined = undefined;
      if (doc) {
        const pageContainer = doc.querySelector(`[data-page="${item.pageNumber}"]`);
        if (pageContainer) {
          const imgInside = pageContainer.querySelector<MangaTargetElement>("img, canvas");
          if (imgInside && isCandidateMangaImage(imgInside, activeRule)) {
            mountedImg = imgInside;
          }
        }
        if (!mountedImg) {
          mountedImg = findMountedImage(item.src) ?? undefined;
        }
      }

      const isMounted = mountedImg !== undefined && doc?.body?.contains(mountedImg) === true;
      const naturalW = mountedImg
        ? "naturalWidth" in mountedImg
          ? mountedImg.naturalWidth
          : mountedImg.width
        : item.width ?? 0;
      const naturalH = mountedImg
        ? "naturalHeight" in mountedImg
          ? mountedImg.naturalHeight
          : mountedImg.height
        : item.height ?? 0;

      const isUsableAsset = isMounted && (naturalW > 0 || naturalH > 0);

      return {
        pageNumber: item.pageNumber,
        pageIndex: item.pageIndex,
        src: item.src,
        srcKey: Registry.srcKeyOf(item.src),
        element: isMounted ? mountedImg : undefined,
        isMounted,
        isUsableAsset,
        width: naturalW > 0 ? naturalW : undefined,
        height: naturalH > 0 ? naturalH : undefined,
      };
    });

    const usableAssetCount = pages.filter((p) => p.isUsableAsset).length;
    const finalImages = pages
      .map((p) => p.element)
      .filter((el): el is MangaTargetElement => !!el);

    return {
      images: finalImages,
      pages,
      expectedCount: expectedCount > 0 ? expectedCount : pages.length,
      discoveredCount: pages.length,
      usableAssetCount,
      strategy: "bridge_intercept",
    };
  }

  // Case B: Slot-based discovery for Comix (.rpage-page slots)
  if (doc) {
    const slotPages = await discoverSlotBasedPages(doc, activeRule, {
      expectedCount,
      maxScrollAttempts: options?.maxScrollAttempts,
      scrollDelayMs: options?.scrollDelayMs,
    });
    if (slotPages && slotPages.length > 0 && (expectedCount <= 0 || slotPages.length >= expectedCount)) {
      const usableAssetCount = slotPages.filter((p) => p.isUsableAsset).length;
      const finalImages = slotPages
        .map((p) => p.element)
        .filter((el): el is MangaTargetElement => !!el);

      return {
        images: finalImages,
        pages: slotPages,
        expectedCount: expectedCount > 0 ? expectedCount : slotPages.length,
        discoveredCount: slotPages.length,
        usableAssetCount,
        strategy: "slot_discovery",
      };
    }
  }

  // Accumulate pages across all scroll steps to prevent virtualized unmount loss
  const accumulatedMap = new Map<
    string,
    { img: MangaTargetElement; src: string; pageNumber: number }
  >();

  const registerCandidate = (img: MangaTargetElement) => {
    const src = getElementSrc(img);
    if (!src) return;
    const k = Registry.srcKeyOf(src);
    const resolvedPage = resolveImagePageIndex(img, src, 0);
    const existing = accumulatedMap.get(k);
    if (!existing) {
      accumulatedMap.set(k, { img, src, pageNumber: resolvedPage });
    } else {
      if (typeof document !== "undefined" && document.body?.contains(img)) {
        existing.img = img;
      }
      if (existing.pageNumber <= 0 && resolvedPage > 0) {
        existing.pageNumber = resolvedPage;
      }
    }
  };

  const initialImages = findChapterImages(activeRule);
  for (const img of initialImages) {
    registerCandidate(img);
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

  const shouldScroll =
    expectedCount > 0
      ? accumulatedMap.size < expectedCount
      : initialImages.length > 0;

  if (shouldScroll) {
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
        registerCandidate(img);
      }

      if (expectedCount > 0 && accumulatedMap.size >= expectedCount) {
        break;
      }

      // Check if bottom reached
      if (
        container &&
        container.scrollTop + container.clientHeight >=
          container.scrollHeight - 50
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
  }

  // Re-check currently mounted DOM images after restoring scroll position
  const currentMounted = findChapterImages(activeRule);
  for (const img of currentMounted) {
    registerCandidate(img);
  }

  // Sort accumulated candidates deterministically by pageNumber / document position
  const rawItems = Array.from(accumulatedMap.values());
  const FOLLOWING =
    typeof Node !== "undefined" ? Node.DOCUMENT_POSITION_FOLLOWING : 4;
  const PRECEDING =
    typeof Node !== "undefined" ? Node.DOCUMENT_POSITION_PRECEDING : 2;

  rawItems.sort((a, b) => {
    if (
      a.pageNumber > 0 &&
      b.pageNumber > 0 &&
      a.pageNumber !== b.pageNumber
    ) {
      return a.pageNumber - b.pageNumber;
    }
    if (
      typeof document !== "undefined" &&
      document.body?.contains(a.img) &&
      document.body?.contains(b.img) &&
      typeof a.img.compareDocumentPosition === "function"
    ) {
      try {
        const pos = a.img.compareDocumentPosition(b.img);
        if (pos & FOLLOWING) return -1;
        if (pos & PRECEDING) return 1;
      } catch {}
    }
    return 0;
  });

  const pages: ChapterPageItem[] = rawItems.map((item, idx) => {
    const isMounted =
      typeof document !== "undefined" && document.body?.contains(item.img);
    const naturalW =
      "naturalWidth" in item.img ? item.img.naturalWidth : item.img.width;
    const naturalH =
      "naturalHeight" in item.img ? item.img.naturalHeight : item.img.height;
    const isUsableAsset =
      isMounted && (naturalW > 0 || naturalH > 0 || !!item.src);
    const pageNum = item.pageNumber > 0 ? item.pageNumber : idx + 1;

    return {
      pageNumber: pageNum,
      pageIndex: pageNum - 1,
      src: item.src,
      srcKey: Registry.srcKeyOf(item.src),
      element: isMounted ? item.img : undefined,
      isMounted,
      isUsableAsset,
    };
  });

  const usableAssetCount = pages.filter((p) => p.isUsableAsset).length;
  const finalImages = pages
    .map((p) => p.element)
    .filter((el): el is MangaTargetElement => !!el);

  return {
    images: finalImages,
    pages,
    expectedCount,
    discoveredCount: pages.length,
    usableAssetCount,
    strategy: "dom_scroll",
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
  private usableAssetCount = 0;
  private fetchedCount = 0;
  private verifiedCount = 0;
  private completedKeys = new Set<string>();
  private failedKeys = new Set<string>();
  private inFlightKeys = new Set<string>();
  private savingKeys = new Set<string>();
  private targetKeys = new Set<string>();
  private imageIndexMap = new Map<string, number>();
  private orderedPages: ChapterPageItem[] = [];
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

          // M1.4.1 REPAIR B & M1.4.2 REPAIR 1: Verify rendered image asset before marking verified
          const eventResult = (detail as any).result;
          const rendered = eventResult ?? Registry.getRenderedResult(detail.src);
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

      // M1.4.1 REPAIR A & M1.4.2 REPAIR 3: Strict readiness check.
      // A chapter is ONLY ready if:
      // 1. Expected count is verified (> 0).
      // 2. Exactly every expected page was discovered (discovered === expected).
      // 3. Exactly every expected page was completed and verified (done === expected).
      // 4. Zero pages failed (failed === 0).
      const isCompleteDiscovery = expected > 0 && discovered === expected;
      const isAllVerified = expected > 0 && done === expected && failed === 0;

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
        if (expected <= 0) {
          this.message = `Partial: Unknown total page count (${done} prepared, completeness unverified).`;
        } else if (!isCompleteDiscovery) {
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
      const identity = extractChapterIdentity(document);
      this.seriesName = identity.seriesName || "MANGA";
      this.chapterId = identity.chapterId || "001";
      this.chapterKey = generateChapterKey(this.seriesName, this.chapterId);
      this.chapterTitle = identity.chapterTitle || document.title;
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
    this.usableAssetCount = discovery.usableAssetCount;
    this.orderedPages = discovery.pages;
    this.orderedImages = discovery.images;

    if (this.discovered === 0) {
      this.status = "failed";
      this.message = "No manga chapter images discovered on this page.";
      this.emitProgress();
      return this.getProgress();
    }

    // M1.4.1 REPAIR A & M1.4.2 REPAIR 3: Incomplete discovery or unknown expected count guard
    // If expected count is unknown, completeness cannot be verified.
    if (this.expectedCount <= 0) {
      console.warn(
        "[LMT Chapter Prep] Chapter completeness is unverified: expected page count could not be extracted.",
      );
    } else if (this.discovered < this.expectedCount) {
      this.status = "partial";
      this.message = `Incomplete chapter discovery: found ${this.discovered} of ${this.expectedCount} pages. Chapter cannot be marked Ready.`;
      this.emitProgress();
      return this.getProgress();
    }

    this.status = "preparing";
    const pendingImages: MangaTargetElement[] = [];

    // Action B: Check durable offline store for completed pages across reload
    const storedPages = await getChapterPages(this.chapterKey);

    for (let i = 0; i < this.orderedPages.length; i++) {
      const pageItem = this.orderedPages[i];
      const k = pageItem.srcKey;
      this.imageIndexMap.set(k, pageItem.pageIndex);

      const isStoredDone = storedPages.some(
        (p) =>
          (p.src === pageItem.src || p.src === k) &&
          p.status === "done" &&
          p.verified,
      );

      if (Registry.getStatus(k) === "done" || isStoredDone) {
        this.completedKeys.add(k);
        this.verifiedCount++;
      } else {
        this.targetKeys.add(k);
        // Only enqueue if element is currently mounted in DOM!
        if (
          pageItem.element &&
          typeof document !== "undefined" &&
          document.body?.contains(pageItem.element)
        ) {
          pendingImages.push(pageItem.element);
        } else {
          // Look for currently mounted element in DOM
          const liveImg = findMountedImage(pageItem.src);
          if (
            liveImg &&
            typeof document !== "undefined" &&
            document.body?.contains(liveImg)
          ) {
            pendingImages.push(liveImg);
          } else {
            // M1.4.2 REPAIR 2 & M1.4.3 REPAIR D: Never treat a detached DOM reference as a usable page asset.
            // Mark failed explicitly and delete from targetKeys so it does not hang in queue!
            console.warn(
              `[LMT Chapter Prep] Page ${pageItem.pageNumber} (${pageItem.src}) is detached from DOM; marking failed.`,
            );
            this.failedKeys.add(k);
            this.targetKeys.delete(k);
          }
        }
      }
    }

    if (this.targetKeys.size === 0) {
      if (
        this.expectedCount > 0 &&
        this.completedKeys.size === this.expectedCount &&
        this.failedKeys.size === 0
      ) {
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
      } else {
        this.status = "partial";
        this.message =
          this.expectedCount <= 0
            ? `Partial: Unknown total page count (${this.completedKeys.size} prepared from cache, completeness unverified).`
            : `Partial: ${this.completedKeys.size}/${this.expectedCount} completed (${this.failedKeys.size} failed).`;
      }
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

  getChapterKey(): string {
    return this.chapterKey;
  }

  /**
   * Collector-only diagnostic mode for evaluating chapter collection without invoking Gemini API.
   * Reports expected count, discovered count, mounted count, acquired count, persisted count,
   * usable assets, page order, and missing pages.
   */
  async runDiagnostic(options?: {
    acquireAssets?: boolean;
  }): Promise<ChapterDiagnosticResult> {
    const activeRule =
      this.orchestrator.getActiveRule() ?? (await resolveActiveSiteRule());

    try {
      const identity = extractChapterIdentity(document);
      this.seriesName = identity.seriesName || this.seriesName || "MANGA";
      this.chapterId = identity.chapterId || this.chapterId || "001";
      this.chapterKey = generateChapterKey(this.seriesName, this.chapterId);
      this.chapterTitle =
        identity.chapterTitle || this.chapterTitle || document.title;
    } catch {
      this.seriesName = "MANGA";
      this.chapterId = "001";
      this.chapterKey = generateChapterKey(this.seriesName, this.chapterId);
      this.chapterTitle = typeof document !== "undefined" ? document.title : "";
    }

    const discovery = await discoverChapterImagesProgressive(activeRule);
    this.expectedCount = discovery.expectedCount;
    this.discovered = discovery.discoveredCount;
    this.orderedPages = discovery.pages;

    // Decoupled asset acquisition (ZERO Gemini API calls!)
    const shouldAcquire = options?.acquireAssets ?? true;
    if (
      shouldAcquire &&
      discovery.pages.length > 0 &&
      typeof browser !== "undefined" &&
      typeof browser.runtime?.sendMessage === "function"
    ) {
      try {
        await acquireChapterAssets(discovery.pages, this.chapterKey);
      } catch (e) {
        console.warn("[LMT Chapter Diagnostic] Asset acquisition encountered warning:", e);
      }
    }

    const storedPages = await getChapterPages(this.chapterKey);

    const pagesInfo = discovery.pages.map((p) => {
      const isMounted = p.element
        ? typeof document !== "undefined" && document.body?.contains(p.element)
        : findMountedImage(p.src) !== null;
      const stored = storedPages.find(
        (sp) =>
          sp.pageIndex === p.pageIndex ||
          sp.src === p.src ||
          sp.src === p.srcKey,
      );
      const isAcquired = !!(
        stored?.originalDataUrl ||
        stored?.renderedDataUrl ||
        p.isAcquired
      );
      const isStoredDone = stored?.status === "done" && stored.verified;
      const isUsableAsset = isMounted || isAcquired;

      return {
        pageNumber: p.pageNumber,
        pageIndex: p.pageIndex,
        src: p.src,
        isMounted,
        isAcquired,
        isUsableAsset,
        hasCachedTranslation: isStoredDone,
        width: stored?.width ?? p.width,
        height: stored?.height ?? p.height,
        byteLength: stored?.byteLength ?? p.byteLength,
        hash: stored?.hash ?? p.hash,
      };
    });

    const expectedCount = discovery.expectedCount;
    const discoveredCount = discovery.discoveredCount;
    const mountedCount = pagesInfo.filter((p) => p.isMounted).length;
    const acquiredCount = pagesInfo.filter((p) => p.isAcquired).length;
    const persistedCount = storedPages.length;
    const usableAssetCount = pagesInfo.filter((p) => p.isUsableAsset).length;

    // Determine missing page numbers
    const discoveredPageNumbers = new Set(pagesInfo.map((p) => p.pageNumber));
    const missingPageNumbers: number[] = [];
    if (expectedCount > 0) {
      for (let i = 1; i <= expectedCount; i++) {
        if (!discoveredPageNumbers.has(i)) {
          missingPageNumbers.push(i);
        }
      }
    }

    let verdict: CollectorVerdict = "READY_FOR_OWNER_RETEST";
    let message = `All ${expectedCount} expected pages discovered, acquired, and persisted in correct order without DOM dependency (${discovery.strategy || "slot_discovery"}).`;

    if (expectedCount <= 0) {
      verdict = "UNKNOWN_EXPECTED_COUNT";
      message = `Found ${discoveredCount} pages, but expected page count could not be extracted from reader metadata.`;
    } else if (discoveredCount < expectedCount) {
      verdict = "INCOMPLETE_DISCOVERY";
      message = `Incomplete discovery: found ${discoveredCount} of ${expectedCount} pages (missing pages: ${missingPageNumbers.join(", ")}).`;
    } else if (acquiredCount < expectedCount && persistedCount < expectedCount) {
      verdict = "PARTIAL_WITH_VERIFIED_BLOCKERS";
      message = `${discoveredCount - Math.max(acquiredCount, persistedCount)} of ${discoveredCount} pages could not be acquired or persisted.`;
    }

    const identity = extractChapterIdentity(document);
    const result: ChapterDiagnosticResult = {
      seriesName: this.seriesName,
      chapterId: this.chapterId,
      chapterInternalId: identity.chapterInternalId,
      chapterTitle: this.chapterTitle,
      url: typeof window !== "undefined" ? window.location.href : "",
      strategy: discovery.strategy || "slot_discovery",
      expectedCount,
      discoveredCount,
      mountedCount,
      acquiredCount,
      persistedCount,
      usableAssetCount,
      missingPageNumbers,
      pages: pagesInfo,
      verdict,
      message,
      timestamp: Date.now(),
    };

    console.group(`[LMT Chapter Diagnostic] ${this.chapterTitle || "Chapter"}`);
    console.info(
      `Expected: ${expectedCount || "UNKNOWN"} | Discovered: ${discoveredCount} | Mounted: ${mountedCount} | Acquired: ${acquiredCount} | Persisted: ${persistedCount} | Verdict: ${verdict}`,
    );
    if (typeof console.table === "function") {
      console.table(
        pagesInfo.map((p) => ({
          "Page #": p.pageNumber,
          Mounted: p.isMounted ? "YES" : "NO",
          Acquired: p.isAcquired ? "YES" : "NO",
          Usable: p.isUsableAsset ? "YES" : "NO",
          Dimensions:
            p.width && p.height ? `${p.width}x${p.height}` : "—",
          Bytes: p.byteLength
            ? `${Math.round(p.byteLength / 1024)} KB`
            : "—",
          "Source URL":
            p.src.length > 50 ? p.src.substring(0, 47) + "..." : p.src,
        })),
      );
    }
    console.groupEnd();

    if (typeof document !== "undefined") {
      document.dispatchEvent(
        new CustomEvent("lmt:chapter-prep-diagnostic-result", {
          detail: result,
        }),
      );
    }

    return result;
  }

  exportDiagnosticJson(diag?: ChapterDiagnosticResult): string {
    const data = diag || this.getProgress();
    return JSON.stringify(
      data,
      (key, value) => {
        if (typeof value === "string" && value.startsWith("data:image/") && value.length > 200) {
          return `[data-url: ${value.length} chars]`;
        }
        return value;
      },
      2,
    );
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
      usableAssetCount: this.usableAssetCount,
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
