import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "node",
    server: {
      deps: {
        // Keep Effect's helpers and Vite+'s bundled Vitest in one module graph.
        inline: ["@effect/vitest", "vite-plus"],
      },
    },
  },
});
