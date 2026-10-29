import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";
import pkg from "./package.json";

// See https://wxt.dev/api/config.html
export default defineConfig({
  vite: () => ({
    plugins: [tailwindcss() as any],
    build: {
      target: "esnext",
      minify: import.meta.env.PROD ? "terser" : "esbuild",
    },
  }),

  manifest: ({ browser }) => ({
    name: "Libre Manga Translator",
    version_name: pkg.version,
    description: "Free Privacy-focused AI manga translator: local WebGPU, Gemini cloud, or self-hosted LLM",
    permissions: [
      "activeTab",
      "offscreen",
      "storage",
      "unlimitedStorage",
      "declarativeNetRequest",
      "notifications",
    ],
    host_permissions: ["<all_urls>"],
    web_accessible_resources: [
      {
        resources: [
          "/offscreen.html",
          "/setup.html",
          "/content-scripts/*",
          "/*.wasm",
          "/*.mjs",
          "/dicts/*",
          "/fonts/*",
          "/icon/*",
        ],
        matches: ["<all_urls>"],
      },
    ],
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    ...(browser === "firefox" && {
      browser_specific_settings: {
        gecko: {
          id: "libremangatranslator@lmt.tmp",
          strict_min_version: "148.0",
        },
      },
    }),
  }),

  srcDir: "src",
  modules: ["@wxt-dev/module-svelte"],
  webExt: {
    chromiumArgs: [
      "--enable-unsafe-webgpu",
      "--ozone-platform=x11",
      "--use-angle=vulkan",
      "--enable-features=Vulkan,VulkanFromANGLE",
      "--user-data-dir=./.wxt/chrome-data",
    ],
  },
});
