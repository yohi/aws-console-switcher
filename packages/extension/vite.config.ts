import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config.js";

/**
 * MV3 拡張のビルド構成（Service Worker / Content Scripts / Popup を分離してバンドル）。
 * `@acs/shared` は共有契約のソースへ alias し、ビルド順依存を避けて Vite が直接トランスパイルする。
 */
export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      "@acs/shared": fileURLToPath(
        new URL("../shared/src/index.ts", import.meta.url),
      ),
    },
  },
  plugins: [crx({ manifest })],
  build: {
    target: "esnext",
    sourcemap: mode === "development",
    emptyOutDir: true,
  },
}));
