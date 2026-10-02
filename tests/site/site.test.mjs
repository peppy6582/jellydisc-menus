// Builds the site from a hostile catalogue and checks that nothing a menu says can become markup, that every
// page carries the content-security policy, and that nothing loads from outside. Run: npm test
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const EVIL = [
  `<img src=x onerror=alert(1)>`,
  `<script>alert(2)</script>`,
  `"><svg onload=alert(3)>`,
  `</pre><script>alert(4)</script>`,
];

function fixture(dir) {
  const id = "11111111-2222-4333-8444-555555555555";
  const menu = {
    schemaVersion: 1, menuId: id, revision: 1,
    meta: { author: EVIL[0], notes: EVIL[3] },
    match: { itemType: "Movie", providerIds: { Tmdb: "1" } },
    menus: { main: { title: EVIL[1], entries: [{ label: EVIL[2], action: "play" }, { label: EVIL[0], action: "play" }] } },
  };
  const raw = JSON.stringify(menu, null, 2);
  fs.mkdirSync(path.join(dir, "v1", "menus", id), { recursive: true });
  fs.mkdirSync(path.join(dir, "schema"), { recursive: true });
  fs.writeFileSync(path.join(dir, "v1", "menus", id, "1.menu.json"), raw);
  const index = {
    format: "jellydisc-catalogue", formatVersion: 1, generated: "2026-10-02T00:00:00Z", menuSchemaVersions: [1],
    baseUrl: "https://example.test/", licence: "CC0-1.0", attribution: "x", withdrawn: [],
    entries: [{
      menuId: id, revision: 1, menuSchemaVersion: 1, minPluginVersion: "0.1.0",
      title: EVIL[0], originalTitle: EVIL[1], match: menu.match,
      author: { name: EVIL[2], github: "x\" onmouseover=\"alert(5)" }, licence: "CC0-1.0",
      tags: [EVIL[2], "ok"], description: EVIL[1], url: `v1/menus/${id}/1.menu.json`,
      sha256: crypto.createHash("sha256").update(raw).digest("hex"), size: raw.length,
      features: [EVIL[0]], needsLocalArt: [EVIL[3]], demo: false, page: `menus/${id}/`,
      changelog: [{ revision: 1, date: "2026-10-02", notes: EVIL[0] }],
    }],
  };
  fs.writeFileSync(path.join(dir, "v1", "index.json"), JSON.stringify(index));
}

function pages(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "v1" && e.name !== "pagefind") out.push(...pages(p)); }
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "site-test-"));
const cat = path.join(tmp, "cat"), out = path.join(tmp, "out");
fixture(cat);
execFileSync("npx", ["eleventy", `--output=${out}`], { cwd: ROOT, env: { ...process.env, CATALOGUE_DIR: cat }, stdio: "pipe" });
const files = pages(out);
const html = Object.fromEntries(files.map((f) => [path.relative(out, f), fs.readFileSync(f, "utf8")]));

test("the hostile menu's page was built", () => {
  assert.ok(html["menus/11111111-2222-4333-8444-555555555555/index.html"]);
  assert.ok(files.length >= 8);
});

