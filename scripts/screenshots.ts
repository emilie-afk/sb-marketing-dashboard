// Renders the main pages with SYNTHETIC demo data at desktop and mobile widths.
// Usage: start the dev server with LOCAL_DEV_LOGIN=1 on a seeded demo database, then
//   BASE=http://127.0.0.1:8899 OUT=docs/screenshots SCALE=2 npm run screenshots
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://127.0.0.1:8899";
const OUT = process.env.OUT ?? "docs/screenshots";
const SCALE = Number(process.env.SCALE ?? 2);
const ONLY = process.env.ONLY?.split(",");
const PAGES: [string, string][] = [
  ["overview", "#/"], ["sb-vendors", "#/sb/vendors"], ["sb-advertising", "#/sb/advertising"], ["sb-promotions", "#/sb/promotions"],
  ["p2s-listing-reviews", "#/p2s/listing-reviews"], ["perksradar", "#/perksradar"], ["calendar", "#/calendar"], ["tasks", "#/tasks"],
  ["reports", "#/reports"], ["toolbox", "#/toolbox"], ["settings", "#/settings"],
];
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
for (const [w, h, tag] of [[1366, 900, "desktop"], [390, 844, "mobile"]] as const) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: SCALE });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/dev/login?role=admin`);
  for (const [name, hash] of PAGES) {
    if (ONLY && !ONLY.includes(name)) continue;
    await page.goto(`${BASE}/${hash}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);
    // Horizontal overflow check: the page itself must not scroll sideways.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 1) console.warn(`${tag} ${name}: page overflows horizontally by ${overflow}px`);
    await page.screenshot({ path: `${OUT}/${tag}-${name}.png`, fullPage: tag === "desktop" || name === "overview" });
  }
  if (errors.length) console.warn(`${tag} page errors:`, errors);
  await ctx.close();
}
await browser.close();
console.log("screenshots written to", OUT);
