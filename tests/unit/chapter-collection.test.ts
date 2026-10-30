import { describe, it, expect, beforeEach, mock } from "bun:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><head><title>Zipang · Ch.54</title></head><body></body></html>");
dom.window.location = new URL(
  "https://comix.to/title/gqwx-zipang/3196390-chapter-54",
) as any;
dom.window.scrollBy = () => {};
dom.window.scrollTo = () => {};

(globalThis as any).document = dom.document;
(globalThis as any).window = dom.window;
(globalThis as any).location = dom.window.location;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLImageElement = dom.window.HTMLImageElement;
(globalThis as any).HTMLCanvasElement = dom.window.HTMLCanvasElement;
(globalThis as any).HTMLSelectElement = dom.window.HTMLSelectElement;
(globalThis as any).Node = dom.Node;
(globalThis as any).Event = dom.window.Event || globalThis.Event;
(globalThis as any).CustomEvent = dom.CustomEvent;

let sentMessages: Array<{ type: string; data?: any }> = [];
let mockDownloadResponse: any = {
  success: true,
  downloadState: "download_completed",
  downloadId: 100,
};

(globalThis as any).browser = {
  runtime: {
    sendMessage: (msg: any) => {
      sentMessages.push(msg);
      if (msg.type === "DOWNLOAD_CHAPTER_CBZ") {
        return Promise.resolve(mockDownloadResponse);
      }
      return Promise.resolve({ success: true });
    },
    getURL: (p: string) => p,
  },
};

(globalThis as any).storage = {
  getItem: (key: string) => {
    if (key === "sync:target-lang") return Promise.resolve("th");
    return Promise.resolve(null);
  },
  setItem: () => Promise.resolve(),
  getItems: () => Promise.resolve([]),
  watch: () => () => {},
};

mock.module("#imports", () => ({
  storage: (globalThis as any).storage,
}));

const {
  extractExpectedPageCount,
  findChapterImages,
  discoverChapterImagesProgressive,
  ChapterPreparationManager,
} = await import("@/entrypoints/content/chapter-prep");

const {
  saveChapterRecord,
  getChapterRecord,
  savePageRecord,
  getChapterPages,
  clearInMemoryStore,
  setMockSavePageFailureHook,
} = await import("@/lib/artifacts/chapter-store");

const {
  parseZipArchive,
  detectImageSignature,
  dataUrlToUint8Array,
} = await import("@/lib/export/cbz");

const Registry = await import("@/entrypoints/content/translation-registry");
import type { SiteRule } from "@/lib/adapters";

const VALID_1PX_PNG_DATAURL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==";

