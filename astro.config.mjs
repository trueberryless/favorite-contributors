// @ts-check
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  site: "https://favorite-contributors.netlify.app",
  experimental: {
    incrementalBuild: true,
  }
});
