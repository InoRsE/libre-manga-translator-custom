// Comix - https://comix.to
// Reader URL:
//   https://comix.to/title/5v53l-mairimashita-iruma-kun/11304814-chapter-457
// Title: "Mairimashita! Iruma-kun · Ch.457"
//
// Long-strip reader: all pages share one URL and title, so pageIndex
// intentionally never matches and stays 0 - the page cache and
// series-context key degrade to chapter level on this site.

import type { SiteRule } from "../adapters";

const comixRule: SiteRule = {
  id: "comix",
  domain: "comix.to",
  seriesName: {
    regex: "^(.*?)\\s*·\\s*Ch\\.",
    source: "title",
  },
  chapterId: {
    regex: "(?:-chapter-|·\\s*Ch\\.)([\\d.]+)",
    source: "path",
  },
  pageIndex: {
    regex: "^$",
    source: "path",
  },
  containerSelector: ".reader-container, #reader, .reader, #chapter-images, [data-reader], .comic-container, .comic-pages, main",
  imageSelector: ".rpage-page__img, .reader-container img, .chapter-images img, #reader img, .reader img, #chapter-images img, [data-reader] img, .comic-container img, .comic-pages img, main img",
  pageCountSelector: "[class*='page-total'], [class*='total-pages'], [data-total-pages], select[name='page'], .pagination, [class*='pages-count'], select.page-select, [class*='counter'], [data-page]",
  expectedCountRegex: "(?:\\/|of)\\s*(\\d+)",
  pillPosition: "top-left",
  toolbarPosition: "top-left",
};

export default comixRule;