describe("Complete Chapter Collection & Offline Artifacts (M1.4 & M1.4.1)", () => {
  beforeEach(() => {
    clearInMemoryStore();
    document.body.innerHTML = "";
    document.title = "Zipang · Ch.54";
    sentMessages = [];
    mockDownloadResponse = {
      success: true,
      downloadState: "download_completed",
      downloadId: 100,
    };
  });

  describe("extractExpectedPageCount — Reader Metadata Inspection", () => {
    it("extracts page count from Next.js __NEXT_DATA__ JSON script", () => {
      const script = document.createElement("script");
      script.id = "__NEXT_DATA__";
      script.type = "application/json";
      script.textContent = JSON.stringify({
        props: {
          pageProps: {
            chapter: {
              title: "Chapter 54",
              images: new Array(22).fill("https://example.com/page.jpg"),
            },
          },
        },
      });
      document.body.appendChild(script);

      const count = extractExpectedPageCount(document);
      expect(count).toBe(22);
    });

    it("extracts page count from reader page-select dropdown", () => {
      const select = document.createElement("select");
      select.name = "page";
      for (let i = 1; i <= 22; i++) {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.text = `Page ${i}`;
        select.appendChild(opt);
      }
      document.body.appendChild(select);

      const count = extractExpectedPageCount(document);
      expect(count).toBe(22);
    });

    it("extracts page count from text indicator '1 / 22' or '1 of 22'", () => {
      const indicator = document.createElement("div");
      indicator.className = "total-pages";
      indicator.textContent = "1 / 22";
      document.body.appendChild(indicator);

      const count = extractExpectedPageCount(document);
      expect(count).toBe(22);
    });

    it("extracts page count from SiteRule pageCountSelector", () => {
      const el = document.createElement("span");
      el.id = "custom-page-counter";
      el.textContent = "Total Pages: 22";
      document.body.appendChild(el);

      const rule: SiteRule = {
        id: "custom",
        domain: "custom.com",
        seriesName: { regex: ".*", source: "title" },
        chapterId: { regex: ".*", source: "path" },
        pageIndex: { regex: ".*", source: "path" },
        pageCountSelector: "#custom-page-counter",
        expectedCountRegex: "Total Pages:\\s*(\\d+)",
      };

      const count = extractExpectedPageCount(document, rule);
      expect(count).toBe(22);
    });
  });

  describe("Document Order & Progressive Virtualized Discovery", () => {
    it("strictly preserves DOM document order across discovered candidate images", () => {
      const container = document.createElement("div");
      container.className = "reader-container";

      const img1 = document.createElement("img");
      img1.src = "https://cdn.example.com/p001.jpg";
      img1.width = 800;
      img1.height = 1200;

      const img2 = document.createElement("img");
      img2.src = "https://cdn.example.com/p002.jpg";
      img2.width = 800;
      img2.height = 1200;

      const img3 = document.createElement("img");
      img3.src = "https://cdn.example.com/p003.jpg";
      img3.width = 800;
      img3.height = 1200;

      container.appendChild(img1);
      container.appendChild(img2);
      container.appendChild(img3);
      document.body.appendChild(container);

      const rule: SiteRule = {
        id: "comix",
        domain: "comix.to",
        seriesName: { regex: ".*", source: "title" },
        chapterId: { regex: ".*", source: "path" },
        pageIndex: { regex: "^$", source: "path" },
        containerSelector: ".reader-container",
        imageSelector: ".reader-container img",
      };

      const discovered = findChapterImages(rule);
      expect(discovered.length).toBe(3);
      expect(discovered[0]).toBe(img1);
      expect(discovered[1]).toBe(img2);
      expect(discovered[2]).toBe(img3);
    });

    it("distinguishes expectedCount and discoveredCount in virtualized reader", async () => {
      // Reader metadata says 22 pages, but DOM has 16 loaded initially
      const script = document.createElement("script");
      script.id = "__NEXT_DATA__";
      script.type = "application/json";
      script.textContent = JSON.stringify({
        props: {
          pageProps: {
            chapter: { total_pages: 22 },
          },
        },
      });
      document.body.appendChild(script);

      const container = document.createElement("div");
      container.className = "reader-container";
      for (let i = 1; i <= 16; i++) {
        const img = document.createElement("img");
        img.src = `https://cdn.comix.to/zipang-54/page_${String(i).padStart(2, "0")}.jpg`;
        img.width = 800;
        img.height = 1200;
        container.appendChild(img);
      }
      document.body.appendChild(container);

      const rule: SiteRule = {
        id: "comix",
        domain: "comix.to",
        seriesName: { regex: ".*", source: "title" },
        chapterId: { regex: ".*", source: "path" },
        pageIndex: { regex: "^$", source: "path" },
        containerSelector: ".reader-container",
        imageSelector: ".reader-container img",
      };

      const discovery = await discoverChapterImagesProgressive(rule, { scrollDelayMs: 1 });
      expect(discovery.expectedCount).toBe(22);
      expect(discovery.discoveredCount).toBe(16);
    });
  });

  describe("M1.4.1 Acceptance Criteria (PM Required Tests 1–6)", () => {
    // 1. Expected 22 / discovered 16 -> Not Ready, no CBZ auto-download
    it("Test 1: Incomplete discovery (expected 22, discovered 16) reports partial, never Ready, and triggers zero CBZ downloads", async () => {
      // Inject metadata indicating 22 pages
      const script = document.createElement("script");
      script.id = "__NEXT_DATA__";
      script.type = "application/json";
      script.textContent = JSON.stringify({
        props: { pageProps: { chapter: { total_pages: 22 } } },
      });
      document.body.appendChild(script);

      // Mount only 16 images in DOM
      for (let i = 1; i <= 16; i++) {
        const img = document.createElement("img");
        img.src = `https://cdn.comix.to/zipang-54/p_${String(i).padStart(2, "0")}.jpg`;
        img.width = 800;
        img.height = 1200;
        document.body.appendChild(img);
      }

      const enqueuedImages: any[] = [];
      const mockOrchestrator = {
        getActiveRule: () => null,
        enqueueManual: (img: any) => enqueuedImages.push(img),
      } as any;

      const manager = new ChapterPreparationManager(mockOrchestrator);
      const progress = await manager.start();

      expect(progress.status).toBe("partial");
      expect(progress.expectedCount).toBe(22);
      expect(progress.discovered).toBe(16);
      expect(progress.message).toContain("Incomplete chapter discovery: found 16 of 22 pages");
      expect(manager.isActive()).toBe(false);

      // Verify zero downloads and zero enqueued tasks
      expect(enqueuedImages.length).toBe(0);
      const cbzMessages = sentMessages.filter(
        (m) => m.type === "DOWNLOAD_CHAPTER_CBZ",
      );
      expect(cbzMessages.length).toBe(0);
      manager.destroy();
    });

    // 2. Expected 22 / all 22 valid and persisted -> valid ordered CBZ
    it("Test 2: All 22 expected pages completed and verified produces a valid ordered CBZ with exact count and signatures", async () => {
      // Inject metadata indicating 22 pages
      const script = document.createElement("script");
      script.id = "__NEXT_DATA__";
      script.type = "application/json";
      script.textContent = JSON.stringify({
        props: { pageProps: { chapter: { total_pages: 22 } } },
      });
      document.body.appendChild(script);

      // Mount 22 images
      const images: HTMLImageElement[] = [];
      for (let i = 1; i <= 22; i++) {
        const img = document.createElement("img");
        img.src = `https://cdn.comix.to/zipang-54/p_${String(i).padStart(3, "0")}.jpg`;
        img.width = 800;
        img.height = 1200;
        document.body.appendChild(img);
        images.push(img);
      }

      const enqueued: any[] = [];
      const mockOrchestrator = {
        getActiveRule: () => null,
        enqueueManual: (img: any) => enqueued.push(img),
      } as any;

      const manager = new ChapterPreparationManager(mockOrchestrator);
      await manager.start();
      expect(enqueued.length).toBe(22);

      // Simulate translation completion and durable store verification for each page
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        Registry.setRenderedResult(img.src, {
          renderedUrl: VALID_1PX_PNG_DATAURL,
          translations: [`บทสนทนาหน้าที่ ${i + 1}`],
          sourceTexts: [`Page dialogue ${i + 1}`],
        });
        Registry.markDone(img.src);
      }

      // Allow async savePageRecord and checkSettled to complete
      await new Promise((r) => setTimeout(r, 60));

      const progress = manager.getProgress();
      expect(progress.status).toBe("ready");
      expect(progress.downloadState).toBe("download_completed");
      expect(progress.completed).toBe(22);
      expect(progress.verifiedCount).toBe(22);

      // Verify notification sent
      const notifMessages = sentMessages.filter(
        (m) =>
          m.type === "SHOW_NOTIFICATION" &&
          m.data?.title?.includes("Chapter Ready & Downloaded"),
      );
      expect(notifMessages.length).toBe(1);

      // Verify CBZ download payload
      const cbzMessages = sentMessages.filter(
        (m) => m.type === "DOWNLOAD_CHAPTER_CBZ",
      );
      expect(cbzMessages.length).toBe(1);
      const downloadPayload = cbzMessages[0].data;
      expect(downloadPayload.filename).toMatch(/^ZIPANG_.*_TH\.cbz$/);

      // Verify CBZ integrity using independent ZIP parser
      const archiveBytes = dataUrlToUint8Array(downloadPayload.dataUrl);
      const parsedArchive = parseZipArchive(archiveBytes);

      // Must have exactly 22 page images + manifest.json = 23 entries
      expect(parsedArchive.files.length).toBe(23);

      const fileNames = parsedArchive.files.map((e) => e.name);
      for (let i = 1; i <= 22; i++) {
        const expectedName = `${String(i).padStart(3, "0")}.png`;
        expect(fileNames).toContain(expectedName);
      }
      expect(fileNames).toContain("manifest.json");

      // Ensure NO .txt placeholder files exist
      const txtFiles = fileNames.filter((n) => n.endsWith(".txt"));
      expect(txtFiles.length).toBe(0);

      // Verify image binary signatures
      for (let i = 1; i <= 22; i++) {
        const expectedName = `${String(i).padStart(3, "0")}.png`;
        const entry = parsedArchive.files.find((e) => e.name === expectedName)!;
        const sig = detectImageSignature(entry.data);
        expect(sig).toBeDefined();
        expect(sig?.ext).toBe("png");
        expect(entry.isValidCrc).toBe(true);
      }

      // Verify manifest content
      const manifestEntry = parsedArchive.files.find((e) => e.name === "manifest.json")!;
      const manifestJson = JSON.parse(new TextDecoder().decode(manifestEntry.data));
      expect(manifestJson.pageCount).toBe(22);
      expect(manifestJson.generator).toContain("LMT M1.4.1");

      manager.destroy();
    });

    // 3. Page finishes rendering but IndexedDB write fails -> no false Ready
    it("Test 3: Page finishes rendering but durable write fails -> page is marked failed and chapter never marks Ready", async () => {
      for (let i = 1; i <= 2; i++) {
        const img = document.createElement("img");
        img.src = `https://cdn.example.com/fail_test/p${i}.jpg`;
        img.width = 800;
        img.height = 1200;
        document.body.appendChild(img);
      }

      const mockOrchestrator = {
        getActiveRule: () => null,
        enqueueManual: () => {},
      } as any;

      const manager = new ChapterPreparationManager(mockOrchestrator);
      await manager.start();

      // Configure durable store failure hook: page 2 write rejects
      setMockSavePageFailureHook((page) => {
        if (page.pageIndex === 1) {
          return new Error("IndexedDB QuotaExceededError");
        }
        return null;
      });

      // Page 1 succeeds
      Registry.setRenderedResult("https://cdn.example.com/fail_test/p1.jpg", {
        renderedUrl: VALID_1PX_PNG_DATAURL,
      });
      Registry.markDone("https://cdn.example.com/fail_test/p1.jpg");

      // Page 2 finishes rendering in memory but its durable write fails
      Registry.setRenderedResult("https://cdn.example.com/fail_test/p2.jpg", {
        renderedUrl: VALID_1PX_PNG_DATAURL,
      });
      Registry.markDone("https://cdn.example.com/fail_test/p2.jpg");

      await new Promise((r) => setTimeout(r, 60));

      const progress = manager.getProgress();
      expect(progress.status).toBe("partial"); // NEVER "ready"!
      expect(progress.failed).toBe(1);
      expect(progress.completed).toBe(1);

      // Verify zero CBZ export was triggered
      const cbzMessages = sentMessages.filter(
        (m) => m.type === "DOWNLOAD_CHAPTER_CBZ",
      );
      expect(cbzMessages.length).toBe(0);

      manager.destroy();
    });

    // 4. Missing rendered image -> no placeholder and no successful CBZ (explicit export error)
    it("Test 4: Missing or invalid rendered image strictly fails export without substituting .txt placeholders", async () => {
      const chapterKey = "zipang__54";
      await saveChapterRecord({
        id: chapterKey,
        seriesName: "Zipang",
        chapterId: "54",
        chapterTitle: "Zipang · Ch.54",
        url: "https://comix.to/title/gqwx-zipang/3196390-chapter-54",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expectedCount: 2,
        discoveredCount: 2,
        fetchedCount: 2,
        verifiedCount: 2,
        status: "ready",
        exportStatus: "not_exported",
      });

      // Page 1 has valid PNG image
      await savePageRecord({
        id: `${chapterKey}__page_0`,
        chapterKey,
        pageIndex: 0,
        pageNumber: 1,
        src: "https://cdn.example.com/p1.jpg",
        mimeType: "image/png",
        renderedDataUrl: VALID_1PX_PNG_DATAURL,
        translations: ["หน้า 1"],
        verified: true,
        status: "done",
        updatedAt: Date.now(),
      });

      // Page 2 has corrupt / invalid non-image payload (e.g. text or placeholder)
      await savePageRecord({
        id: `${chapterKey}__page_1`,
        chapterKey,
        pageIndex: 1,
        pageNumber: 2,
        src: "https://cdn.example.com/p2.jpg",
        mimeType: "text/plain",
        renderedDataUrl: "data:text/plain;base64,VGhpcyBpcyB0ZXh0IG5vdCBhbiBpbWFnZQ==",
        translations: ["หน้า 2"],
        verified: true,
        status: "done",
        updatedAt: Date.now(),
      });

      const mockOrchestrator = {
        getActiveRule: () => null,
        enqueueManual: () => {},
      } as any;

      const manager = new ChapterPreparationManager(mockOrchestrator);
      const success = await manager.exportAndDownloadCbz(chapterKey);
      expect(success).toBe(false);

      const progress = manager.getProgress();
      expect(progress.downloadState).toBe("download_failed");
      expect(progress.message).toContain("corrupt or unrecognized image signature");

      // Verify zero download messages dispatched
      const cbzMessages = sentMessages.filter(
        (m) => m.type === "DOWNLOAD_CHAPTER_CBZ",
      );
      expect(cbzMessages.length).toBe(0);

      manager.destroy();
    });

    // 5. Browser download starts but fails -> reported Failed, not Downloaded
    it("Test 5: Browser download failure is truthfully reported as failed and never sends completion notification", async () => {
      const chapterKey = "zipang__54";
      await saveChapterRecord({
        id: chapterKey,
        seriesName: "Zipang",
        chapterId: "54",
        chapterTitle: "Zipang · Ch.54",
        url: "https://comix.to/title/gqwx-zipang/3196390-chapter-54",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expectedCount: 1,
        discoveredCount: 1,
        fetchedCount: 1,
        verifiedCount: 1,
        status: "ready",
        exportStatus: "not_exported",
      });

      await savePageRecord({
        id: `${chapterKey}__page_0`,
        chapterKey,
        pageIndex: 0,
        pageNumber: 1,
        src: "https://cdn.example.com/p1.jpg",
        mimeType: "image/png",
        renderedDataUrl: VALID_1PX_PNG_DATAURL,
        translations: ["หน้า 1"],
        verified: true,
        status: "done",
        updatedAt: Date.now(),
      });

      // Simulate browser download failure (disk full or user cancel)
      mockDownloadResponse = {
        success: false,
        downloadState: "download_failed",
        error: "Download interrupted: DISK_FULL",
      };

      const mockOrchestrator = {
        getActiveRule: () => null,
        enqueueManual: () => {},
      } as any;

      const manager = new ChapterPreparationManager(mockOrchestrator);
      const success = await manager.exportAndDownloadCbz(chapterKey);
      expect(success).toBe(false);

      const progress = manager.getProgress();
      expect(progress.downloadState).toBe("download_failed");
      expect(progress.message).toContain("Download interrupted: DISK_FULL");

      // Ensure completion notification was NOT sent
      const completedNotifs = sentMessages.filter(
        (m) =>
          m.type === "SHOW_NOTIFICATION" &&
          m.data?.title?.includes("Chapter Ready & Downloaded"),
      );
      expect(completedNotifs.length).toBe(0);

      // Verify failure notification WAS sent
      const failureNotifs = sentMessages.filter(
        (m) =>
          m.type === "SHOW_NOTIFICATION" &&
          m.data?.title?.includes("Chapter Download Failed"),
      );
      expect(failureNotifs.length).toBe(1);

      manager.destroy();
    });

    // 6. Browser reload -> re-export completed chapter without inference
    it("Test 6: Reload recovery re-exports completed chapter from offline store without invoking Gemini inference", async () => {
      const chapterKey = "zipang__54";
      await saveChapterRecord({
        id: chapterKey,
        seriesName: "Zipang",
        chapterId: "54",
        chapterTitle: "Zipang · Ch.54",
        url: "https://comix.to/title/gqwx-zipang/3196390-chapter-54",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expectedCount: 2,
        discoveredCount: 2,
        fetchedCount: 2,
        verifiedCount: 2,
        status: "ready",
        exportStatus: "not_exported",
      });

      for (let i = 0; i < 2; i++) {
        await savePageRecord({
          id: `${chapterKey}__page_${i}`,
          chapterKey,
          pageIndex: i,
          pageNumber: i + 1,
          src: `https://cdn.example.com/reload/p${i + 1}.jpg`,
          mimeType: "image/png",
          renderedDataUrl: VALID_1PX_PNG_DATAURL,
          translations: [`หน้า ${i + 1}`],
          sourceTexts: [`Page ${i + 1}`],
          verified: true,
          status: "done",
          updatedAt: Date.now(),
        });
      }

      const inferenceCalls: any[] = [];
      const mockOrchestrator = {
        getActiveRule: () => null,
        enqueueManual: (img: any) => inferenceCalls.push(img),
      } as any;

      const manager = new ChapterPreparationManager(mockOrchestrator);

      // Re-export chapter after reload
      const exported = await manager.reExportChapter(chapterKey);
      expect(exported).toBe(true);

      // Verify zero inference enqueue calls
      expect(inferenceCalls.length).toBe(0);

      // Verify CBZ was generated and sent
      const cbzMessages = sentMessages.filter(
        (m) => m.type === "DOWNLOAD_CHAPTER_CBZ",
      );
      expect(cbzMessages.length).toBe(1);

      const parsedArchive = parseZipArchive(
        dataUrlToUint8Array(cbzMessages[0].data.dataUrl),
      );
      expect(parsedArchive.files.length).toBe(3); // 2 pages + manifest
      expect(parsedArchive.files.map((e) => e.name)).toEqual([
        "001.png",
        "002.png",
        "manifest.json",
      ]);
      expect(parsedArchive.files[0].isValidCrc).toBe(true);
      expect(parsedArchive.files[1].isValidCrc).toBe(true);
      expect(parsedArchive.files[2].isValidCrc).toBe(true);

      manager.destroy();
    });
  });
});
