// The preview's browser-free logic: what may be loaded, and that nothing in a menu can make the preview fetch from
// outside. Run: npm test
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

// The file is plain browser script (this package's .js files are modules), so run it the way a page would, with a
// CommonJS-style `module` so it exports itself.
const here = path.dirname(new URL(import.meta.url).pathname);
const sandbox = { module: { exports: {} }, btoa };
vm.runInNewContext(fs.readFileSync(path.join(here, "../../site/assets/harness-core.js"), "utf8"), sandbox);
const C = sandbox.module.exports;
const ART = (seed, kind) => `data:image/png;base64,${kind}-${seed.length}`;
const ID = "0b311cdd-e7c2-4e27-b4bc-fb1e5acebfc8";

test("only a published menu file can be loaded", () => {
  assert.ok(C.validMenuPath(`v1/menus/${ID}/1.menu.json`));
  assert.ok(C.validMenuPath(`v1/menus/${ID}/12.menu.json`));
  for (const bad of [
    "", null, undefined, 5, {}, `/v1/menus/${ID}/1.menu.json`, `../v1/menus/${ID}/1.menu.json`, `v1/menus/${ID}/../1.menu.json`,
    `v1/menus/${ID}/1.menu.json?x=1`, `v1/menus/${ID}/0.menu.json`, `v1/menus/${ID.toUpperCase()}/1.menu.json`,
    `https://evil.example/v1/menus/${ID}/1.menu.json`, `//evil.example/v1/menus/${ID}/1.menu.json`, "v1/index.json",
    `v1/menus/${ID}/1.menu.json\n`, `v1/menus/not-an-id/1.menu.json`,
  ]) assert.equal(C.validMenuPath(bad), false, String(bad));
});

test("external and generated backgrounds become placeholders", () => {
  const doc = {
    Background: { Source: "tmdb", TmdbFilePath: "/a.jpg", Dim: 0.2 },
    Menus: {
      a: { Background: { Source: "jellyfin", ImageType: "Backdrop" } },
      b: { Background: { Source: "trailer" } },
      c: { Background: { Source: "image", Image: "asset:x/bg.webp" } },
      d: { Background: { Source: "image", Image: "https://evil.example/x.png" } },
      f: { Background: { Source: "fanart", FanartId: "47835" } },   // needs the owner's fanart.tv key: never on a public page
      e: { Background: { Source: "color", Color: "#123456" } },
    },
  };
  const out = C.placeholderize(doc, ART);
  assert.equal(out.Background.Source, "image");
  assert.equal(out.Background.Dim, 0.2);
  assert.match(out.Background.Image, /^data:image\/png/);
  for (const k of "abcdf") assert.match(out.Menus[k].Background.Image, /^data:image\/png/, k);
  assert.equal(JSON.stringify(out.Menus.e.Background), JSON.stringify({ Source: "color", Color: "#123456" }));
  assert.ok(!/https?:|asset:|tmdb|jellyfin|trailer/i.test(JSON.stringify(out).replace(/"Source":"image"/g, "")));
});

test("real TMDB backdrops are kept only when the visitor asked", () => {
  const doc = { Background: { Source: "tmdb", TmdbFilePath: "/a.jpg" } };
  assert.equal(C.placeholderize(doc, ART).Background.Source, "image");
  assert.equal(JSON.stringify(C.placeholderize(doc, ART, { realTmdb: true }).Background), JSON.stringify(doc.Background));
});

