import { defineConfig } from "vite";

// The dev server proxies to the same path the built app talks to, so the app
// does not have to know whether it is being developed or deployed.
export default defineConfig({
  // Assets are referenced relative to the page rather than to the host, so a
  // build works wherever it is put: the root of a server, a subdirectory, a
  // GitHub Pages project site at `/<repo>/`. The default is `/`, which is an
  // absolute path and 404s everywhere but the root.
  base: "./",

  server: {
    proxy: {
      "/-/fetch": "http://localhost:8080",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
