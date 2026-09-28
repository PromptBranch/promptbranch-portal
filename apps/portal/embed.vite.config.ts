import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: appRoot,
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL("./public", import.meta.url)),
    emptyOutDir: false,
    cssCodeSplit: false,
    lib: {
      entry: fileURLToPath(new URL("./src/embed/widget.ts", import.meta.url)),
      name: "PromptBranchEmbed",
      formats: ["iife"],
      fileName: () => "embed.js",
    },
    rollupOptions: {
      output: { assetFileNames: "embed.css" },
    },
  },
});
