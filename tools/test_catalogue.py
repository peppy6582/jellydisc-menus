"""Tests for the catalogue checker and the index builder: every rule has a case that must fail, and the real seeds
must pass. Run:  python3 -m unittest discover -s tools -p 'test_*.py'   (needs jsonschema and the plugin checkout)
"""
import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, HERE)
PLUGIN = os.environ.get("PLUGIN_DIR") or os.path.join(ROOT, "..", "jellyfin-disc-menus")

from catalogue_check import check_catalogue  # noqa: E402
import build_index  # noqa: E402

INCEPTION = "0b311cdd-e7c2-4e27-b4bc-fb1e5acebfc8"
INCEPTION_DIR = "menus/movie/27205"
DARK_KNIGHT = "3be8f617-e13f-4e71-9da1-3c43bd3fc319"


class Catalogue(unittest.TestCase):
    """Each test gets its own copy of the real catalogue to break."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="cat-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = os.path.join(self.tmp, "cat")
        for part in ("schema", "config", "menus"):
            shutil.copytree(os.path.join(ROOT, part), os.path.join(self.root, part))

    # ---- helpers
    def path(self, rel):
        return os.path.join(self.root, rel)

    def menu_rel(self, mid=INCEPTION, d=INCEPTION_DIR):
        return f"{d}/{mid}.menu.json"

    def listing_rel(self, mid=INCEPTION, d=INCEPTION_DIR):
        return f"{d}/{mid}.listing.json"

    def read(self, rel):
        with open(self.path(rel), encoding="utf-8") as f:
            return json.load(f)

    def write(self, rel, doc):
        os.makedirs(os.path.dirname(self.path(rel)), exist_ok=True)
        with open(self.path(rel), "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=1)

    def edit_menu(self, fn, mid=INCEPTION, d=INCEPTION_DIR):
        doc = self.read(self.menu_rel(mid, d))
        fn(doc)
        self.write(self.menu_rel(mid, d), doc)

    def edit_listing(self, fn, mid=INCEPTION, d=INCEPTION_DIR):
        doc = self.read(self.listing_rel(mid, d))
        fn(doc)
        self.write(self.listing_rel(mid, d), doc)

    def check(self, base=None):
        return check_catalogue(self.root, PLUGIN, base)

    def errors(self, base=None):
        problems, _ = self.check(base)
        return [p for p in problems if p.severity == "error"]

    def warnings(self):
        problems, _ = self.check()
        return [p for p in problems if p.severity == "warning"]

    def assertFails(self, needle, base=None):
        errs = self.errors(base)
        self.assertTrue(errs, "expected an error but the catalogue passed")
        text = "\n".join(f"{p.file}: {p.message}" for p in errs)
        self.assertIn(needle.lower(), text.lower(), text)

    def first_entry(self, doc):
        return next(iter(doc["menus"].values()))["entries"][0]

    # ---- the real catalogue
    def test_seeds_pass(self):
        problems, entries = self.check()
        self.assertEqual([], [p for p in problems if p.severity == "error"])
        self.assertEqual(5, len(entries))

    # ---- files
    def test_invalid_json(self):
        with open(self.path(self.menu_rel()), "w") as f:
            f.write("{ not json")
        self.assertFails("not valid JSON")

    def test_duplicate_keys(self):
        with open(self.path(self.menu_rel()), "w") as f:
            f.write('{"schemaVersion":1,"schemaVersion":1}')
        self.assertFails("duplicate key")

    def test_bom(self):
        with open(self.path(self.menu_rel()), "rb") as f:
            raw = f.read()
        with open(self.path(self.menu_rel()), "wb") as f:
            f.write(b"\xef\xbb\xbf" + raw)
        self.assertFails("byte order mark")

    def test_not_utf8(self):
        with open(self.path(self.menu_rel()), "wb") as f:
            f.write(b"\xff\xfe{}")
        self.assertFails("utf-8")

    def test_oversized_menu(self):
        def pad(doc):
            doc["meta"]["notes"] = "x"
        self.edit_menu(pad)
        with open(self.path(self.menu_rel()), "a") as f:
            f.write(" " * (129 * 1024))
        self.assertFails("limit")

    def test_stray_file(self):
        self.write(f"{INCEPTION_DIR}/notes.json", {})
        self.assertFails("unexpected file")

    def test_uppercase_file_name(self):
        shutil.copy(self.path(self.menu_rel()), self.path(f"{INCEPTION_DIR}/{INCEPTION.upper()}.menu.json"))
        self.assertFails("unexpected file")

    def test_unexpected_folder(self):
        self.write("menus/anime/1/x.json", {})
        self.assertFails("unexpected folder")

    def test_symlink(self):
        os.symlink(self.path(self.menu_rel()), self.path(f"{INCEPTION_DIR}/{'1' * 8}-1111-1111-1111-{'1' * 12}.menu.json"))
        self.assertFails("symbolic link")

    def test_listing_without_menu(self):
        os.remove(self.path(self.menu_rel()))
        self.assertFails("no menu file beside it")

    def test_menu_without_listing(self):
        os.remove(self.path(self.listing_rel()))
        self.assertFails("missing its listing")

    # ---- the menu against its place
    def test_filename_id_must_match_menu_id(self):
        self.edit_menu(lambda d: d.update(menuId="11111111-1111-4111-8111-111111111111"))
        self.assertFails("must equal the menu's menuid")

    def test_folder_tmdb_must_match(self):
        shutil.move(self.path(INCEPTION_DIR), self.path("menus/movie/28000"))
        self.assertFails("folder's TMDB id")

    def test_kind_folder_must_match_item_type(self):
        shutil.move(self.path(INCEPTION_DIR), self.path("menus/movie/27205.tmp"))
        os.makedirs(self.path("menus/tv"), exist_ok=True)
        shutil.move(self.path("menus/movie/27205.tmp"), self.path("menus/tv/27205"))
        self.assertFails("belongs under menus/movie")

    def test_tmdb_id_required(self):
        def drop(d):
            d["match"]["providerIds"] = {"Imdb": "tt1375666"}
        self.edit_menu(drop)
        self.assertFails("Tmdb id")

    def test_schema_violation_reported(self):
        self.edit_menu(lambda d: d.update(unknownProperty=1))
        self.assertFails("unknownProperty")

    def test_a_fanart_background_is_a_feature_that_needs_a_newer_plugin(self):
        def fanart(d):
            d["background"] = {"source": "fanart", "fanartId": "47835", "dim": 0.5}
        self.edit_menu(fanart)
        problems, entries = self.check()
        self.assertEqual([], [p for p in problems if p.severity == "error"])
        entry = next(e for e in entries if e.menu["menuId"] == INCEPTION)
        self.assertIn("fanart-background", entry.features)
        self.assertEqual({"fanart"}, {b for b in entry.backgrounds})

    def test_fanart_id_must_be_digits(self):
        for bad in ("abc", "", "1234567890123", "../1"):
            self.edit_menu(lambda d, b=bad: d.update(background={"source": "fanart", "fanartId": b}))
            self.assertTrue(self.errors(), repr(bad))

    # ---- text
    def test_markup_in_author(self):
        def bad(d):
            d["meta"]["author"] = "<script>alert(1)</script>"
        self.edit_menu(bad)
        self.assertTrue(self.errors())

    def test_control_character_in_notes(self):
        def bad(d):
            d["meta"]["notes"] = "bell\u0007here"
        self.edit_menu(bad)
        self.assertTrue(self.errors())

    def test_unedited_draft_rejected(self):
        def bad(d):
            d["meta"]["author"] = "auto-draft"
        self.edit_menu(bad)
        self.assertFails("auto-generated draft")

    def test_draft_notes_rejected(self):
        def bad(d):
            d["meta"]["notes"] = "Draft generated from this server's library for Inception"
        self.edit_menu(bad)
        self.assertFails("auto-generated draft")

    def test_rip_name_label_rejected(self):
        def bad(d):
            self.first_entry(d)["label"] = "Inception.2010.1080p.mkv"
        self.edit_menu(bad)
        self.assertFails("ripped file")

    def test_draft_style_label_warns(self):
        def label(d):
            self.first_entry(d)["label"] = "Featurette 1 (5:10)"
        self.edit_menu(label)
        self.assertEqual([], self.errors())
        self.assertTrue(any("auto-generated" in w.message for w in self.warnings()))

    # ---- images and audio
    def test_https_image_rejected(self):
        def bad(d):
            self.first_entry(d)["image"] = "https://example.com/art.png"
        self.edit_menu(bad)
        self.assertFails("external image and audio links")

    def test_https_background_rejected(self):
        def bad(d):
            d["background"] = {"source": "image", "image": "https://example.com/bg.jpg"}
        self.edit_menu(bad)
        self.assertFails("external image and audio links")

    def test_asset_must_use_own_folder(self):
        def bad(d):
            d["background"] = {"source": "image", "image": "asset:other-menu/bg.webp"}
        self.edit_menu(bad)
        self.assertFails("own id")

    def test_asset_own_folder_is_listed_as_needed_art(self):
        problems, entries = self.check()
        dk = next(e for e in entries if e.menu["menuId"] == DARK_KNIGHT)
        self.assertIn(f"asset:{DARK_KNIGHT}/background.webp", dk.needs_art)
        self.assertIn("asset-art", dk.features)

    def test_inline_image_size_limit(self):
        def bad(d):
            self.first_entry(d)["image"] = "data:image/png;base64," + "A" * 17000
        self.edit_menu(bad)
        self.assertTrue(self.errors())

    # ---- the listing
    def test_listing_licence_must_be_cc0(self):
        self.edit_listing(lambda d: d.update(licence="MIT"))
        self.assertFails("CC0-1.0")

    def test_listing_unknown_field(self):
        self.edit_listing(lambda d: d.update(extra=1))
        self.assertFails("extra")

    def test_listing_markup_rejected(self):
        self.edit_listing(lambda d: d.update(description="<b>bold</b>"))
        self.assertTrue(self.errors())

    def test_listing_menu_id_mismatch(self):
        self.edit_listing(lambda d: d.update(menuId="11111111-1111-4111-8111-111111111111"))
        self.assertFails("menuId must equal")

    def test_asset_art_needs_a_source(self):
        self.edit_listing(lambda d: d.update(artSources="none"), DARK_KNIGHT, "menus/movie/155")
        self.assertFails("artSources")

    def test_changelog_cannot_be_ahead_of_menu(self):
        def bad(d):
            d["changelog"] = [{"revision": 9, "date": "2026-10-02", "notes": "from the future"}]
        self.edit_listing(bad)
        self.assertFails("newer than the menu")

    # ---- whole-catalogue rules
    def test_duplicate_menu_id(self):
        # same id filed under a second TMDB folder
        os.makedirs(self.path("menus/movie/11"), exist_ok=True)
        shutil.copy(self.path(self.menu_rel()), self.path(f"menus/movie/11/{INCEPTION}.menu.json"))
        shutil.copy(self.path(self.listing_rel()), self.path(f"menus/movie/11/{INCEPTION}.listing.json"))
        self.assertFails("already used")

    def test_withdrawn_id_cannot_return(self):
        with open(self.path("config/withdrawn.json"), "w") as f:
            json.dump([{"menuId": INCEPTION, "date": "2026-10-02", "reason": "test"}], f)
        self.assertFails("withdrawn")

    # ---- against the previous catalogue
    def base_copy(self):
        base = os.path.join(self.tmp, "base")
        shutil.copytree(os.path.join(self.root, "menus"), os.path.join(base, "menus"))
        return base

    def test_unchanged_passes_against_base(self):
        self.assertEqual([], self.errors(self.base_copy()))

    def test_change_without_revision_bump(self):
        base = self.base_copy()
        self.edit_menu(lambda d: d["meta"].update(notes="changed"))
        self.assertFails("revision must go up", base)

    def test_bump_without_changelog(self):
        base = self.base_copy()

        def bump(d):
            d["revision"] += 1
            d["meta"]["notes"] = "changed"
        self.edit_menu(bump)
        self.assertFails("needs a changelog entry", base)

    def test_bump_with_changelog_passes(self):
        base = self.base_copy()
        rev = self.read(self.menu_rel())["revision"] + 1

        def bump(d):
            d["revision"] = rev
            d["meta"]["notes"] = "changed"
        self.edit_menu(bump)
        self.edit_listing(lambda d: d.update(changelog=[{"revision": rev, "date": "2026-10-02", "notes": "Reworded the notes."}]))
        self.assertEqual([], self.errors(base))

    def test_removal_without_withdrawal(self):
        base = self.base_copy()
        os.remove(self.path(self.menu_rel()))
        os.remove(self.path(self.listing_rel()))
        self.assertFails("withdrawn.json", base)

    def test_removal_with_withdrawal_passes(self):
        base = self.base_copy()
        os.remove(self.path(self.menu_rel()))
        os.remove(self.path(self.listing_rel()))
        with open(self.path("config/withdrawn.json"), "w") as f:
            json.dump([{"menuId": INCEPTION, "date": "2026-10-02", "reason": "test"}], f)
        self.assertEqual([], self.errors(base))


class Index(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="cat-index-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def build(self, root=ROOT, out=None, generated="2026-10-02T12:00:00Z"):
        return build_index.build(root, PLUGIN, out or os.path.join(self.tmp, "out"), generated, history=False)

    def test_index_matches_its_schema(self):
        from jsonschema import Draft202012Validator, FormatChecker
        index = self.build()
        with open(os.path.join(ROOT, "schema", "index.schema.json"), encoding="utf-8") as f:
            schema = json.load(f)
        errs = list(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(index))
        self.assertEqual([], [e.message for e in errs])
        self.assertEqual(5, len(index["entries"]))

    def test_files_match_their_hashes(self):
        out = os.path.join(self.tmp, "out")
        index = self.build(out=out)
        for e in index["entries"]:
            with open(os.path.join(out, e["url"]), "rb") as f:
                raw = f.read()
            self.assertEqual(e["sha256"], hashlib.sha256(raw).hexdigest())
            self.assertEqual(e["size"], len(raw))

    def test_output_is_reproducible(self):
        a, b = os.path.join(self.tmp, "a"), os.path.join(self.tmp, "b")
        self.build(out=a)
        self.build(out=b)
        with open(os.path.join(a, "v1", "index.json"), "rb") as fa, open(os.path.join(b, "v1", "index.json"), "rb") as fb:
            self.assertEqual(fa.read(), fb.read())

    def test_min_plugin_version_uses_the_newest_feature(self):
        self.assertEqual("0.3.0", build_index.min_plugin_version(["layout", "x"], {"layout": "0.1.0", "x": "0.3.0"}))
        self.assertEqual("0.1.0", build_index.min_plugin_version([], {}))
        self.assertEqual("0.10.0", build_index.min_plugin_version(["a", "b"], {"a": "0.9.0", "b": "0.10.0"}))

    def test_refuses_to_build_a_broken_catalogue(self):
        root = os.path.join(self.tmp, "cat")
        for part in ("schema", "config", "menus"):
            shutil.copytree(os.path.join(ROOT, part), os.path.join(root, part))
        with open(os.path.join(root, self.menu_path()), "w") as f:
            f.write("nope")
        with self.assertRaises(SystemExit):
            self.build(root=root)

    @staticmethod
    def menu_path():
        return f"{INCEPTION_DIR}/{INCEPTION}.menu.json"

    def test_extras_count_is_the_number_the_menu_lists(self):
        index = self.build()
        for e in index["entries"]:
            with open(os.path.join(ROOT, "menus", e["match"]["itemType"] == "Movie" and "movie" or "tv", e["match"]["providerIds"]["Tmdb"], e["menuId"] + ".menu.json"), encoding="utf-8") as f:
                self.assertEqual(len(json.load(f).get("extras") or {}), e["extras"], e["title"])
        self.assertTrue(any(e["extras"] > 0 for e in index["entries"]))

    def test_demo_and_art_flags(self):
        index = self.build()
        dk = next(e for e in index["entries"] if e["menuId"] == DARK_KNIGHT)
        self.assertTrue(dk["demo"])
        self.assertTrue(dk["needsLocalArt"])
        self.assertEqual(dk["match"]["providerIds"]["Tmdb"], "155")


if __name__ == "__main__":
    unittest.main()
