// Captures the production build with Playwright.
//   npm run build && npm run screenshots -- [outDir] [--mobile]
// Serves dist/ with `vite preview`, freezes the clock and the demo
// simulation (?live=0) so captures are pixel-stable, and writes PNGs to
// outDir (default: screenshots/). --mobile captures a 390x844 touch viewport.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const args = process.argv.slice(2);
const mobile = args.includes("--mobile");
const out = resolve(args.find((a) => !a.startsWith("--")) ?? "screenshots");
mkdirSync(out, { recursive: true });
const PORT = mobile ? 4319 : 4317;
const base = `http://127.0.0.1:${PORT}`;
/** Every capture runs at this instant, so ages, countdowns and candles never drift between runs. */
const FIXED_TIME = new Date("2026-11-04T12:00:00Z");

const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { stdio: ["ignore", "pipe", "inherit"], detached: true });
// Kill the whole process group (npx -> sh -> vite) on any exit path.
const stopServer = () => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    // already gone
  }
};
process.on("exit", stopServer);
await new Promise((ok, fail) => {
  const t = setTimeout(() => fail(new Error("vite preview did not start")), 30_000);
  server.stdout.on("data", (d) => String(d).includes(String(PORT)) && (clearTimeout(t), ok()));
});

const browser = await chromium.launch();
const errors = [];
try {
  const ctx = await browser.newContext(
    mobile
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark" }
      : { viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.25, colorScheme: "dark" },
  );
  await ctx.clock.setFixedTime(FIXED_TIME);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  const settle = async () => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700);
  };
  const shot = async (name, path, { full = false, before } = {}) => {
    await page.goto(`${base}${path}${path.includes("?") ? "&" : "?"}live=0`, { waitUntil: "networkidle" });
    if (before) await before();
    await settle();
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: full, animations: "disabled" });
    console.log(`saved ${name}.png`);
  };
  const kingMint = async () => {
    await page.goto(`${base}/?live=0`, { waitUntil: "networkidle" });
    const href = await page.locator('a[href^="/coin/"]').first().getAttribute("href");
    return href.split("/coin/")[1];
  };

  if (mobile) {
    await shot("m01-board", "/");
    await shot("m02-board-scrolled", "/", { before: async () => page.mouse.wheel(0, 900) });
    await shot("m03-explore", "/explore");
    await shot("m04-leaderboard", "/leaderboard");
    await shot("m05-leaderboard-full", "/leaderboard", { full: true });
    await shot("m06-portfolio", "/portfolio");
    await shot("m07-portfolio-full", "/portfolio", { full: true });
    await shot("m08-search", "/search");
    await shot("m09-search-results", "/search", {
      before: async () => {
        await page.getByPlaceholder("Search anything...", { exact: true }).fill("bull");
      },
    });
    await shot("m10-create", "/create");
    const mint = await kingMint();
    await shot("m11-coin", `/coin/${mint}`);
    await shot("m12-coin-full", `/coin/${mint}`, { full: true });
    await shot("m13-parabull-token", "/parabull-token");
    await shot("m14-holder-rewards", "/holder-rewards");
    await shot("m15-live", "/live");
  } else {
    await shot("01-board-terminal-pro", "/");
    await shot("02-explore", "/explore");
    const mint = await kingMint();
    await shot("03-coin-terminal", `/coin/${mint}`);
    await shot("04-coin-terminal-full", `/coin/${mint}`, { full: true });
    await shot("05-launch-modal", "/", {
      before: async () => {
        await page.getByRole("button", { name: "Start a Coin", exact: true }).click();
        await page.getByPlaceholder("Bronze Bull", { exact: true }).fill("P.E.P.E-coin Bull");
        await page.getByPlaceholder("BRONZE", { exact: true }).fill("pepebull");
        await page.getByPlaceholder("What's the story?").fill("The bull that only charges up. Locked ticker, locked name, verified tweet.");
        await page.getByPlaceholder("https://x.com/you/status/1850000000000000000").fill("https://x.com/parabull/status/1850000000000000000");
      },
    });
    await shot("06-leaderboard", "/leaderboard");
    await shot("07-live", "/live");
    await shot("08-holder-rewards", "/holder-rewards");
    await shot("09-parabull-token", "/parabull-token", { full: true });
    await shot("10-board-classic", "/", {
      before: async () => {
        await page.getByRole("button", { name: "Switch workspace layout", exact: true }).click();
      },
    });
    await shot("11-launch-delay", "/", {
      before: async () => {
        await page.getByRole("button", { name: "Switch workspace layout", exact: true }).click();
        await page.getByRole("button", { name: "Start a Coin", exact: true }).click();
        await page.getByPlaceholder("Bronze Bull", { exact: true }).fill("Copper Calf");
        await page.getByPlaceholder("BRONZE", { exact: true }).fill("CCALF");
        await page.getByRole("button", { name: /^Launch for/ }).click();
        await page.waitForTimeout(2600);
      },
    });
  }
} finally {
  await browser.close();
  stopServer();
}
if (errors.length) {
  console.error(`browser errors:\n${errors.join("\n")}`);
  process.exit(1);
}
