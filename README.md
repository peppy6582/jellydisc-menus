# Disc Menus catalogue

A shared, public-domain collection of **DVD and Blu-ray style menus** for the
[Disc Menus plugin for Jellyfin](https://github.com/peppy6582/jellydisc). Each menu is a small JSON file filed under
the film or series it is for. The plugin matches it to the right title in your library by its TMDB / IMDb / TVDB id.

> **Status: early.** Five demonstration menus so far, and a static website (Eleventy + Pagefind) that GitHub Pages publishes from `main`. Community project; not affiliated
> with Jellyfin or TMDB.

## What's here

```
menus/<movie|tv>/<TMDB id>/<menuId>.menu.json      the menu (what the plugin loads)
menus/<movie|tv>/<TMDB id>/<menuId>.listing.json   how it is described in the catalogue: title, tags, changelog
schema/                                            the listing and index schemas (the menu schema is the plugin's)
config/                                            hosts allowed, withdrawn menus, which plugin version added which feature
tools/                                             the checker, the index builder, and their tests
```

**The catalogue holds menu JSON only.** No artwork, music or video, ever. A menu that points at its own art files
(`asset:<menuId>/...`) is labelled "bring your own art" and its listing says where to get the files.

## Use a menu

Download the `.menu.json` from `menus/` and put it in the plugin's menus folder. See the plugin's
[Getting started](https://github.com/peppy6582/jellydisc#getting-started). Browsing and one-click install from inside the
plugin is planned.

## For client developers

The machine-readable entry point is `v1/index.json` (published with the site; see
[`schema/index.schema.json`](schema/index.schema.json)). It lists every menu with its `match` block, a `sha256` and
a stable `url`. Download that one file and **match against your own library locally**; nothing about a library ever needs to
be sent anywhere. Within `formatVersion` 1 fields are only ever added, so ignore fields you don't know. Check the
`sha256` before you install a file, and `minPluginVersion` before you offer it.

## Add a menu

Read [CONTRIBUTING.md](CONTRIBUTING.md). In short: fork, add the two files, open a pull request; a bot-free check runs the
same rules you can run yourself:

```bash
pip install jsonschema
git clone https://github.com/peppy6582/jellydisc ../jellyfin-disc-menus      # the plugin, for its checker
python3 tools/catalogue_check.py
```

## Licences

- **The menus and listings** (`menus/`) are dedicated to the public domain under
  [CC0 1.0](menus/LICENSE). By contributing one you agree to that.
- **The tools and workflows** are [GPL-3.0-only](LICENSE), like the plugin.

See [POLICY.md](POLICY.md) for takedowns, privacy and moderation.

## The website

`site/` is an [Eleventy](https://www.11ty.dev) site built from the catalogue folder that `tools/build_index.py` writes, so it can only show menus that passed every check. Security is by construction: Nunjucks escapes everything, there is no inline script or style, and the content-security policy allows nothing third-party. `npm test` builds it from a deliberately hostile catalogue to prove it.

```bash
python3 tools/build_index.py --plugin ../jellyfin-disc-menus --out _catalogue
npm ci && npm run build        # writes _site/ (on a filesystem that allows symlinks)
npm test
```
