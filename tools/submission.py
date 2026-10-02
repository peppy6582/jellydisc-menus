"""Turns a filled-in "Submit a menu" issue into the two catalogue files, runs the catalogue's checks on them, and
writes a verdict. The workflow (.github/workflows/submit.yml) does the GitHub parts: comment, branch, pull request.

    python3 tools/submission.py --body FILE --author LOGIN --plugin DIR [--root DIR] [--out DIR] [--issue N] [--github-output FILE]

Writes into --out (default: a "submission-result" folder under the root):
    result.json   {"ok", "problems", "warnings", "menuId", "title", "menuPath", "listingPath"}
    comment.md    the reply to post on the issue
    pr-title.txt, pr-body.md   for the pull request (only when it passes)
When the submission passes, the two files are also written under <root>/menus/.

The issue text is untrusted. It is only ever parsed as data here: never run, never put in a shell command, and every
path is built from pieces that were validated first.
"""
import json
import os
import re
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from catalogue_check import MAX_MENU_BYTES, UUID, _no_duplicates, check_catalogue  # noqa: E402

LABELS = {
    "menu": "Menu JSON",
    "title": "Title",
    "description": "Description",
    "tags": "Tags",
    "art": "Where the art comes from",
    "name": "Your name",
    "confirm": "Confirmations",
}
CONFIRMATIONS = 3          # how many boxes the form has; all must be ticked
TAG = re.compile(r"^[a-z0-9][a-z0-9-]{0,23}$")
LOGIN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
NO_RESPONSE = "_No response_"


def parse_form(body):
    """{label: text} from a GitHub issue form's markdown ("### Label", blank line, value). Headings inside a code
    fence are not headings."""
    sections, label, lines, fenced = {}, None, [], False
    for line in body.replace("\r\n", "\n").split("\n"):
        if line.strip().startswith("```"):
            fenced = not fenced
        if not fenced and line.startswith("### "):
            if label is not None:
                sections[label] = "\n".join(lines).strip()
            label, lines = line[4:].strip(), []
        elif label is not None:
            lines.append(line)
    if label is not None:
        sections[label] = "\n".join(lines).strip()
    return {k: ("" if v == NO_RESPONSE else v) for k, v in sections.items()}


def unfence(text):
    """The inside of a ``` block if the whole text is one, else the text."""
    m = re.match(r"^```[A-Za-z]*\n(.*?)\n?```\s*$", text, re.S)
    return m.group(1) if m else text


def parse_tags(text):
    """(tags, problems): split on commas and whitespace; spaces inside a tag become hyphens only via commas."""
    problems, tags = [], []
    for raw in re.split(r"[,\n]+", text or ""):
        tag = raw.strip().lower().replace(" ", "-")
        if not tag:
            continue
        if not TAG.match(tag):
            problems.append(f"The tag {raw.strip()!r} isn't allowed: use lower-case letters, digits and hyphens, up to 24 characters.")
        elif tag not in tags:
            tags.append(tag)
    if len(tags) > 8:
        problems.append("Use at most 8 tags.")
    return tags, problems


def existing_menu_ids(root):
    found = {}
    base = os.path.join(root, "menus")
    for kind in ("movie", "tv"):
        kdir = os.path.join(base, kind)
        if not os.path.isdir(kdir):
            continue
        for tmdb in os.listdir(kdir):
            tdir = os.path.join(kdir, tmdb)
            if os.path.isdir(tdir):
                for fn in os.listdir(tdir):
                    if fn.endswith(".menu.json"):
                        found[fn[: -len(".menu.json")]] = f"menus/{kind}/{tmdb}/{fn}"
    return found


