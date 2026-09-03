import { defineConfig } from "tsup";

export default defineConfig({
  entry: { bench: "scripts/bench.ts" },
  format: ["esm"],
  target: "node18",
  platform: "node",
  outDir: "dist",
  clean: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
