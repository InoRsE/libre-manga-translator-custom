import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { parseHTML } from "linkedom";

// Setup DOM globals for tests
const dom = parseHTML("<!doctype html><html><body></body></html>");
dom.window.location = new URL("https://comix.to/title/test/123-chapter-54") as any;
(globalThis as any).document = dom.document;
(globalThis as any).window = dom.window;
(globalThis as any).location = dom.window.location;
(globalThis as any).CustomEvent = dom.CustomEvent;
(globalThis as any).HTMLImageElement = dom.HTMLImageElement;
(globalThis as any).HTMLCanvasElement = dom.HTMLCanvasElement;
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

// Use dynamic imports so mock.module takes effect before resolution
const {
  normalizeImageSrc,
  isCandidateMangaImage,
  findChapterImages,
  ChapterPreparationManager,
} = await import("../../src/entrypoints/content/chapter-prep");
const Registry = await import("../../src/entrypoints/content/translation-registry");
import type { SiteRule } from "../../src/lib/adapters";
import type { AutoTranslateOrchestrator } from "../../src/entrypoints/content/auto-translate";

describe("Chapter Preparation — Image Discovery & Normalization", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("normalizes data-src attributes to src when src is empty or SVG placeholder", () => {
    const img = document.createElement("img") as HTMLImageElement;
    img.setAttribute("data-src", "https://cdn.example.com/chapter-54/p01.jpg");
    img.setAttribute("src", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=");
    img.loading = "lazy";

    normalizeImageSrc(img);

    expect(img.src).toBe("https://cdn.example.com/chapter-54/p01.jpg");
    expect(String(img.loading)).toBe("eager");
  });

  it("normalizes data-lazy-src and data-original attributes", () => {
    const img1 = document.createElement("img") as HTMLImageElement;
    img1.setAttribute("data-lazy-src", "https://cdn.example.com/ch54/page02.webp");
    normalizeImageSrc(img1);
    expect(img1.src).toBe("https://cdn.example.com/ch54/page02.webp");

    const img2 = document.createElement("img") as HTMLImageElement;
    img2.setAttribute("data-original", "https://cdn.example.com/ch54/page03.png");
    normalizeImageSrc(img2);
    expect(img2.src).toBe("https://cdn.example.com/ch54/page03.png");
  });

  it("isCandidateMangaImage matches site rule imageSelector", () => {
    const rule: SiteRule = {
      id: "comix",
      domain: "comix.to",
      seriesName: { regex: "(.*)", source: "title" },
      chapterId: { regex: "(.*)", source: "path" },
      pageIndex: { regex: "", source: "path" },
      imageSelector: ".reader-container img",
    };

    const container = document.createElement("div");
    container.className = "reader-container";
    const img = document.createElement("img");
    container.appendChild(img);
    document.body.appendChild(container);

    expect(isCandidateMangaImage(img, rule)).toBe(true);
  });

  it("isCandidateMangaImage rejects tiny images (e.g. icons, avatars)", () => {
    const icon = document.createElement("img");
    Object.defineProperty(icon, "naturalWidth", { value: 32, configurable: true });
    Object.defineProperty(icon, "naturalHeight", { value: 32, configurable: true });

    expect(isCandidateMangaImage(icon, null)).toBe(false);
  });

  it("isCandidateMangaImage accepts large manga images even without site rule", () => {
    const page = document.createElement("img");
    Object.defineProperty(page, "naturalWidth", { value: 800, configurable: true });
    Object.defineProperty(page, "naturalHeight", { value: 1200, configurable: true });

    expect(isCandidateMangaImage(page, null)).toBe(true);
  });

  it("findChapterImages preserves document order and deduplicates", () => {
    const reader = document.createElement("div");
    reader.className = "reader-container";

    const img1 = document.createElement("img") as HTMLImageElement;
    img1.src = "https://cdn.example.com/ch54/01.jpg";
    Object.defineProperty(img1, "naturalWidth", { value: 800, configurable: true });
    Object.defineProperty(img1, "naturalHeight", { value: 1200, configurable: true });

    const img2 = document.createElement("img") as HTMLImageElement;
    img2.src = "https://cdn.example.com/ch54/02.jpg";
    Object.defineProperty(img2, "naturalWidth", { value: 800, configurable: true });
    Object.defineProperty(img2, "naturalHeight", { value: 1200, configurable: true });

    const imgDuplicate = document.createElement("img") as HTMLImageElement;
    imgDuplicate.src = "https://cdn.example.com/ch54/01.jpg";
    Object.defineProperty(imgDuplicate, "naturalWidth", { value: 800, configurable: true });
    Object.defineProperty(imgDuplicate, "naturalHeight", { value: 1200, configurable: true });

    reader.appendChild(img1);
    reader.appendChild(img2);
    reader.appendChild(imgDuplicate);
    document.body.appendChild(reader);

    const found = findChapterImages(null);
    expect(found.length).toBe(2);
    expect((found[0] as HTMLImageElement).src).toBe("https://cdn.example.com/ch54/01.jpg");
    expect((found[1] as HTMLImageElement).src).toBe("https://cdn.example.com/ch54/02.jpg");
  });
});

