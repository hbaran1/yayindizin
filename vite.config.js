import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/evidence": "http://127.0.0.1:8787",
      "/reports": "http://127.0.0.1:8787"
    }
  }
});
