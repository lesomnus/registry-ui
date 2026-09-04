import { defineConfig } from "vite";

// The dev server proxies to the same path the built app talks to, so the app
// does not have to know whether it is being developed or deployed.
export default defineConfig({
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
