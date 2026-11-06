// Mobile UX audit of the production build at 390x844 (touch emulation).
//   npm run build && npm run audit:mobile [-- --json]
// For each route it reports:
//   - horizontal overflow (the page must never scroll sideways),
//   - interactive elements whose effective touch target is under 44x44 px
//     (a positioned ::before that enlarges the hit area counts),
//   - browser console errors.
// Elements inside [data-touch-exempt] are skipped (inline prose links).
// Exits 1 if any route has an issue.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const PORT = 4321;
const base = `http://127.0.0.1:${PORT}`;
const json = process.argv.includes("--json");
const MIN = 44;

const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { stdio: ["ignore", "pipe", "inherit"], detached: true });
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
const report = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await ctx.clock.setFixedTime(new Date("2026-11-04T12:00:00Z"));
  const page = await ctx.newPage();
  let errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto(`${base}/?live=0`, { waitUntil: "networkidle" });
  const mint = (await page.locator('a[href^="/coin/"]').first().getAttribute("href"))?.split("/coin/")[1];
  const routes = ["/", "/explore", "/leaderboard", "/portfolio", "/search", "/create", `/coin/${mint}`, "/parabull-token", "/holder-rewards", "/live", "/admin"];

  for (const route of routes) {
    errors = [];
    await page.goto(`${base}${route}?live=0`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    const r = await page.evaluate((MIN) => {
      const doc = document.documentElement;
      // clientWidth, not innerWidth: with mobile emulation an overflowing page widens the layout viewport, and innerWidth grows with it.
      const vw = doc.clientWidth;
      const overflowX = doc.scrollWidth > vw + 1;
      const wide = [];
      if (overflowX) {
        for (const el of document.querySelectorAll("body *")) {
          const b = el.getBoundingClientRect();
          if (b.width > 0 && b.right > vw + 1 && getComputedStyle(el).position !== "fixed") {
            // Report the outermost offenders only.
            if (!wide.some((w) => w.el.contains(el))) wide.push({ el, right: Math.round(b.right) });
          }
          if (wide.length > 8) break;
        }
      }
      const describe = (el) => {
        const label = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
        return `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""} "${label}"`;
      };
      const visible = (el) => {
        const s = getComputedStyle(el);
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && s.visibility !== "hidden" && s.pointerEvents !== "none" && Number(s.opacity) > 0;
      };
      const small = [];
      const sel = 'a[href], button, [role="tab"], [role="button"], input:not([type="hidden"]), select, textarea, summary';
      for (const el of document.querySelectorAll(sel)) {
        if (el.closest("[data-touch-exempt]") || !visible(el)) continue;
        // Controls nested inside a qualifying control (e.g. a button's inner input) are covered by it.
        const b = el.getBoundingClientRect();
        let w = b.width;
        let h = b.height;
        const pre = getComputedStyle(el, "::before");
        if (pre.content !== "none" && pre.position === "absolute") {
          w = Math.max(w, parseFloat(pre.width) || 0);
          h = Math.max(h, parseFloat(pre.height) || 0);
        }
        if (w + 0.5 < MIN || h + 0.5 < MIN) small.push(`${describe(el)} ${Math.round(w)}x${Math.round(h)}`);
      }
      return { overflowX, scrollWidth: doc.scrollWidth, clientWidth: vw, wide: wide.map((w) => `${describe(w.el)} right=${w.right}`), small };
    }, MIN);
    report.push({ route, ...r, errors: [...errors] });
  }
} finally {
  await browser.close();
  stopServer();
}

let bad = 0;
for (const r of report) {
  const issues = (r.overflowX ? 1 : 0) + r.small.length + r.errors.length;
  bad += issues;
  if (json) continue;
  console.log(`\n${r.route}: ${issues ? `${issues} issue(s)` : "ok"}`);
  if (r.overflowX) console.log(`  horizontal overflow: scrollWidth ${r.scrollWidth} > ${r.clientWidth}\n    ${r.wide.join("\n    ")}`);
  if (r.small.length) console.log(`  touch targets under ${MIN}px (${r.small.length}):\n    ${r.small.slice(0, 40).join("\n    ")}${r.small.length > 40 ? `\n    ...and ${r.small.length - 40} more` : ""}`);
  if (r.errors.length) console.log(`  console errors:\n    ${r.errors.join("\n    ")}`);
}
if (json) console.log(JSON.stringify(report, null, 1));
process.exit(bad ? 1 : 0);
