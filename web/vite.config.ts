import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";

export default defineConfig(({ mode }) => ({
  plugins: [wasm()],
  define: { __SKYDROP_NETWORK__: JSON.stringify(mode === "mainnet" ? "mainnet" : "esmeralda") },
  // The older app at / runs a built-in wallet against the testnet, so mainnet ships only the campaign pages.
  build: { target: "esnext", chunkSizeWarningLimit: 4000, rollupOptions: { input: mode === "mainnet" ? { quests: "quests.html" } : { main: "index.html", quests: "quests.html" } } },
  optimizeDeps: { exclude: ["@tari-project/ootle-wasm", "@tari-project/ootle"] },
  server: { port: 5190 },
}));
