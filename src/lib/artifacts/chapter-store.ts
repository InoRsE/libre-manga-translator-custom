/**
 * Persistent Offline Chapter & Page Store
 * Provides durable IndexedDB persistence for chapter manifests, rendered page images,
 * and translation artifacts across browser reloads or network interruptions.
 */

export interface StoredChapter {
  id: string; // e.g. "zipang__54"
  seriesName: string;
  chapterId: string;
  chapterTitle: string;
  url: string;
  createdAt: number;
  updatedAt: number;
  expectedCount: number;
  discoveredCount: number;
  fetchedCount: number;
  verifiedCount: number;
  status: "idle" | "preparing" | "ready" | "partial" | "failed";
  exportStatus: "not_exported" | "exported";
  exportedFilename?: string;
  exportedAt?: number;
}

export interface StoredPage {
  id: string; // e.g. "zipang__54__page_0"
  chapterKey: string;
  pageIndex: number;
  pageNumber: number; // 1-based (001, 002...)
  src: string;
  mimeType: string;
  renderedDataUrl?: string;
  translations: string[];
  sourceTexts?: string[];
  verified: boolean;
  status: "pending" | "done" | "failed";
  updatedAt: number;
}

const DB_NAME = "lmt_offline_store";
const DB_VERSION = 1;
const STORE_CHAPTERS = "chapters";
const STORE_PAGES = "pages";

// In-memory fallback for non-browser environments (e.g. Bun unit tests)
const memoryChapters = new Map<string, StoredChapter>();
const memoryPages = new Map<string, StoredPage>();

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!hasIndexedDb()) {
      return reject(new Error("IndexedDB not available in current environment"));
    }

    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CHAPTERS)) {
        db.createObjectStore(STORE_CHAPTERS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_PAGES)) {
        const pageStore = db.createObjectStore(STORE_PAGES, { keyPath: "id" });
        pageStore.createIndex("chapterKey", "chapterKey", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function generateChapterKey(seriesName: string, chapterId: string): string {
  const s = (seriesName || "manga").toLowerCase().replace(/[^\w-]/g, "_");
  const c = (chapterId || "0").toLowerCase().replace(/[^\w-]/g, "_");
  return `${s}__${c}`;
}

export function generatePageKey(chapterKey: string, pageIndex: number): string {
  return `${chapterKey}__page_${pageIndex}`;
}

export async function saveChapterRecord(chapter: StoredChapter): Promise<void> {
  if (!hasIndexedDb()) {
    memoryChapters.set(chapter.id, { ...chapter, updatedAt: Date.now() });
    return;
  }

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAPTERS, "readwrite");
    const store = tx.objectStore(STORE_CHAPTERS);
    store.put({ ...chapter, updatedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getChapterRecord(chapterKey: string): Promise<StoredChapter | null> {
  if (!hasIndexedDb()) {
    return memoryChapters.get(chapterKey) ?? null;
  }

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAPTERS, "readonly");
    const store = tx.objectStore(STORE_CHAPTERS);
    const req = store.get(chapterKey);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function savePageRecord(page: StoredPage): Promise<void> {
  if (!hasIndexedDb()) {
    memoryPages.set(page.id, { ...page, updatedAt: Date.now() });
    return;
  }

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PAGES, "readwrite");
    const store = tx.objectStore(STORE_PAGES);
    store.put({ ...page, updatedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPageRecord(
  chapterKey: string,
  pageIndex: number,
): Promise<StoredPage | null> {
  const pageId = generatePageKey(chapterKey, pageIndex);
  if (!hasIndexedDb()) {
    return memoryPages.get(pageId) ?? null;
  }

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PAGES, "readonly");
    const store = tx.objectStore(STORE_PAGES);
    const req = store.get(pageId);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function getChapterPages(chapterKey: string): Promise<StoredPage[]> {
  if (!hasIndexedDb()) {
    const result: StoredPage[] = [];
    for (const page of memoryPages.values()) {
      if (page.chapterKey === chapterKey) {
        result.push(page);
      }
    }
    return result.sort((a, b) => a.pageIndex - b.pageIndex);
  }

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PAGES, "readonly");
    const store = tx.objectStore(STORE_PAGES);
    const index = store.index("chapterKey");
    const req = index.getAll(chapterKey);
    req.onsuccess = () => {
      const pages = (req.result || []) as StoredPage[];
      pages.sort((a, b) => a.pageIndex - b.pageIndex);
      resolve(pages);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function markChapterExported(
  chapterKey: string,
  exportedFilename: string,
): Promise<void> {
  const existing = await getChapterRecord(chapterKey);
  if (existing) {
    existing.exportStatus = "exported";
    existing.exportedFilename = exportedFilename;
    existing.exportedAt = Date.now();
    await saveChapterRecord(existing);
  }
}

export function clearInMemoryStore(): void {
  memoryChapters.clear();
  memoryPages.clear();
}