describe("ChapterPreparationManager — State Machine & Truthful Accounting", () => {
  let mockOrchestrator: AutoTranslateOrchestrator;
  let enqueued: any[] = [];

  beforeEach(() => {
    document.body.innerHTML = "";
    enqueued = [];
    mockOrchestrator = {
      getActiveRule: () => null,
      enqueueManual: (img: any) => {
        enqueued.push(img);
      },
    } as any;
  });

  it("starts in idle state", () => {
    const manager = new ChapterPreparationManager(mockOrchestrator);
    const prog = manager.getProgress();
    expect(prog.status).toBe("idle");
    expect(prog.discovered).toBe(0);
    expect(prog.completed).toBe(0);
    expect(prog.failed).toBe(0);
    manager.destroy();
  });

  it("handles empty document safely (discovered = 0 -> failed)", async () => {
    document.body.innerHTML = "";
    const manager = new ChapterPreparationManager(mockOrchestrator);

    const prog = await manager.start({ notify: false });
    expect(prog.status).toBe("failed");
    expect(prog.discovered).toBe(0);
    expect(prog.message).toContain("No manga chapter images");
    manager.destroy();
  });

  it("transitions to ready when all pages complete successfully", async () => {
    // Inject verified reader metadata indicating expected page count is 2
    const script = document.createElement("script");
    script.id = "__NEXT_DATA__";
    script.type = "application/json";
    script.textContent = JSON.stringify({
      props: { pageProps: { chapter: { total_pages: 2 } } },
    });
    document.body.appendChild(script);

    const reader = document.createElement("div");
    reader.className = "reader-container";

    const img1 = document.createElement("img") as HTMLImageElement;
    img1.src = "https://cdn.test.com/ch1/01.jpg";
    Object.defineProperty(img1, "naturalWidth", { value: 800, configurable: true });
    Object.defineProperty(img1, "naturalHeight", { value: 1200, configurable: true });

    const img2 = document.createElement("img") as HTMLImageElement;
    img2.src = "https://cdn.test.com/ch1/02.jpg";
    Object.defineProperty(img2, "naturalWidth", { value: 800, configurable: true });
    Object.defineProperty(img2, "naturalHeight", { value: 1200, configurable: true });

    reader.appendChild(img1);
    reader.appendChild(img2);
    document.body.appendChild(reader);

    const manager = new ChapterPreparationManager(mockOrchestrator);
    const startProg = await manager.start({ notify: false });

    expect(startProg.status).toBe("preparing");
    expect(startProg.discovered).toBe(2);
    expect(enqueued.length).toBe(2);

    const DUMMY_PNG =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==";

    // Simulate page 1 finishing
    Registry.setRenderedResult(img1.src, { renderedUrl: DUMMY_PNG });
    Registry.markDone(img1.src);
    await new Promise((r) => setTimeout(r, 20));
    let current = manager.getProgress();
    expect(current.status).toBe("preparing");
    expect(current.completed).toBe(1);

    // Simulate page 2 finishing
    Registry.setRenderedResult(img2.src, { renderedUrl: DUMMY_PNG });
    Registry.markDone(img2.src);
    await new Promise((r) => setTimeout(r, 20));
    current = manager.getProgress();
    expect(current.status).toBe("ready");
    expect(current.completed).toBe(2);
    expect(current.failed).toBe(0);

    manager.destroy();
  });

  it("truthfully marks partial when some pages fail", async () => {
    const reader = document.createElement("div");
    reader.className = "reader-container";

    const img1 = document.createElement("img") as HTMLImageElement;
    img1.src = "https://cdn.test.com/ch2/01.jpg";
    Object.defineProperty(img1, "naturalWidth", { value: 800, configurable: true });
    Object.defineProperty(img1, "naturalHeight", { value: 1200, configurable: true });

    const img2 = document.createElement("img") as HTMLImageElement;
    img2.src = "https://cdn.test.com/ch2/02.jpg";
    Object.defineProperty(img2, "naturalWidth", { value: 800, configurable: true });
    Object.defineProperty(img2, "naturalHeight", { value: 1200, configurable: true });

    reader.appendChild(img1);
    reader.appendChild(img2);
    document.body.appendChild(reader);

    const manager = new ChapterPreparationManager(mockOrchestrator);
    await manager.start({ notify: false });

    const DUMMY_PNG =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==";

    // Page 1 succeeds
    Registry.setRenderedResult(img1.src, { renderedUrl: DUMMY_PNG });
    Registry.markDone(img1.src);
    // Page 2 fails (emits idle status)
    Registry.markIdle(img2.src);
    await new Promise((r) => setTimeout(r, 20));

    const current = manager.getProgress();
    expect(current.status).toBe("partial");
    expect(current.completed).toBe(1);
    expect(current.failed).toBe(1);
    expect(current.discovered).toBe(2);

    manager.destroy();
  });

  it("never marks ready if queue is empty but pages failed", async () => {
    const reader = document.createElement("div");
    reader.className = "reader-container";

    const img1 = document.createElement("img") as HTMLImageElement;
    img1.src = "https://cdn.test.com/ch3/01.jpg";
    Object.defineProperty(img1, "naturalWidth", { value: 800, configurable: true });
    Object.defineProperty(img1, "naturalHeight", { value: 1200, configurable: true });

    reader.appendChild(img1);
    document.body.appendChild(reader);

    const manager = new ChapterPreparationManager(mockOrchestrator);
    await manager.start({ notify: false });

    // Page fails
    Registry.markIdle(img1.src);

    const current = manager.getProgress();
    expect(current.status).toBe("failed");
    expect(current.status).not.toBe("ready");
    expect(current.failed).toBe(1);
    expect(current.completed).toBe(0);

    manager.destroy();
  });
});
