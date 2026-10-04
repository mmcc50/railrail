import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: {
      "/api": "http://localhost:8080",
      "/sub": {
        target: "http://localhost:8080",
        // In production the server answers browser navigations to a subscription
        // URL with the SPA (which renders the client page). Forward only real
        // config/API requests (json, clash, singbox, raw links) in dev.
        bypass: (req) =>
          req.headers["sec-fetch-mode"] === "navigate" ? req.url : undefined,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
