// Reads the catalogue that tools/build_index.py wrote and prepares what the templates need.
// Everything from a menu is plain data here; the templates escape it (Nunjucks auto-escaping is on).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default function () {
  const dir = path.resolve(process.env.CATALOGUE_DIR || "_catalogue");
  const index = JSON.parse(fs.readFileSync(path.join(dir, "v1", "index.json"), "utf8"));
  if (index.format !== "jellydisc-catalogue" || index.formatVersion !== 1) {
    throw new Error("unsupported catalogue index");
  }

  const entries = index.entries.map((e) => {
    if (!ID.test(e.menuId)) throw new Error(`bad menuId in index: ${e.menuId}`);
    const raw = fs.readFileSync(path.join(dir, e.url), "utf8");
    const digest = crypto.createHash("sha256").update(raw).digest("hex");
    if (digest !== e.sha256) throw new Error(`${e.url} does not match the index's sha256`);
    const menu = JSON.parse(raw);

    const kind = e.match.itemType === "Movie" ? "movie" : "tv";
    const tmdb = e.match.providerIds.Tmdb;
    const repoPath = `menus/${kind}/${tmdb}/${e.menuId}.menu.json`;

    const screens = Object.entries(menu.menus || {}).map(([key, m]) => ({
      key,
      title: m.title || key,
      labels: (m.entries || []).map((x) => x.label).filter((x) => typeof x === "string"),
    }));

    return {
      ...e,
      kind,
      raw,
      screens,
      ids: Object.entries(e.match.providerIds).map(([name, value]) => ({ name, value })),
      release: e.match.release || {},
      historyUrl: `https://github.com/peppy6582/jellydisc-menus/commits/main/${repoPath}`,
      sourceUrl: `https://github.com/peppy6582/jellydisc-menus/blob/main/${repoPath}`,
      tmdbUrl: tmdb ? `https://www.themoviedb.org/${kind}/${tmdb}` : null,
      searchText: [e.title, e.originalTitle, ...(e.tags || [])].filter(Boolean).join(" ").toLowerCase(),
    };
  });

  const tags = [...new Set(entries.flatMap((e) => e.tags || []))].sort();
  const features = [...new Set(entries.flatMap((e) => e.features || []))].sort();
  return { ...index, entries, tags, features, count: entries.length };
}
