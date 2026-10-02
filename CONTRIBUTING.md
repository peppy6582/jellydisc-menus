# Contributing a menu

Menus, fixes and improvements are welcome. A pull request is the only way in for now, and every one is reviewed.

## The rules, briefly

1. **CC0.** You dedicate the menu to the public domain, and you have the right to. The pull request template asks you to say so.
2. **No studio material.** No posters, stills, logos, music or video, and no links to any. `https` image and audio links are
   rejected for now (they are how such material sneaks in, and they let a third party see who views a menu).
   Allowed backgrounds: `jellyfin`, `tmdb` (the viewer's own server fetches the film's backdrop), `color`, `trailer`; flat
   panels; small inline `data:` icons; the built-in sounds; the title's own theme song.
3. **A real menu, not a draft.** The plugin can draft a menu from your library; edit that into something a viewer would
   want. The checker rejects unedited drafts and labels that look like ripped file names (`Title_t01.mkv`).
4. **Plain text.** No `<` or `>` and no control characters in anything that is shown on the site.
5. **One file per edition.** A theatrical cut and an extended cut are separate menus (separate `menuId`s) when their
   extras differ; use `match.release` to say which.

## Adding a menu

1. Build and check it with the plugin ([Authoring menus](https://github.com/peppy6582/jellydisc/blob/main/docs/AUTHORING.md);
   `python3 tools/menucheck.py my.menu.json` in the plugin repo).
2. Give it a fresh lower-case `menuId` (any UUID) and file it as
   `menus/movie/<TMDB id>/<menuId>.menu.json`, or `menus/tv/<TMDB id>/...` for a series or season. The folder's id must
   equal `match.providerIds.Tmdb`.
3. Write `<menuId>.listing.json` beside it (see [`schema/listing.schema.json`](schema/listing.schema.json) and the existing
   ones): title, a short description, tags, your name, and `artSources` (`none`, or where the art files come from).
4. Run `python3 tools/catalogue_check.py` and fix what it says. The same check runs on your pull request.

## Changing a menu

Edit the file and **raise `revision`**, then add a `changelog` entry to the listing saying what changed. Earlier revisions
stay available at their own addresses so nobody's installed copy is orphaned.

## Removing a menu

Menus are only removed for a good reason (a takedown, a safety problem, the author asks). Delete the two files **and** add
an entry to `config/withdrawn.json` (`menuId`, `date`, `reason`): the checker insists, and the id can then never come back.

## Working on the tools

`python3 -m unittest discover -s tools -p "test_*.py"` with the plugin checkout reachable as `PLUGIN_DIR`
(default `../jellyfin-disc-menus`). Menus are untrusted input: a rule you add needs a test that fails without it.
