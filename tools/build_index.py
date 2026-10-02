"""Builds the published catalogue: the index and every menu file, into an output folder.

    _site/v1/index.json                         the one file clients download (schema/index.schema.json)
    _site/v1/menus/<menuId>/<revision>.menu.json   every revision of every menu; a revision's file never changes
    _site/schema/v1/*.schema.json               the catalogue's own schemas, at the addresses their $id names

It runs the catalogue checker first and refuses to build if anything fails, so a published index can only
describe menus that passed every rule.

Command:  python3 tools/build_index.py [--root DIR] [--plugin DIR] [--out DIR] [--generated ISO-8601] [--no-history]
          --generated  fixes the timestamp (default: $SOURCE_DATE_EPOCH, else now), which makes the output reproducible
          --no-history skip older revisions from git history (used by tests and for a quick local build)
"""
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from catalogue_check import check_catalogue, read_json, MAX_MENU_BYTES, version_tuple  # noqa: E402

BASE_URL = "https://peppy6582.github.io/jellydisc-menus/"
ATTRIBUTION = ("Menus are dedicated to the public domain under CC0 1.0. Movie and series ids are TMDB, IMDb and TVDB "
               "identifiers; this catalogue contains no artwork, music or video, is a community project, and is not "
               "affiliated with Jellyfin or TMDB.")


def min_plugin_version(features, features_cfg):
    versions = [features_cfg[f] for f in features if f in features_cfg] or ["0.1.0"]
    return max(versions, key=version_tuple)


def history_revisions(root, rel):
    """{revision: bytes} for every committed version of a menu file, earliest commit wins. Empty without git."""
    try:
        commits = subprocess.run(["git", "-C", root, "log", "--format=%H", "--", rel],
                                 capture_output=True, text=True, check=True).stdout.split()
    except (OSError, subprocess.CalledProcessError):
        return {}
    found = {}
    for commit in reversed(commits):                 # oldest first
        shown = subprocess.run(["git", "-C", root, "show", f"{commit}:{rel}"], capture_output=True)
        if shown.returncode != 0 or len(shown.stdout) > MAX_MENU_BYTES:
            continue
        try:
            revision = json.loads(shown.stdout.decode("utf-8")).get("revision")
        except (ValueError, UnicodeDecodeError, AttributeError):
            continue
        if isinstance(revision, int) and revision not in found:
            found[revision] = shown.stdout
    return found


def build(root, plugin_dir, out, generated, history=True):
    problems, entries = check_catalogue(root, plugin_dir)
    errors = [p for p in problems if p.severity == "error"]
    if errors:
        for p in errors:
            print(f"ERROR   {p.file}: {p.message}", file=sys.stderr)
        raise SystemExit("not building: the catalogue has errors")

    with open(os.path.join(root, "config", "features.json"), encoding="utf-8") as f:
        features_cfg = json.load(f)["features"]
    with open(os.path.join(root, "config", "withdrawn.json"), encoding="utf-8") as f:
        withdrawn = json.load(f)

    # an old checkout of _site must not leak into a new one
    v1 = os.path.join(out, "v1")
    shutil.rmtree(v1, ignore_errors=True)
    os.makedirs(os.path.join(v1, "menus"), exist_ok=True)

    index_entries = []
    for e in sorted(entries, key=lambda e: (e.listing["title"].lower(), e.menu["menuId"])):
        menu, listing = e.menu, e.listing
        mid, rev = menu["menuId"], menu["revision"]
        mdir = os.path.join(v1, "menus", mid)
        os.makedirs(mdir, exist_ok=True)
        if history:
            rel = os.path.relpath(e.menu_path, root).replace(os.sep, "/")
            for old_rev, raw in history_revisions(root, rel).items():
                if old_rev != rev:
                    with open(os.path.join(mdir, f"{old_rev}.menu.json"), "wb") as f:
                        f.write(raw)
        with open(os.path.join(mdir, f"{rev}.menu.json"), "wb") as f:
            f.write(e.raw)

        entry = {
            "menuId": mid,
            "revision": rev,
            "menuSchemaVersion": menu["schemaVersion"],
            "minPluginVersion": min_plugin_version(e.features, features_cfg),
            "title": listing["title"],
        }
        if "originalTitle" in listing:
            entry["originalTitle"] = listing["originalTitle"]
        year = (menu["match"].get("release") or {}).get("year")
        if isinstance(year, int):
            entry["year"] = year
        entry["match"] = menu["match"]
        entry["author"] = listing["author"]
        entry["licence"] = listing["licence"]
        if listing.get("tags"):
            entry["tags"] = listing["tags"]
        lang = (menu.get("meta") or {}).get("language")
        if isinstance(lang, str):
            entry["language"] = lang
        entry.update({
            "description": listing["description"],
            "url": f"v1/menus/{mid}/{rev}.menu.json",
            "sha256": e.sha256,
            "size": len(e.raw),
            "features": e.features,
            "backgrounds": e.backgrounds,
            "needsLocalArt": e.needs_art,
            "demo": bool(listing.get("demo", False)),
            "page": f"menus/{mid}/",
        })
        index_entries.append(entry)

    index = {
        "format": "jellydisc-catalogue",
        "formatVersion": 1,
        "generated": generated,
        "menuSchemaVersions": [1],
        "baseUrl": BASE_URL,
        "licence": "CC0-1.0",
        "attribution": ATTRIBUTION,
        "entries": index_entries,
        "withdrawn": withdrawn,
    }
    with open(os.path.join(v1, "index.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(index, f, indent=2, ensure_ascii=False)
        f.write("\n")

    sdir = os.path.join(out, "schema", "v1")
    os.makedirs(sdir, exist_ok=True)
    for name in ("index.schema.json", "listing.schema.json"):
        shutil.copyfile(os.path.join(root, "schema", name), os.path.join(sdir, name))
    return index


def main(argv):
    opts, i = {}, 0
    flags = {"--no-history"}
    while i < len(argv):
        a = argv[i]
        if a in flags:
            opts[a] = True
            i += 1
        elif a in ("--root", "--plugin", "--out", "--generated") and i + 1 < len(argv):
            opts[a] = argv[i + 1]
            i += 2
        else:
            print(__doc__, file=sys.stderr)
            return 2
    root = os.path.abspath(opts.get("--root", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")))
    plugin = opts.get("--plugin") or os.environ.get("PLUGIN_DIR") or os.path.join(root, "..", "jellyfin-disc-menus")
    out = os.path.abspath(opts.get("--out", os.path.join(root, "_site")))
    generated = opts.get("--generated")
    if generated is None:
        epoch = os.environ.get("SOURCE_DATE_EPOCH")
        moment = datetime.fromtimestamp(int(epoch), timezone.utc) if epoch and epoch.isdigit() else datetime.now(timezone.utc)
        generated = moment.strftime("%Y-%m-%dT%H:%M:%SZ")
    if not re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$", generated):
        print("--generated must look like 2026-10-02T12:00:00Z", file=sys.stderr)
        return 2
    try:
        index = build(root, plugin, out, generated, history="--no-history" not in opts)
    except FileNotFoundError as ex:
        print(f"error: {ex}", file=sys.stderr)
        return 2
    print(f"built {len(index['entries'])} menu(s) into {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
