import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"] },
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/v1": { target: "http://127.0.0.1:3001", changeOrigin: false } },
  },
});
