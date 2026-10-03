import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/ws": { target: "ws://127.0.0.1:8080", ws: true },
    },
  },
  build: {
    rollupOptions: {
      input: { campaign: "index.html", arena: "arena/index.html" },
    },
  },
});
