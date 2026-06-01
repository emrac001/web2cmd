import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// During dev the API + WS run on the server package (port 8787); proxy to it so the app
// is reachable on a single origin (and through the tunnel) in production.
//
// `base` defaults to "/" (served at root by the server / the .exe). For GitHub Pages project
// hosting, set WEB2CMD_BASE=/<repo>/ at build time so assets resolve under the subpath.
export default defineConfig({
  base: process.env.WEB2CMD_BASE || "/",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
