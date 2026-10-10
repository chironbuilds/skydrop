import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  plugins: [wasm()],
  build: { target: "esnext", chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ["@tari-project/ootle-wasm", "@tari-project/ootle"] },
  server: { port: 5190 },
});