def build(body, author, root, plugin_dir, out_dir=None, issue=None):
    """Returns the result dict. Writes the two files under root only if everything passes."""
    problems, warnings = [], []
    result = {"ok": False, "problems": problems, "warnings": warnings, "menuId": None, "title": None,
              "menuPath": None, "listingPath": None}

    def stop():
        _write(result, out_dir, issue)
        return result

    fields = parse_form(body or "")
    missing = [v for v in ("menu", "title", "description", "confirm") if LABELS[v] not in fields]
    if missing:
        problems.append("This doesn't look like the submission form: it is missing " +
                        ", ".join(LABELS[v] for v in missing) + ". Please use the form's template.")
        return stop()

    # ---- the confirmations
    ticked = len(re.findall(r"^- \[[xX]\]", fields[LABELS["confirm"]], re.M))
    if ticked < CONFIRMATIONS:
        problems.append("Please tick all three confirmations: CC0, no studio material, and that it is your work to share.")

    # ---- the menu itself
    text = unfence(fields[LABELS["menu"]])
    if len(text.encode("utf-8")) > MAX_MENU_BYTES:
        problems.append(f"The menu is larger than {MAX_MENU_BYTES // 1024} KB.")
        return stop()
    try:
        menu = json.loads(text, object_pairs_hook=_no_duplicates)
    except ValueError as ex:
        problems.append(f"The menu isn't valid JSON: {ex}")
        return stop()
    if not isinstance(menu, dict):
        problems.append("The menu must be a JSON object.")
        return stop()

    if "menuId" not in menu:
        menu["menuId"] = str(uuid.uuid4())
        warnings.append("The menu had no menuId, so a new one was made for it.")
    if not isinstance(menu["menuId"], str):
        problems.append("menuId must be text.")
        return stop()
    menu["menuId"] = menu["menuId"].lower()
    menu.setdefault("revision", 1)

    # ---- everything a path is built from is validated before it is used
    menu_id = menu["menuId"]
    match = menu.get("match") if isinstance(menu.get("match"), dict) else {}
    ids = match.get("providerIds") if isinstance(match.get("providerIds"), dict) else {}
    tmdb = ids.get("Tmdb")
    if not re.fullmatch(UUID, menu_id):
        problems.append("menuId must be a UUID such as 3f2b8c1e-6d4a-4e2b-9a71-0c5d2e8f1a44.")
    if not isinstance(tmdb, str) or not re.fullmatch(r"[0-9]{1,10}", tmdb):
        problems.append("match.providerIds.Tmdb is required and must be digits: the catalogue files a menu under its TMDB id.")
    if match.get("itemType") not in ("Movie", "Series", "Season"):
        problems.append("match.itemType must be Movie, Series or Season.")
    if problems and (not re.fullmatch(UUID, menu_id) or not isinstance(tmdb, str) or not re.fullmatch(r"[0-9]{1,10}", tmdb)
                     or match.get("itemType") not in ("Movie", "Series", "Season")):
        return stop()

    result["menuId"] = menu_id
    kind = "movie" if match["itemType"] == "Movie" else "tv"
    menu_rel = f"menus/{kind}/{tmdb}/{menu_id}.menu.json"
    listing_rel = f"menus/{kind}/{tmdb}/{menu_id}.listing.json"
    result["menuPath"], result["listingPath"] = menu_rel, listing_rel

    taken = existing_menu_ids(root)
    if menu_id in taken:
        problems.append(f"A menu with this menuId already exists ({taken[menu_id]}). To change an existing menu, "
                        "open a pull request that raises its revision and adds a changelog entry. For a different menu, "
                        "remove the menuId line and one will be made for you.")
        return stop()

    # ---- the listing, from the form
    title = fields[LABELS["title"]].strip()
    tags, tag_problems = parse_tags(fields.get(LABELS["tags"], ""))
    problems.extend(tag_problems)
    login = author if isinstance(author, str) and LOGIN.match(author) else None
    name = fields.get(LABELS["name"], "").strip() or login or "anonymous"
    listing = {
        "listingVersion": 1,
        "menuId": menu_id,
        "title": title,
        "description": fields[LABELS["description"]].strip(),
        "tags": tags,
        "licence": "CC0-1.0",
        "author": {"name": name} if login is None else {"name": name, "github": login},
        "artSources": fields.get(LABELS["art"], "").strip() or "none",
        "demo": False,
    }
    result["title"] = title

    # ---- the catalogue's own checks, on a scratch copy so a failure leaves nothing behind
    import shutil
    import tempfile
    scratch = tempfile.mkdtemp(prefix="submission-")
    try:
        for part in ("schema", "config", "menus"):
            shutil.copytree(os.path.join(root, part), os.path.join(scratch, part))
        os.makedirs(os.path.join(scratch, os.path.dirname(menu_rel)), exist_ok=True)
        with open(os.path.join(scratch, menu_rel), "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(menu, indent=2, ensure_ascii=False) + "\n")
        with open(os.path.join(scratch, listing_rel), "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(listing, indent=2, ensure_ascii=False) + "\n")
        found, _ = check_catalogue(scratch, plugin_dir, only=[menu_rel])
        for p in found:
            line = p.message if p.file in (menu_rel, "menus") else f"(listing) {p.message}"
            (problems if p.severity == "error" else warnings).append(line)
        if not problems:
            for rel in (menu_rel, listing_rel):
                os.makedirs(os.path.dirname(os.path.join(root, rel)), exist_ok=True)
                shutil.copyfile(os.path.join(scratch, rel), os.path.join(root, rel))
            result["ok"] = True
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    return stop()


def code(text, limit=300):
    """Quote user-derived text so it can't become markup, a mention or a link in a comment."""
    flat = " ".join(str(text).split())
    if len(flat) > limit:
        flat = flat[:limit] + "…"
    return "`` " + flat.replace("`", "'") + " ``"


def render_comment(result, extra=None):
    out = []
    if result["ok"]:
        out.append("Thanks! Your menu passes the catalogue's checks.")
    else:
        out.append("Thanks for the submission. It can't go in yet; here is what to fix. Edit the issue and the checks run again.")
    if result["problems"]:
        out.append("\n**To fix**\n")
        out += [f"- {code(p)}" for p in result["problems"][:25]]
        if len(result["problems"]) > 25:
            out.append(f"- …and {len(result['problems']) - 25} more.")
    if extra:
        out.append("\n" + extra)
    if result["warnings"]:
        out.append("\n**Worth a look** (not blocking)\n")
        out += [f"- {code(w)}" for w in result["warnings"][:15]]
    return "\n".join(out) + "\n"


def pr_title(title):
    """One short plain line: no mentions, no markup, nothing that spans lines."""
    flat = re.sub(r"[@`*_<>\[\]]", "", " ".join(str(title).split()))
    return ("Add menu: " + flat)[:100].rstrip()


def pr_body(result, issue):
    lines = [f"Adds {code(result['title'], 120)} as `{result['menuPath']}` with its listing.", ""]
    if issue:
        lines += [f"Submitted in #{int(issue)}.", ""]
    lines += [
        "The submission workflow ran the catalogue checks, the schema and cross-reference checks, and the plugin's own loader, and all passed.",
        "",
        "**Maintainer:** pull requests opened by a workflow don't start the usual checks. Close and reopen this pull request "
        "to run them, and look at the preview on the built site before merging.",
    ]
    if issue:
        lines += ["", f"Closes #{int(issue)}"]
    return "\n".join(lines) + "\n"


def _write(result, out_dir, issue=None):
    if not out_dir:
        return
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "result.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
    with open(os.path.join(out_dir, "comment.md"), "w", encoding="utf-8") as f:
        f.write(render_comment(result))
    for name in ("pr-title.txt", "pr-body.md"):
        stale = os.path.join(out_dir, name)
        if os.path.exists(stale):
            os.remove(stale)
    if result["ok"]:
        with open(os.path.join(out_dir, "pr-title.txt"), "w", encoding="utf-8") as f:
            f.write(pr_title(result["title"]) + "\n")
        with open(os.path.join(out_dir, "pr-body.md"), "w", encoding="utf-8") as f:
            f.write(pr_body(result, issue))


def main(argv):
    opts, i = {}, 0
    while i < len(argv):
        if argv[i] in ("--body", "--author", "--plugin", "--root", "--out", "--github-output", "--issue") and i + 1 < len(argv):
            opts[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            print(__doc__, file=sys.stderr)
            return 2
    if not all(k in opts for k in ("body", "author", "plugin")):
        print(__doc__, file=sys.stderr)
        return 2
    root = os.path.abspath(opts.get("root", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")))
    out = opts.get("out", os.path.join(root, "submission-result"))
    with open(opts["body"], encoding="utf-8", errors="replace") as f:
        body = f.read()
    issue = opts.get("issue")
    if issue is not None and not issue.isdigit():
        print("--issue must be a number", file=sys.stderr)
        return 2
    result = build(body, opts["author"], root, opts["plugin"], out, issue)
    if "github-output" in opts:
        with open(opts["github-output"], "a", encoding="utf-8") as f:
            f.write(f"ok={'true' if result['ok'] else 'false'}\n")
            f.write(f"menu_id={result['menuId'] or ''}\n")
            f.write(f"menu_path={result['menuPath'] or ''}\n")
    print(json.dumps({k: result[k] for k in ("ok", "menuId", "menuPath")}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
