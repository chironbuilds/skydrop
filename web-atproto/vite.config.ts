import { defineConfig } from "vite";
export default defineConfig(({ mode }) => ({
  define: { __SKYDROP_NETWORK__: JSON.stringify(mode === "mainnet" ? "mainnet" : "esmeralda") },
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 900 },
}));
