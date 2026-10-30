export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  world: "MAIN",
  main() {
    // Prevent canvas tainting on canvas-based manga readers (e.g. GigaViewer /
    // Sunday Webry / Shonen Jump+ / Comic Days) whose CDN supports CORS, but
    // whose viewer script creates `new Image()` without setting `crossOrigin`.
    // Includes an automatic one-shot error fallback that strips `crossorigin`
    // and reloads if a server does not send CORS headers.
    try {
      const applyCorsWithFallback = (img: HTMLImageElement, srcVal: string) => {
        if (!srcVal || (img as any).__lmt_no_cors || img.crossOrigin) return;
        try {
          const resolved = new URL(srcVal, window.location.href);
          if (
            (resolved.protocol === "http:" || resolved.protocol === "https:") &&
            resolved.origin !== window.location.origin
          ) {
            img.crossOrigin = "anonymous";
            img.addEventListener(
              "error",
              function onCorsErr() {
                img.removeEventListener("error", onCorsErr);
                if (img.crossOrigin === "anonymous") {
                  (img as any).__lmt_no_cors = true;
                  img.removeAttribute("crossorigin");
                  img.src = srcVal;
                }
              },
              { once: true },
            );
          }
        } catch {
          // Ignore malformed URLs
        }
      };

      const desc = Object.getOwnPropertyDescriptor(
        HTMLImageElement.prototype,
        "src",
      );
      if (desc && desc.set && desc.get) {
        Object.defineProperty(HTMLImageElement.prototype, "src", {
          configurable: true,
          enumerable: desc.enumerable,
          get: desc.get,
          set(val: string) {
            applyCorsWithFallback(this, String(val));
            desc.set!.call(this, val);
          },
        });
      }
    } catch {
      // Never break page execution
    }

    // ── M1.4.3: Reader Chapter Page List Bridge (Comix.to & Encrypted Readers) ──
    // Runs at document_start in MAIN world. Hook TextDecoder and atob to capture
    // decrypted chapter manifests the moment they arrive, without requiring DOM
    // elements to be mounted on screen or user scrolling.
    try {
      let capturedPages: Array<{
        src: string;
        url?: string;
        pageNumber: number;
        pageIndex: number;
        width?: number;
        height?: number;
      }> | null = null;

      const publishCapturedPages = (
        pages: Array<{
          src: string;
          url?: string;
          pageNumber: number;
          pageIndex: number;
          width?: number;
          height?: number;
        }>,
      ) => {
        const normalized = pages.map((p) => ({
          ...p,
          url: p.url || p.src,
        }));
        capturedPages = normalized;
        try {
          (window as any).__lmt_captured_pages = normalized;
          document.documentElement?.setAttribute(
            "data-lmt-captured-pages",
            JSON.stringify(normalized),
          );
          window.dispatchEvent(
            new CustomEvent("lmt:pages-captured", { detail: { pages: normalized } }),
          );
        } catch {}
      };

      const tryCapture = (s: any) => {
        if (
          capturedPages ||
          typeof s !== "string" ||
          s.length < 50 ||
          (s.indexOf('"pages"') === -1 &&
            s.indexOf('"hL"') === -1 &&
            s.indexOf('"items"') === -1)
        ) {
          return;
        }

        try {
          const j = JSON.parse(s);
          const r = (j && j.result) || j;
          const p = r && (r.pages || r.hL || r.items || r.images);
          let items: any[] | null = null;
          let baseUrl = "";

          if (p && Array.isArray(p.items)) {
            items = p.items;
            baseUrl = p.baseUrl || "";
          } else if (p && Array.isArray(p)) {
            items = p;
            baseUrl = (r.pages && r.pages.baseUrl) || r.baseUrl || "";
          } else if (Array.isArray(r)) {
            items = r;
          }

          if (!items || !items.length) return;

          const out: Array<{
            src: string;
            pageNumber: number;
            pageIndex: number;
            width?: number;
            height?: number;
          }> = [];

          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (!it) continue;
            const u =
              it.url ||
              it.Bn ||
              it.src ||
              it.image ||
              (typeof it === "string" ? it : null);
            if (typeof u === "string" && u) {
              const fullSrc = /^https?:/i.test(u) ? u : baseUrl + u;
              out.push({
                src: fullSrc,
                pageNumber: i + 1,
                pageIndex: i,
                width: it.vx || it.width || 0,
                height: it.fG || it.height || 0,
              });
            }
          }

          if (out.length > 0) {
            publishCapturedPages(out);
            restoreDecoders();
          }
        } catch {}
      };

      const TD = window.TextDecoder && window.TextDecoder.prototype;
      const nativeDecode = TD && TD.decode;
      const nativeAtob = window.atob;
      let decodeHook: any;
      let atobHook: any;

      function restoreDecoders() {
        try {
          if (TD && TD.decode === decodeHook) TD.decode = nativeDecode;
          if (window.atob === atobHook) window.atob = nativeAtob;
        } catch {}
      }

      if (TD && TD.decode) {
        const orig = TD.decode;
        decodeHook = function (this: any) {
          const r = orig.apply(this, arguments as any);
          try {
            tryCapture(r);
          } catch {}
          return r;
        };
        TD.decode = decodeHook;
      }

      if (typeof window.atob === "function") {
        const oa = window.atob;
        atobHook = function (this: any) {
          const r = oa.apply(this, arguments as any);
          try {
            tryCapture(r);
          } catch {}
          return r;
        };
        window.atob = atobHook;
      }

      window.addEventListener("lmt:request-captured-pages", () => {
        if (capturedPages) {
          publishCapturedPages(capturedPages);
        }
      });
    } catch {
      // Never break page execution
    }
  },
});
