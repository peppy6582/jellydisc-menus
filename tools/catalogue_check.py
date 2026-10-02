"""Checks the whole catalogue: every menu and its sidecar listing, and the rules that only make sense for a
shared collection of menus.

For each menu this runs the plugin project's own checker (JSON Schema + cross-reference rules, from
menucheck.py in the plugin repository, pinned in plugin.lock.json) and then the catalogue's extra rules.
CI runs the plugin's C# loader on the same files separately (tools/MenuCheck in the plugin repository).

Library:  from catalogue_check import check_catalogue
Command:  python3 tools/catalogue_check.py [--root DIR] [--plugin DIR] [--base DIR] [--json] [--strict]
            --plugin  a checkout of the plugin repository (default: $PLUGIN_DIR, or ../jellyfin-disc-menus)
            --base    a checkout of the previous catalogue (the main branch), to check revisions against
            --strict  warnings fail too
          exit 0 = no errors, 1 = errors found, 2 = bad usage

Menus are untrusted input. Everything here is defensive: a file that is not what it should be becomes an error
message, never an exception.
"""
import hashlib
import importlib.util
import json
import os
import re
import sys

UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
MENU_PATH = re.compile(rf"^menus/(movie|tv)/(\d+)/({UUID})\.menu\.json$")
LISTING_PATH = re.compile(rf"^menus/(movie|tv)/(\d+)/({UUID})\.listing\.json$")
FOLDER_PATH = re.compile(r"^menus(/(movie|tv)(/\d+)?)?$")

MAX_MENU_BYTES = 128 * 1024        # the plugin accepts 512 KB; real menus are a few KB
MAX_LISTING_BYTES = 8 * 1024
MAX_DATA_URI = 16 * 1024           # one inline image
MAX_DATA_URI_TOTAL = 48 * 1024     # all inline images in a menu

# Keys whose string value is an image or audio reference.
REF_KEYS = {"image", "imageFocus", "poster", "file", "move", "select", "back"}

# Names that look like they came straight from a ripped file, not a menu author. These are errors.
RIP_LABEL = [
    re.compile(r"\.(mkv|mp4|m2ts|avi|iso|vob|ts|mpg)\b", re.I),
    re.compile(r"\bS\d{2}E\d{2}\b", re.I),
    re.compile(r"(^|[\s_-])t\d{2}\b", re.I),
    re.compile(r"\btitle[_ ]?\d+\b", re.I),
    re.compile(r"^[A-Za-z0-9]+(_[A-Za-z0-9]+){2,}$"),
    re.compile(r"^[A-Za-z0-9]+(\.[A-Za-z0-9]+){3,}$"),
]
# The labels the plugin's draft generator makes ("Featurette 1 (5:10)"). Fine to start from; worth a warning.
DRAFT_LABEL = re.compile(
    r"^(Featurette|Short|Extra|Deleted Scene|Interview|Clip|Trailer|Scene|Behind the Scenes|Sample) \d+ \(\d+:\d{2}(:\d{2})?\)$"
)
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class Problem:
    def __init__(self, severity, file, message):
        self.severity, self.file, self.message = severity, file, message

    def as_dict(self):
        return {"severity": self.severity, "file": self.file, "message": self.message}

    def __repr__(self):  # pragma: no cover
        return f"{self.severity}: {self.file}: {self.message}"


class Entry:
    """One menu that passed everything, with what the index builder needs."""

    def __init__(self, rel, menu_path, listing_path, menu, listing, raw, features, backgrounds, needs_art):
        self.rel, self.menu_path, self.listing_path = rel, menu_path, listing_path
        self.menu, self.listing, self.raw = menu, listing, raw
        self.features, self.backgrounds, self.needs_art = features, backgrounds, needs_art
        self.sha256 = hashlib.sha256(raw).hexdigest()


