import { defineConfig } from "electron-vite";
import path from "node:path";

function ignoreReactQueryUseClientWarnings(warning, warn) {
  if (
    warning.code === "MODULE_LEVEL_DIRECTIVE" &&
    typeof warning.message === "string" &&
    warning.message.includes('"use client"')
  ) {
    return;
  }
  warn(warning);
}

export default defineConfig({
  main: {
    build: {
      outDir: "dist/main",
      rollupOptions: {
        onwarn: ignoreReactQueryUseClientWarnings,
      },
    },
    resolve: {
      alias: {
        "@main": path.resolve(__dirname, "src/main"),
      },
    },
  },
  preload: {
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        onwarn: ignoreReactQueryUseClientWarnings,
      },
    },
    resolve: {
      alias: {
        "@preload": path.resolve(__dirname, "src/preload"),
      },
    },
  },
  renderer: {
    root: path.resolve(__dirname, "src/renderer"),
    build: {
      outDir: path.resolve(__dirname, "dist/renderer"),
      rollupOptions: {
        onwarn: ignoreReactQueryUseClientWarnings,
      },
    },
    resolve: {
      alias: {
        "@renderer": path.resolve(__dirname, "src/renderer"),
      },
    },
  },
});