test("pictures on buttons and layers become placeholders, and so do external sounds", () => {
  const doc = {
    Layout: { Layers: [{ Image: "asset:x/banner.webp" }, { Image: "data:image/png;base64,AAAA" }] },
    Audio: { Music: { File: "https://evil.example/m.mp3" }, Sounds: { Move: "//evil.example/a.wav", Select: "asset:x/s.wav" } },
    Menus: { m: { Entries: [{ Image: "https://evil.example/i.png", ImageFocus: "asset:x/f.png", Label: "https://not-a-picture.example" }] } },
  };
  const out = C.placeholderize(doc, ART);
  assert.match(out.Layout.Layers[0].Image, /^data:image\/png/);
  assert.equal(out.Layout.Layers[1].Image, "data:image/png;base64,AAAA");
  assert.equal(out.Audio.Music.File, "asset:silence/none.wav");
  assert.equal(out.Audio.Sounds.Move, "asset:silence/none.wav");
  assert.equal(out.Audio.Sounds.Select, "asset:x/s.wav");
  assert.match(out.Menus.m.Entries[0].Image, /^data:image\/png/);
  assert.match(out.Menus.m.Entries[0].ImageFocus, /^data:image\/png/);
  assert.equal(out.Menus.m.Entries[0].Label, "https://not-a-picture.example"); // text is text
});

test("the input is not modified and __proto__ is never copied", () => {
  const doc = JSON.parse('{"Background":{"Source":"tmdb"},"__proto__":{"polluted":1},"Menus":{}}');
  const before = JSON.stringify(doc);
  const out = C.placeholderize(doc, ART);
  assert.equal(JSON.stringify(doc), before);
  assert.equal(Object.getPrototypeOf(out), vm.runInContext("Object.prototype", sandbox)); // an ordinary object, not one with a swapped prototype
  assert.equal(out.polluted, undefined);
  assert.equal(({}).polluted, undefined);
});

test("the stand-in ApiClient can only produce silence or nothing", () => {
  const silence = C.silentWav();
  const api = C.fakeApiClient(silence);
  assert.equal(api.getUrl("DiscMenus/Assets/silence/none.wav"), silence);
  assert.equal(api.getUrl("DiscMenus/Assets/x/ambient.ogg"), silence);
  assert.equal(api.getUrl("Audio/abc/stream", { static: true }), silence);
  assert.equal(api.getUrl("DiscMenus/Assets/x/background.webp"), "");
  assert.equal(api.getUrl("Videos/abc/stream"), "");
  assert.equal(api.getImageUrl("id", {}), "");
  assert.equal(api.accessToken(), "");
  return Promise.all([api.getJSON("Sessions"), api.ajax({})]);
});

test("the silent sound is a well-formed WAV", () => {
  const url = C.silentWav();
  assert.match(url, /^data:audio\/wav;base64,/);
  const bytes = Buffer.from(url.split(",")[1], "base64");
  assert.equal(bytes.toString("latin1", 0, 4), "RIFF");
  assert.equal(bytes.toString("latin1", 8, 12), "WAVE");
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
  assert.equal(bytes.readUInt32LE(40), bytes.length - 44);
});

test("a click is described in words", () => {
  const extras = { abc: { key: "making-of", type: "BehindTheScenes", durationSec: 1500 }, def: { key: "x" } };
  assert.match(C.describePlay(["abc"], extras), /making-of \(BehindTheScenes, 25:00\)/);
  assert.match(C.describePlay(["def"], extras), /x\./);
  assert.match(C.describePlay(["abc", "def"], extras), /then x/);
  assert.match(C.describePlay(["unknown"], extras), /the feature/);
  assert.match(C.describePlay([], extras), /not available/);
  assert.match(C.describePlay("nope", null), /not available/);
  assert.match(C.describePlay(["__proto__"], {}), /the feature/);
  assert.equal(C.clock(3725), "1:02:05");
  assert.equal(C.clock(-1), "");
});

test("hash is stable and unsigned", () => {
  assert.equal(C.hash("a"), C.hash("a"));
  assert.notEqual(C.hash("a"), C.hash("b"));
  for (const s of ["", "x", "menu/Menus/main/Background", "ü".repeat(50)]) assert.ok(C.hash(s) >= 0);
});

const ART_URL = "https://peppy6582.github.io/jellydisc-menus/v1/art/";