def load_menucheck(plugin_dir):
    """Import menucheck.py from a checkout of the plugin repository."""
    path = os.path.join(plugin_dir, "tools", "menucheck.py")
    if not os.path.isfile(path):
        raise FileNotFoundError(f"no tools/menucheck.py under {plugin_dir!r}: pass --plugin or set PLUGIN_DIR")
    sys.path.insert(0, os.path.dirname(path))      # menucheck imports jsonschema and reads the plugin's schema
    spec = importlib.util.spec_from_file_location("menucheck", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _no_duplicates(pairs):
    seen = set()
    for k, _ in pairs:
        if k in seen:
            raise ValueError(f"duplicate key {k!r}")
        seen.add(k)
    return dict(pairs)


def read_json(path, max_bytes):
    """(parsed, raw_bytes, error). Duplicate keys are an error: two parsers can disagree about which one wins."""
    try:
        if os.path.islink(path):
            return None, b"", "symbolic links are not allowed"
        size = os.path.getsize(path)
        if size > max_bytes:
            return None, b"", f"file is {size} bytes; the limit is {max_bytes}"
        with open(path, "rb") as f:
            raw = f.read()
    except OSError as ex:
        return None, b"", f"cannot read file: {ex.strerror or ex}"
    if raw.startswith(b"\xef\xbb\xbf"):
        return None, raw, "file must be UTF-8 without a byte order mark"
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None, raw, "file is not valid UTF-8"
    try:
        return json.loads(text, object_pairs_hook=_no_duplicates), raw, None
    except ValueError as ex:
        return None, raw, f"not valid JSON: {ex}"


def walk(node, path=()):
    """Yield (path_tuple, value) for every node."""
    yield path, node
    if isinstance(node, dict):
        for k, v in node.items():
            yield from walk(v, path + (k,))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from walk(v, path + (i,))


def labels_of(menu):
    """Every piece of text a viewer reads as a label: entry labels, menu titles, flow More/Previous labels."""
    out = []
    for key, m in (menu.get("menus") or {}).items():
        if not isinstance(m, dict):
            continue
        out.append(m.get("title"))
        for e in m.get("entries") or []:
            if isinstance(e, dict):
                out.append(e.get("label"))
        flow = (m.get("layout") or {}).get("flow") if isinstance(m.get("layout"), dict) else None
        if isinstance(flow, dict):
            out += [flow.get("moreLabel"), flow.get("previousLabel")]
    flow = (menu.get("layout") or {}).get("flow") if isinstance(menu.get("layout"), dict) else None
    if isinstance(flow, dict):
        out += [flow.get("moreLabel"), flow.get("previousLabel")]
    return [x for x in out if isinstance(x, str)]


def detect_features(menu):
    """(features, backgrounds): which optional features a (schema-valid) menu uses."""
    features, backgrounds = set(), set()
    menus = [m for m in (menu.get("menus") or {}).values() if isinstance(m, dict)]
    scopes = [menu] + menus
    for scope in scopes:
        layout = scope.get("layout")
        if isinstance(layout, dict):
            features.add("layout")
            if "flow" in layout:
                features.add("flow")
            if layout.get("layers"):
                features.add("layers")
            if "transition" in layout:
                features.add("transitions")
        if scope.get("audio"):
            features.add("audio")
        bg = scope.get("background")
        if isinstance(bg, dict) and isinstance(bg.get("source"), str):
            backgrounds.add(bg["source"])
    for m in menus:
        for e in m.get("entries") or []:
            if not isinstance(e, dict):
                continue
            if e.get("action") == "chapters" or "startChapter" in e:
                features.add("chapters")
            if e.get("action") == "home":
                features.add("home")
            if "position" in e:
                features.add("layout")
    if "trailer" in backgrounds:
        features.add("trailer")
    if "tmdb" in backgrounds:
        features.add("tmdb-background")
    if "fanart" in backgrounds:
        features.add("fanart-background")
    return features, backgrounds


def version_tuple(v):
    return tuple(int(x) for x in v.split("."))


def check_catalogue(root, plugin_dir, base_dir=None, only=None):
    """Check everything under <root>/menus. Returns (problems, entries). `only` limits the per-file checks
    (a list of paths relative to root) while keeping the whole-catalogue checks."""
    problems = []

    def err(file, msg):
        problems.append(Problem("error", file, msg))

    def warn(file, msg):
        problems.append(Problem("warning", file, msg))

    menucheck = load_menucheck(plugin_dir)
    listing_validator = _validator(os.path.join(root, "schema", "listing.schema.json"))
    withdrawn = _read_config(root, "withdrawn.json", err)
    features_cfg = _read_config(root, "features.json", err, default={"features": {}}).get("features", {})
    withdrawn_ids = {w.get("menuId") for w in withdrawn if isinstance(w, dict)} if isinstance(withdrawn, list) else set()

    menus_dir = os.path.join(root, "menus")
    menu_files, listing_files = [], set()
    if not os.path.isdir(menus_dir):
        err("menus", "there is no menus folder")
        return problems, []

    # ---- nothing but menus, listings and the licence may live under menus/
    for dirpath, dirnames, filenames in os.walk(menus_dir):
        rel_dir = os.path.relpath(dirpath, root).replace(os.sep, "/")
        if not FOLDER_PATH.match(rel_dir):
            err(rel_dir, "unexpected folder: menus live in menus/movie/<tmdb id>/ or menus/tv/<tmdb id>/")
            dirnames[:] = []
            continue
        for d in list(dirnames):
            if os.path.islink(os.path.join(dirpath, d)):
                err(rel_dir + "/" + d, "symbolic links are not allowed")
                dirnames.remove(d)
        for fn in sorted(filenames):
            rel = (rel_dir + "/" + fn).replace(os.sep, "/")
            if rel == "menus/LICENSE":
                continue
            if MENU_PATH.match(rel):
                menu_files.append(rel)
            elif LISTING_PATH.match(rel):
                listing_files.add(rel)
            else:
                err(rel, "unexpected file: only <menuId>.menu.json and <menuId>.listing.json are allowed, "
                         "with a lower-case menuId")

    entries, seen_ids = [], {}
    for rel in sorted(menu_files):
        if only is not None and rel not in only:
            # still need its id for the uniqueness check
            doc, _, e = read_json(os.path.join(root, rel), MAX_MENU_BYTES)
            if e is None and isinstance(doc, dict) and isinstance(doc.get("menuId"), str):
                seen_ids.setdefault(doc["menuId"], rel)
            continue
        entry = _check_menu(root, rel, menucheck, listing_validator, features_cfg, err, warn)
        doc_id = entry.menu.get("menuId") if entry else None
        if entry is not None:
            entries.append(entry)
        else:
            doc, _, e = read_json(os.path.join(root, rel), MAX_MENU_BYTES)
            doc_id = doc.get("menuId") if e is None and isinstance(doc, dict) else None
        if isinstance(doc_id, str):
            if doc_id in seen_ids:
                err(rel, f"menuId {doc_id} is already used by {seen_ids[doc_id]}")
            else:
                seen_ids[doc_id] = rel
            if doc_id in withdrawn_ids:
                err(rel, f"menuId {doc_id} was withdrawn from the catalogue and cannot be added again")

    # ---- a listing without a menu is clutter (or a menu that went missing)
    menu_set = set(menu_files)
    for rel in sorted(listing_files):
        if rel.replace(".listing.json", ".menu.json") not in menu_set:
            err(rel, "this listing has no menu file beside it")

    if base_dir is not None:
        _check_against_base(root, base_dir, entries, seen_ids, withdrawn_ids, err)

    return problems, entries


def _validator(schema_path):
    from jsonschema import Draft202012Validator, FormatChecker
    with open(schema_path, encoding="utf-8") as f:
        schema = json.load(f)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def _read_config(root, name, err, default=None):
    path = os.path.join(root, "config", name)
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as ex:
        err("config/" + name, f"cannot read: {ex}")
        return default if default is not None else []


def _check_menu(root, rel, menucheck, listing_validator, features_cfg, err, warn):
    path = os.path.join(root, rel)
    kind, tmdb_id, menu_id = MENU_PATH.match(rel).groups()
    doc, raw, error = read_json(path, MAX_MENU_BYTES)
    if error:
        err(rel, error)
        return None
    problems_before = 0

    # 1. the plugin's own rules: JSON Schema + cross-reference checks
    errs = menucheck.check_menu_doc(doc)
    if errs:
        for e in errs:
            err(rel, e)
        return None

    ok = True

    # 2. the path says what the menu is
    if doc["menuId"] != menu_id:
        err(rel, f"the file name's id ({menu_id}) must equal the menu's menuId ({doc['menuId']}), in lower case")
        ok = False
    item_type = doc["match"]["itemType"]
    want_kind = "movie" if item_type == "Movie" else "tv"
    if kind != want_kind:
        err(rel, f"a {item_type} belongs under menus/{want_kind}/, not menus/{kind}/")
        ok = False
    tmdb = doc["match"]["providerIds"].get("Tmdb")
    if tmdb is None:
        err(rel, "match.providerIds must include a Tmdb id (it is the folder the menu is filed under)")
        ok = False
    elif tmdb != tmdb_id:
        err(rel, f"the folder's TMDB id ({tmdb_id}) must equal match.providerIds.Tmdb ({tmdb})")
        ok = False

    # 3. text that will be shown on the site: plain, no markup, no control characters
    meta = doc.get("meta") or {}
    for field in ("author", "notes"):
        value = meta.get(field)
        if isinstance(value, str) and ("<" in value or ">" in value or CONTROL.search(value)):
            err(rel, f"meta.{field} must be plain text: no < or > and no control characters")
            ok = False

    # 4. not an unedited draft, and no ripped-file names as labels
    if meta.get("author") == "auto-draft" or str(meta.get("notes", "")).startswith("Draft generated from this server's library"):
        err(rel, "this is an unedited auto-generated draft; its labels come from someone's own files. "
                 "Edit it into a real menu first")
        ok = False
    for label in labels_of(doc):
        if any(p.search(label) for p in RIP_LABEL):
            err(rel, f"the label {label!r} looks like a ripped file's name; use a name a viewer would expect")
            ok = False
        elif DRAFT_LABEL.match(label):
            warn(rel, f"the label {label!r} looks auto-generated (from the plugin's draft builder); consider a real name")

    # 5. image and audio references
    needs_art, data_total = [], 0
    for p, v in walk(doc):
        if not isinstance(v, str):
            continue
        key = p[-1] if p and isinstance(p[-1], str) else None
        where = "menu" + "".join(f"[{x}]" if isinstance(x, int) else f".{x}" for x in p)
        if v.startswith("data:"):
            data_total += len(v)
            if len(v) > MAX_DATA_URI:
                err(rel, f"{where}: an inline image is {len(v)} characters; the limit is {MAX_DATA_URI}")
                ok = False
        if key in REF_KEYS:
            low = v.lower()
            if low.startswith("http://") or low.startswith("https://"):
                err(rel, f"{where}: external image and audio links are not allowed in the catalogue yet "
                         "(they are how studio artwork sneaks in, and the host sees every viewer's address)")
                ok = False
            elif v.startswith("asset:"):
                folder = v[len("asset:"):].split("/")[0]
                if folder != doc["menuId"]:
                    err(rel, f"{where}: art files must be filed under the menu's own id: "
                             f"use asset:{doc['menuId']}/<file>, not {v!r}")
                    ok = False
                else:
                    needs_art.append(v)
    if data_total > MAX_DATA_URI_TOTAL:
        err(rel, f"inline images total {data_total} characters; the limit is {MAX_DATA_URI_TOTAL}")
        ok = False

    # 6. the sidecar listing
    lrel = rel.replace(".menu.json", ".listing.json")
    lpath = os.path.join(root, lrel)
    listing = None
    if not os.path.isfile(lpath):
        err(rel, f"missing its listing file {os.path.basename(lrel)}")
        ok = False
    else:
        listing, _, lerr = read_json(lpath, MAX_LISTING_BYTES)
        if lerr:
            err(lrel, lerr)
            ok = False
            listing = None
        else:
            lerrs = sorted(listing_validator.iter_errors(listing), key=lambda e: list(e.absolute_path))
            if lerrs:
                for e in lerrs[:20]:
                    where = "$" + "".join(f"[{x}]" if isinstance(x, int) else f".{x}" for x in e.absolute_path)
                    err(lrel, f"{where}: {e.message}")
                ok = False
                listing = None
            else:
                if listing["menuId"] != doc["menuId"]:
                    err(lrel, "the listing's menuId must equal the menu's menuId")
                    ok = False
                if needs_art and listing["artSources"].strip().lower() == "none":
                    err(lrel, "the menu refers to art files, so artSources must say where they come from, not \"none\"")
                    ok = False
                for item in listing.get("changelog", []):
                    if item["revision"] > doc["revision"]:
                        err(lrel, f"the changelog mentions revision {item['revision']}, newer than the menu's revision {doc['revision']}")
                        ok = False

    if not ok:
        return None

    features, backgrounds = detect_features(doc)
    if needs_art:
        features.add("asset-art")
    unknown = sorted(f for f in features if f not in features_cfg)
    for f in unknown:
        warn(rel, f"uses the feature {f!r}, which config/features.json doesn't list a plugin version for")
    return Entry(rel, path, lpath, doc, listing, raw, sorted(features), sorted(backgrounds), sorted(set(needs_art)))


def _check_against_base(root, base_dir, entries, seen_ids, withdrawn_ids, err):
    """Compare with the previous catalogue: revisions only go up, an edit needs a changelog entry, and nothing
    disappears without being withdrawn."""
    base_menus = {}
    for dirpath, _, filenames in os.walk(os.path.join(base_dir, "menus")):
        for fn in filenames:
            if fn.endswith(".menu.json"):
                doc, raw, e = read_json(os.path.join(dirpath, fn), MAX_MENU_BYTES)
                if e is None and isinstance(doc, dict) and isinstance(doc.get("menuId"), str):
                    base_menus[doc["menuId"]] = (doc, raw)
    now = {e.menu["menuId"]: e for e in entries}
    for menu_id, (old, old_raw) in base_menus.items():
        if menu_id in now:
            e = now[menu_id]
            if e.raw == old_raw:
                continue
            old_rev, new_rev = old.get("revision"), e.menu["revision"]
            if not isinstance(old_rev, int) or new_rev <= old_rev:
                err(e.rel, f"this menu changed, so its revision must go up (it is {new_rev}; it was {old_rev})")
            elif not any(c["revision"] == new_rev for c in e.listing.get("changelog", [])):
                err(e.rel.replace(".menu.json", ".listing.json"),
                    f"revision {new_rev} needs a changelog entry saying what changed")
        elif menu_id not in withdrawn_ids and menu_id not in seen_ids:
            err("menus", f"menu {menu_id} was removed without being added to config/withdrawn.json")


def main(argv):
    as_json = "--json" in argv
    strict = "--strict" in argv
    opts, i = {}, 0
    rest = [a for a in argv if a not in ("--json", "--strict")]
    while i < len(rest):
        if rest[i] in ("--root", "--plugin", "--base") and i + 1 < len(rest):
            opts[rest[i][2:]] = rest[i + 1]
            i += 2
        else:
            print(__doc__.split("Command:")[1].split("Menus are untrusted")[0].strip(), file=sys.stderr)
            return 2
    root = os.path.abspath(opts.get("root", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")))
    plugin = opts.get("plugin") or os.environ.get("PLUGIN_DIR") or os.path.join(root, "..", "jellyfin-disc-menus")
    try:
        problems, entries = check_catalogue(root, plugin, opts.get("base"))
    except FileNotFoundError as ex:
        print(f"error: {ex}", file=sys.stderr)
        return 2
    errors = [p for p in problems if p.severity == "error"]
    warnings = [p for p in problems if p.severity == "warning"]
    if as_json:
        print(json.dumps({"ok": not errors, "menus": len(entries), "problems": [p.as_dict() for p in problems]}, indent=2))
    else:
        for p in problems:
            print(f"{p.severity.upper():7} {p.file}: {p.message}")
        print(f"{len(entries)} menu(s) passed; {len(errors)} error(s), {len(warnings)} warning(s)")
    return 1 if errors or (strict and warnings) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
