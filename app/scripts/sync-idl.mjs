// Copy the generated IDL + TS types (target/, from `anchor build` or
// `anchor idl build`) into src/idl so the app builds without the Anchor CLI.
// `--check` fails if the committed copy differs from the generated one.
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pairs = [
  [resolve(here, "../../target/idl/parabull.json"), resolve(here, "../src/idl/parabull.json")],
  [resolve(here, "../../target/types/parabull.ts"), resolve(here, "../src/idl/parabull.ts")],
];
const check = process.argv.includes("--check");
let stale = 0;
for (const [from, to] of pairs) {
  if (!existsSync(from)) {
    console.error(`missing ${from}: run \`anchor idl build -p parabull -o target/idl/parabull.json -t target/types/parabull.ts\` first`);
    process.exit(1);
  }
  if (check) {
    const same = existsSync(to) && readFileSync(from, "utf8") === readFileSync(to, "utf8");
    if (!same) {
      console.error(`${to} is out of date with ${from}; run \`npm run sync-idl\` in app/`);
      stale++;
    }
  } else {
    copyFileSync(from, to);
    console.log(`copied ${from} -> ${to}`);
  }
}
process.exit(stale ? 1 : 0);
