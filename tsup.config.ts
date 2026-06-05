import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/cli-entry.ts"],
    format: ["esm"],
    clean: true,
    sourcemap: false,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: false,
  },
]);
