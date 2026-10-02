// Takes a picture of each menu's real preview (the vendored renderer on generated placeholder art) for the site's cards, hero
// and share images. Run after the site is built:   node tools/thumbnails.mjs [--site _site] [--prefix /jellydisc-menus/]
//
// It serves the built site from a throwaway local server, opens each menu in headless Chromium with reduced motion (so the intro
// animation doesn't run and the result is stable), and writes <site>/assets/thumbs/<menuId>.jpg. Nothing leaves the machine and
// nothing third-party is fetched: the preview is the strict frame page, which cannot load anything else.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const site = path.resolve(opt("--site", "_site"));
const prefix = opt("--prefix", process.env.SITE_PREFIX || "/jellydisc-menus/");
const out = path.join(site, "assets", "thumbs");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".jpg": "image/jpeg" };

const index = JSON.parse(fs.readFileSync(path.join(site, "v1", "index.json"), "utf8"));
fs.mkdirSync(out, { recursive: true });

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (!p.startsWith(prefix)) { res.writeHead(404); res.end(); return; }
  p = "/" + p.slice(prefix.length);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(site, p);
  if (!file.startsWith(site) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
let failed = 0;
try {
  for (const e of index.entries) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: "reduce", deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const external = [];
    page.on("request", (r) => { const u = r.url(); if (!u.startsWith(origin) && !u.startsWith("data:")) external.push(u); });
    try {
      await page.goto(`${origin}${prefix}preview/frame/?menu=${encodeURIComponent(e.url)}`);
      await page.waitForSelector("#discMenusOverlay", { timeout: 15000 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(out, `${e.menuId}.jpg`), type: "jpeg", quality: 84 });
      if (external.length) throw new Error("the preview requested something outside the site: " + external.join(", "));
      console.log("thumbnail", e.title);
    } catch (err) {
      failed++;
      console.error(`FAILED ${e.title}: ${err.message}`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) process.exit(1);
