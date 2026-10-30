import { describe, it, expect, beforeEach, mock } from "bun:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
dom.window.location = new URL("https://comix.to/title/gqwx-zipang/3196390-chapter-54") as any;
(globalThis as any).document = dom.document;
(globalThis as any).window = dom.window;
(globalThis as any).location = dom.window.location;
(globalThis as any).CustomEvent = dom.CustomEvent;
(globalThis as any).HTMLImageElement = dom.HTMLImageElement;
(globalThis as any).HTMLCanvasElement = dom.HTMLCanvasElement;
(globalThis as any).HTMLSelectElement = dom.HTMLSelectElement;
(globalThis as any).Node = dom.Node;

(globalThis as any).browser = {
  runtime: {
    sendMessage: () => Promise.resolve({ success: true }),
    getURL: (p: string) => p,
  },
};

(globalThis as any).storage = {
  getItem: () => Promise.resolve(null),
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
} = await import("@/lib/artifacts/chapter-store");
import type { SiteRule } from "@/lib/adapters";

describe("Complete Chapter Collection & Offline Artifacts (M1.4 ACTION A & B)", () => {
  beforeEach(() => {
    clearInMemoryStore();
    document.body.innerHTML = "";
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

    it("distinguishes expectedCount, discoveredCount, fetchedCount, verifiedCount", async () => {
      // Simulate Comix reader where metadata says 22 pages, but DOM has 16 loaded initially
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

      const discovery = await discoverChapterImagesProgressive(rule);
      expect(discovery.expectedCount).toBe(22);
      expect(discovery.discoveredCount).toBe(16);
    });
  });

  describe("Durable Offline Store — Interruption & Reload Recovery", () => {
    it("persists and reloads completed pages so they are not re-translated", async () => {
      const chapterKey = "zipang__54";

      await saveChapterRecord({
        id: chapterKey,
        seriesName: "Zipang",
        chapterId: "54",
        chapterTitle: "Zipang · Ch.54",
        url: "https://comix.to/title/gqwx-zipang/3196390-chapter-54",
        createdAt: Date.now() - 60000,
        updatedAt: Date.now(),
        expectedCount: 22,
        discoveredCount: 22,
        fetchedCount: 22,
        verifiedCount: 22,
        status: "ready",
        exportStatus: "exported",
        exportedFilename: "ZIPANG_Ch054_TH.cbz",
      });

      await savePageRecord({
        id: `${chapterKey}__page_0`,
        chapterKey,
        pageIndex: 0,
        pageNumber: 1,
        src: "https://cdn.comix.to/zipang-54/001.jpg",
        mimeType: "image/png",
        renderedDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==",
        translations: ["กัปตันคาโดมัตสึ!"],
        sourceTexts: ["Captain Kadomatsu!"],
        verified: true,
        status: "done",
        updatedAt: Date.now(),
      });

      const loadedChapter = await getChapterRecord(chapterKey);
      expect(loadedChapter).toBeDefined();
      expect(loadedChapter?.expectedCount).toBe(22);
      expect(loadedChapter?.exportStatus).toBe("exported");

      const pages = await getChapterPages(chapterKey);
      expect(pages.length).toBe(1);
      expect(pages[0].pageIndex).toBe(0);
      expect(pages[0].translations).toEqual(["กัปตันคาโดมัตสึ!"]);
      expect(pages[0].verified).toBe(true);
    });
  });
});
