import "vite-plus/test/config";

import * as NodeURL from "node:url";

import { defineConfig } from "vite-plus";

const contractsSource = NodeURL.fileURLToPath(new URL("../contracts/src/", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@t3tools\/contracts$/u,
        replacement: `${contractsSource}/index.ts`,
      },
      {
        find: /^@t3tools\/contracts\/cloud$/u,
        replacement: `${contractsSource}/cloud.ts`,
      },
    ],
  },
  test: {
    environment: "node",
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
