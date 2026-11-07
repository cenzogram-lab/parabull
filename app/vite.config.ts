import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { headersFile } from "./src/lib/icHeaders";

/**
 * Writes `dist/_headers` for Internet Computer hosting (icp.yaml, @dfinity/static-site): security headers and a CSP
 * whose connect-src includes this build's configured endpoints. `public/_redirects` holds the SPA routing.
 */
function icHeaders(mode: string): Plugin {
  return {
    name: "parabull-ic-headers",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_headers", source: headersFile(loadEnv(mode, process.cwd(), "VITE_")) });
    },
  };
}

/**
 * The wallet modal's stylesheet @imports DM Sans from Google Fonts, but src/index.css restyles every wallet element in
 * the bundled Inter, so the font is never shown. Dropping the import keeps visitors' browsers off fonts.googleapis.com
 * and lets the CSP stay at style-src 'self'.
 */
function dropWalletUiGoogleFonts(): Plugin {
  return {
    name: "parabull-drop-wallet-ui-google-fonts",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("wallet-adapter-react-ui/styles.css")) return null;
      return { code: code.replace(/@import\s+url\(\s*['"]?https:\/\/fonts\.googleapis\.com[^)]*\)\s*;?/g, ""), map: null };
    },
  };
}

// web3.js and Anchor expect Node's `global` and `Buffer`; src/polyfills.ts
// installs Buffer, and `global` is aliased to globalThis here.
export default defineConfig(({ mode }) => ({
  plugins: [dropWalletUiGoogleFonts(), react(), icHeaders(mode)],
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
}));
