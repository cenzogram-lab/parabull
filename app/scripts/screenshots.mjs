// Captures every page of the production build with Playwright.
//   npm run build && npm run screenshots -- [outDir]
// Serves dist/ with `vite preview`, freezes the demo simulation (?live=0) so
// shots are deterministic, and writes PNGs to outDir (default: screenshots/).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const out = resolve(process.argv[2] ?? "screenshots");
mkdirSync(out, { recursive: true });
const PORT = 4317;
const base = `http://127.0.0.1:${PORT}`;

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
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.25, colorScheme: "dark" });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

async function settle() {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
}
async function shot(name, path, { full = false, before } = {}) {
  await page.goto(`${base}${path}${path.includes("?") ? "&" : "?"}live=0`, { waitUntil: "networkidle" });
  if (before) await before();
  await settle();
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: full });
  console.log(`saved ${name}.png`);
}

await shot("01-board-terminal-pro", "/");
await shot("02-explore", "/explore");
let kingMint = "";
await shot("03-coin-terminal", "/", {
  before: async () => {
    await page.getByRole("link", { name: /^Trade \$/ }).first().click();
    await page.waitForURL(/\/coin\//);
    kingMint = page.url().split("/coin/")[1].split("?")[0];
  },
});
await page.goto(`${base}/coin/${kingMint}?live=0`, { waitUntil: "networkidle" });
await settle();
await page.screenshot({ path: `${out}/03-coin-terminal.png` });
await page.screenshot({ path: `${out}/04-coin-terminal-full.png`, fullPage: true });
console.log("saved 03/04 coin terminal");
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

} finally {
  await browser.close();
  stopServer();
}
if (errors.length) {
  console.error(`browser errors:\n${errors.join("\n")}`);
  process.exit(1);
}
