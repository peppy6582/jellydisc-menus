"""Copies the plugin's renderer and menu adapter into vendor/ from the commit pinned in plugin.lock.json, and
records the commit and each file's sha256 in vendor/VERSION.json. The site serves these files unchanged.

    python3 tools/vendor_sync.py --plugin DIR           update vendor/ from a checkout of the pinned commit
    python3 tools/vendor_sync.py --plugin DIR --check   fail if vendor/ differs from that checkout (CI)

The checkout must be at the commit named in plugin.lock.json: bumping the pin and re-running this is one change.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
FILES = {
    "discmenus.js": "Jellyfin.Plugin.DiscMenus/Web/discmenus.js",
    "menu-to-renderable.js": "tools/preview/menu-to-renderable.js",
}
SUPPORTED_MENU_SCHEMA_VERSIONS = [1]


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def main(argv):
    check = "--check" in argv
    rest = [a for a in argv if a != "--check"]
    if len(rest) != 2 or rest[0] != "--plugin":
        print(__doc__, file=sys.stderr)
        return 2
    plugin = os.path.abspath(rest[1])
    with open(os.path.join(ROOT, "plugin.lock.json"), encoding="utf-8") as f:
        ref = json.load(f)["ref"]
    try:
        head = subprocess.run(["git", "-C", plugin, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        head = None
    if head is not None and head != ref:
        print(f"error: the plugin checkout is at {head[:12]} but plugin.lock.json pins {ref[:12]}", file=sys.stderr)
        return 2

    wanted = {name: sha(os.path.join(plugin, src)) for name, src in FILES.items()}
    version = {"plugin": "peppy6582/jellydisc", "ref": ref, "supportedMenuSchemaVersions": SUPPORTED_MENU_SCHEMA_VERSIONS, "files": wanted}
    vdir = os.path.join(ROOT, "vendor")
    if check:
        problems = []
        for name, digest in wanted.items():
            p = os.path.join(vdir, name)
            if not os.path.isfile(p) or sha(p) != digest:
                problems.append(f"vendor/{name} differs from the plugin at {ref[:12]}")
        try:
            with open(os.path.join(vdir, "VERSION.json"), encoding="utf-8") as f:
                if json.load(f) != version:
                    problems.append("vendor/VERSION.json is out of date")
        except (OSError, ValueError):
            problems.append("vendor/VERSION.json is missing or unreadable")
        for p in problems:
            print("error:", p, file=sys.stderr)
        return 1 if problems else 0

    os.makedirs(vdir, exist_ok=True)
    for name, src in FILES.items():
        shutil.copyfile(os.path.join(plugin, src), os.path.join(vdir, name))
    with open(os.path.join(vdir, "VERSION.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(version, f, indent=2)
        f.write("\n")
    print(f"vendored {', '.join(FILES)} from {ref[:12]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