test("menu text never appears as markup", () => {
  for (const [name, text] of Object.entries(html)) {
    assert.ok(!/<img src=x/i.test(text), `${name}: raw <img>`);
    assert.ok(!/<svg onload/i.test(text), `${name}: raw <svg>`);
    assert.ok(!/alert\(\d\)<\/script>/.test(text), `${name}: raw script body`);
    assert.ok(!/onmouseover="/i.test(text), `${name}: attribute injection`);
    assert.ok(!/<\/pre><script/i.test(text), `${name}: pre break-out`);
  }
  const page = html["menus/11111111-2222-4333-8444-555555555555/index.html"];
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("every page has the content-security policy and no inline script", () => {
  for (const [name, text] of Object.entries(html)) {
    assert.match(text, /http-equiv="Content-Security-Policy"/, name);
    assert.match(text, /script-src 'self'/, name);
    for (const m of text.matchAll(/<script\b[^>]*>/gi)) assert.match(m[0], /\ssrc="/, `${name}: inline script ${m[0]}`);
    assert.ok(!/\sstyle="/i.test(text), `${name}: inline style`);
    assert.ok(!/<[^>]*\son[a-z]+=/i.test(text.replace(/"[^"]*"/g, "\"\"")), `${name}: event handler attribute`);
  }
});

test("nothing is loaded from outside the site", () => {
  for (const [name, text] of Object.entries(html)) {
    for (const m of text.matchAll(/\b(?:src|action)="([^"]*)"/g)) assert.ok(!/^(https?:)?\/\//.test(m[1]), `${name}: ${m[0]}`);
    for (const m of text.matchAll(/<link\b[^>]*href="([^"]*)"/g)) assert.ok(!/^(https?:)?\/\//.test(m[1]), `${name}: ${m[0]}`);
  }
});

test("internal links keep the site's path prefix", () => {
  for (const [name, text] of Object.entries(html)) {
    for (const m of text.matchAll(/\b(?:href|src)="(\/[^"]*)"/g)) {
      assert.ok(m[1].startsWith("/jellydisc-menus/"), `${name}: ${m[1]}`);
    }
  }
});

test("a menu that doesn't match its hash stops the build", () => {
  const bad = path.join(tmp, "bad");
  fixture(bad);
  fs.appendFileSync(path.join(bad, "v1", "menus", "11111111-2222-4333-8444-555555555555", "1.menu.json"), " ");
  assert.throws(() => execFileSync("npx", ["eleventy", `--output=${path.join(tmp, "out2")}`], { cwd: ROOT, env: { ...process.env, CATALOGUE_DIR: bad }, stdio: "pipe" }));
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("the preview frames: strict by default, TMDB images only in the variant a visitor opts into", () => {
  const strict = html["preview/frame/index.html"], tmdb = html["preview/frame-tmdb/index.html"];
  assert.ok(strict && tmdb);
  assert.ok(!strict.includes("image.tmdb.org"));
  assert.match(tmdb, /img-src 'self' data: https:\/\/image\.tmdb\.org;/);
  for (const text of [strict, tmdb]) {
    assert.match(text, /connect-src 'self' data:/);
    assert.match(text, /frame-src 'none'/);
    assert.match(text, /script-src 'self';/);
    assert.ok(!/unsafe-/.test(text));
  }
});

test("a menu page embeds its preview without opening it to anything else", () => {
  const page = html["menus/11111111-2222-4333-8444-555555555555/index.html"];
  assert.match(page, /id="preview-frame"/);
  assert.match(page, /data-menu="v1\/menus\/11111111-2222-4333-8444-555555555555\/1\.menu\.json"/);
  assert.ok(!/<iframe[^>]*\ssrc=/.test(page), "the frame's address is set by script from a validated path");
  assert.ok(!page.includes("image.tmdb.org"));
});

test("share tags and the icon are present and escape hostile text", () => {
  const page = html["menus/11111111-2222-4333-8444-555555555555/index.html"];
  assert.match(page, /<link rel="icon" href="\/jellydisc-menus\/assets\/favicon\.svg"/);
  assert.match(page, /<meta property="og:title" content="&lt;img src=x onerror=alert\(1\)&gt;"/);
  assert.match(page, /<title>&lt;img src=x onerror=alert\(1\)&gt; · Disc Menus catalogue<\/title>/);   // once, not &amp;lt;
  assert.ok(!/&amp;(lt|gt|quot|#39);/.test(page), "text is escaped twice somewhere");
  assert.match(page, /<meta property="og:image" content="https:\/\/[^"]+\/assets\/thumbs\/11111111-2222-4333-8444-555555555555\.jpg"/);
  for (const [name, text] of Object.entries(html)) {
    assert.ok(!/<meta[^>]*content="[^"]*"\s*onerror/i.test(text), name);
    for (const m of text.matchAll(/<img\b[^>]*>/gi)) assert.match(m[0], /\salt="/, `${name}: image without alt text`);
  }
});
