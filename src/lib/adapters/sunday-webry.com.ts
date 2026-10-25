import type { SiteRule } from "../adapters";

// Sunday Webry (サンデーうぇぶり) - https://www.sunday-webry.com
// Uses Hatena GigaViewer engine, rendering manga pages onto HTML5 <canvas> elements.
export default {
  id: "sunday-webry",
  domain: "sunday-webry.com",
  seriesName: {
    regex: "^(?:.*?[\\/|]\\s*)?(.*?)(?:\\s*-\\s*[^|]+)?\\s*\\|\\s*サンデーうぇぶり",
    source: "title",
  },
  chapterId: {
    regex: "\\/episode\\/([^/?#]+)",
    source: "path",
  },
  pageIndex: {
    regex: "^$",
    source: "path",
  },
  containerSelector: ".image-container, .js-viewer-content, .page-area, .js-page-area, .viewer",
  imageSelector: "canvas.page-image, canvas.js-page-image, canvas, img",
} satisfies SiteRule;
