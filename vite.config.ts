import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Client is built to ./dist, which the Node server (server/index.ts) serves.
// In dev, proxy the WebSocket endpoint to that Node server on :8787.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:8787",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
