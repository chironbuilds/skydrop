import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";

export default defineConfig(({ mode }) => ({
  plugins: [wasm()],
  define: { __SKYDROP_NETWORK__: JSON.stringify(mode === "mainnet" ? "mainnet" : "esmeralda") },
  build: { target: "esnext", chunkSizeWarningLimit: 4000, rollupOptions: { input: { main: "index.html", quests: "quests.html" } } },
  optimizeDeps: { exclude: ["@tari-project/ootle-wasm", "@tari-project/ootle"] },
  server: { port: 5190 },
}));
