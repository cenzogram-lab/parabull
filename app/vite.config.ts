import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// web3.js and Anchor expect Node's `global` and `Buffer`; src/polyfills.ts
// installs Buffer, and `global` is aliased to globalThis here.
export default defineConfig({
  plugins: [react()],
  define: { global: "globalThis" },
  resolve: { alias: { buffer: "buffer/" } },
  optimizeDeps: { esbuildOptions: { define: { global: "globalThis" }, target: "es2022" } },
  server: {
    port: 5173,
    // The quote math is shared with scripts/ (../scripts/src/curve.ts).
    fs: { allow: [".."] },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          solana: ["@solana/web3.js", "@coral-xyz/anchor"],
          wallet: ["@solana/wallet-adapter-react", "@solana/wallet-adapter-react-ui", "@solana/wallet-adapter-base"],
          charts: ["lightweight-charts"],
        },
      },
    },
  },
});
