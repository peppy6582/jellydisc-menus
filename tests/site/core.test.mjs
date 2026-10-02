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
      e: { Background: { Source: "color", Color: "#123456" } },
    },
  };
  const out = C.placeholderize(doc, ART);
  assert.equal(out.Background.Source, "image");
  assert.equal(out.Background.Dim, 0.2);
  assert.match(out.Background.Image, /^data:image\/png/);
  for (const k of "abcd") assert.match(out.Menus[k].Background.Image, /^data:image\/png/, k);
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