test("art the catalogue hosts is shown for real, through the site's own art folder", () => {
  const doc = {
    Background: { Source: "image", Image: `${ART_URL}${ID}/bg.jpg`, Dim: 0.3 },
    Layout: { Layers: [{ Image: `${ART_URL}${ID}/logo.png` }] },
    Audio: { Music: { Source: "file", File: `${ART_URL}${ID}/theme.m4a` } },
    Menus: {
      t: { Background: { Source: "trailer", Poster: `${ART_URL}${ID}/poster.jpg`, Dim: 0.6 } },
      u: { Background: { Source: "trailer" } },
      m: { Entries: [{ Image: `${ART_URL}${ID}/tile.jpg`, ImageFocus: `${ART_URL}${ID}/tile-focus.jpg` }] },
    },
  };
  const out = C.placeholderize(doc, ART);
  assert.equal(JSON.stringify(out.Background), JSON.stringify({ Source: "image", Image: `asset:hosted/${ID}/bg.jpg`, Dim: 0.3 }));
  assert.equal(out.Layout.Layers[0].Image, `asset:hosted/${ID}/logo.png`);
  assert.equal(out.Audio.Music.File, `asset:hosted/${ID}/theme.m4a`);
  assert.equal(JSON.stringify(out.Menus.t.Background), JSON.stringify({ Source: "image", Image: `asset:hosted/${ID}/poster.jpg`, Dim: 0.6 }));
  assert.match(out.Menus.u.Background.Image, /^data:image\/png/);
  assert.equal(out.Menus.m.Entries[0].Image, `asset:hosted/${ID}/tile.jpg`);
  assert.equal(out.Menus.m.Entries[0].ImageFocus, `asset:hosted/${ID}/tile-focus.jpg`);
  assert.ok(!/https?:/i.test(JSON.stringify(out)));
});

test("only an exact link to hosted art counts; lookalikes become placeholders or silence", () => {
  for (const bad of [
    `https://peppy6582.github.io.evil.example/jellydisc-menus/v1/art/${ID}/logo.png`,
    `http://peppy6582.github.io/jellydisc-menus/v1/art/${ID}/logo.png`,
    `${ART_URL}${ID}/../../../evil.png`, `${ART_URL}${ID}/a/b.png`, `${ART_URL}${ID}/logo.png?x=1`,
    `${ART_URL}${ID}/LOGO.png`, `${ART_URL}not-an-id/logo.png`, `${ART_URL}${ID}/`, `${ART_URL}${ID}/..png`,
    `${ART_URL.toUpperCase()}${ID}/logo.png`, `x${ART_URL}${ID}/logo.png`, `${ART_URL}${ID}/logo.png\n`,
  ]) {
    assert.equal(C.hostedArt(bad), null, bad);
    const out = C.placeholderize({ Layout: { Layers: [{ Image: bad }] }, Audio: { Music: { File: bad } } }, ART);
    assert.match(out.Layout.Layers[0].Image, /^data:image\/png/, bad);
    assert.ok(!/asset:hosted/.test(JSON.stringify(out)), bad);
  }
  for (const v of [null, undefined, 5, {}, []]) assert.equal(C.hostedArt(v), null);
});

test("the stand-in ApiClient serves hosted art from the site and nothing else", () => {
  const silence = C.silentWav();
  const api = C.fakeApiClient(silence, "/jellydisc-menus/v1/art/");
  assert.equal(api.getUrl(`DiscMenus/Assets/hosted/${ID}/logo.png`), `/jellydisc-menus/v1/art/${ID}/logo.png`);
  assert.equal(api.getUrl(`DiscMenus/Assets/hosted/${ID}/theme.m4a`), `/jellydisc-menus/v1/art/${ID}/theme.m4a`);
  for (const bad of [
    `DiscMenus/Assets/hosted/${ID}/..%2F..%2Fx.png`, `DiscMenus/Assets/hosted/${ID}/a/b.png`, `DiscMenus/Assets/hosted/x/logo.png`,
    `DiscMenus/Assets/hosted/${ID}/..png`, `xDiscMenus/Assets/hosted/${ID}/logo.png`,
  ]) assert.equal(api.getUrl(bad), bad.endsWith(".png") || bad.endsWith("x.png") ? "" : silence, bad);
  // without an art folder (any other page), hosted art resolves to nothing
  assert.equal(C.fakeApiClient(silence).getUrl(`DiscMenus/Assets/hosted/${ID}/logo.png`), "");
});
