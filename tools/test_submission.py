"""Tests for turning a submitted issue into catalogue files. The issue text is untrusted, so the cases include
hostile ones. Run: python3 -m unittest discover -s tools -p 'test_*.py'  (needs jsonschema and the plugin checkout)
"""
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

import submission  # noqa: E402

INCEPTION = "0b311cdd-e7c2-4e27-b4bc-fb1e5acebfc8"
NEW_ID = "99999999-2222-4333-8444-555555555555"


def form(menu, title="Inception, simply", description="A plain list of buttons.", tags="minimal, list",
         art="none", name="", confirm=3, fence=True):
    text = menu if isinstance(menu, str) else json.dumps(menu, indent=2)
    body = f"```json\n{text}\n```" if fence else text
    boxes = "\n".join(("- [X] " if i < confirm else "- [ ] ") + f"box {i}" for i in range(3))
    return (f"### Menu JSON\n\n{body}\n\n### Title\n\n{title}\n\n### Description\n\n{description}\n\n"
            f"### Tags\n\n{tags or '_No response_'}\n\n### Where the art comes from\n\n{art}\n\n"
            f"### Your name\n\n{name or '_No response_'}\n\n### Confirmations\n\n{boxes}\n")


class Submission(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sub-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = os.path.join(self.tmp, "cat")
        for part in ("schema", "config", "menus"):
            shutil.copytree(os.path.join(ROOT, part), os.path.join(self.root, part))
        with open(os.path.join(self.root, "menus/movie/27205", f"{INCEPTION}.menu.json"), encoding="utf-8") as f:
            self.base = json.load(f)
        self.base["menuId"] = NEW_ID
        self.base["meta"]["notes"] = "A second take."
        self.out = os.path.join(self.tmp, "out")

    def run_form(self, body, author="octocat"):
        return submission.build(body, author, self.root, PLUGIN, self.out)

    def fails(self, result, needle):
        self.assertFalse(result["ok"], "expected a failure")
        self.assertIn(needle.lower(), "\n".join(result["problems"]).lower(), result["problems"])

    def written(self):
        return sorted(os.listdir(os.path.join(self.root, "menus/movie/27205")))

    # ---- the good path
    def test_good_submission(self):
        r = self.run_form(form(self.base))
        self.assertTrue(r["ok"], r["problems"])
        self.assertEqual(f"menus/movie/27205/{NEW_ID}.menu.json", r["menuPath"])
        self.assertIn(f"{NEW_ID}.listing.json", self.written())
        with open(os.path.join(self.root, r["listingPath"]), encoding="utf-8") as f:
            listing = json.load(f)
        self.assertEqual({"name": "octocat", "github": "octocat"}, listing["author"])
        self.assertEqual("CC0-1.0", listing["licence"])
        self.assertEqual(["minimal", "list"], listing["tags"])
        self.assertEqual("none", listing["artSources"])
        self.assertFalse(listing["demo"])
        with open(os.path.join(self.out, "result.json")) as f:
            self.assertTrue(json.load(f)["ok"])
        with open(os.path.join(self.out, "comment.md")) as f:
            self.assertIn("passes", f.read())

    def test_the_catalogue_still_passes_with_the_new_files(self):
        self.assertTrue(self.run_form(form(self.base))["ok"])
        from catalogue_check import check_catalogue
        problems, entries = check_catalogue(self.root, PLUGIN)
        self.assertEqual([], [p for p in problems if p.severity == "error"])
        self.assertEqual(6, len(entries))

    def test_unfenced_json_and_chosen_name(self):
        r = self.run_form(form(json.dumps(self.base), fence=False, name="Pat Example"))
        self.assertTrue(r["ok"], r["problems"])
        with open(os.path.join(self.root, r["listingPath"]), encoding="utf-8") as f:
            self.assertEqual("Pat Example", json.load(f)["author"]["name"])

    def test_missing_menu_id_is_assigned(self):
        del self.base["menuId"]
        r = self.run_form(form(self.base))
        self.assertTrue(r["ok"], r["problems"])
        self.assertRegex(r["menuId"], r"^[0-9a-f-]{36}$")
        self.assertTrue(any("new one was made" in w for w in r["warnings"]))

    def test_upper_case_menu_id_is_lowered(self):
        self.base["menuId"] = NEW_ID.upper()
        r = self.run_form(form(self.base))
        self.assertTrue(r["ok"], r["problems"])
        self.assertEqual(NEW_ID, r["menuId"])

    # ---- what must be refused
    def test_not_the_form(self):
        self.fails(self.run_form("hello"), "missing")

    def test_confirmations_required(self):
        self.fails(self.run_form(form(self.base, confirm=2)), "three confirmations")
        self.assertNotIn(f"{NEW_ID}.menu.json", self.written())

    def test_invalid_json(self):
        self.fails(self.run_form(form("{ nope")), "valid JSON")

    def test_duplicate_keys(self):
        self.fails(self.run_form(form('{"menuId":"a","menuId":"b"}')), "duplicate key")

    def test_not_an_object(self):
        self.fails(self.run_form(form("[1,2]")), "JSON object")

    def test_too_large(self):
        self.fails(self.run_form(form(json.dumps({"x": "y" * 200000}))), "larger than")

    def test_existing_menu_id(self):
        self.base["menuId"] = INCEPTION
        r = self.run_form(form(self.base))
        self.fails(r, "already exists")
        self.assertEqual(2, len([f for f in self.written() if INCEPTION in f]))   # untouched

    def test_path_pieces_are_validated_before_use(self):
        for bad_id in ("../../../etc/passwd", "a/b", "x" * 40, "", 5, None):
            self.base["menuId"] = bad_id
            r = self.run_form(form(self.base))
            self.assertFalse(r["ok"], bad_id)
        self.base["menuId"] = NEW_ID
        for bad_tmdb in ("../x", "27205/../../x", "27205 ", "", 27205, "99999999999"):
            self.base["match"]["providerIds"]["Tmdb"] = bad_tmdb
            r = self.run_form(form(self.base))
            self.assertFalse(r["ok"], repr(bad_tmdb))
        self.base["match"]["providerIds"]["Tmdb"] = "27205"
        self.base["match"]["itemType"] = "../Movie"
        self.assertFalse(self.run_form(form(self.base))["ok"])
        # nothing was written anywhere
        self.assertEqual(sorted([f"{INCEPTION}.listing.json", f"{INCEPTION}.menu.json"]), self.written())
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "etc")))

    def test_tmdb_id_required(self):
        self.base["match"]["providerIds"] = {"Imdb": "tt1375666"}
        self.fails(self.run_form(form(self.base)), "Tmdb")

    def test_catalogue_rules_apply(self):
        self.base["meta"]["author"] = "auto-draft"
        self.fails(self.run_form(form(self.base)), "auto-generated draft")
        self.base["meta"]["author"] = "someone"
        self.base["background"] = {"source": "image", "image": "https://example.com/x.png"}
        self.fails(self.run_form(form(self.base)), "external image")

    def test_schema_errors_are_reported(self):
        self.base["surprise"] = 1
        self.fails(self.run_form(form(self.base)), "surprise")

    def test_listing_problems_are_reported(self):
        self.fails(self.run_form(form(self.base, description="x" * 400)), "(listing)")
        self.fails(self.run_form(form(self.base, title="<b>bold</b>")), "(listing)")
        self.fails(self.run_form(form(self.base, tags="Bad Tag!, ok")), "isn't allowed")
        self.fails(self.run_form(form(self.base, tags=",".join(f"t{i}" for i in range(9)))), "at most 8")

    def test_art_sources_must_be_stated_for_asset_menus(self):
        self.base["background"] = {"source": "image", "image": f"asset:{NEW_ID}/bg.webp"}
        self.fails(self.run_form(form(self.base, art="none")), "artSources")
        r = self.run_form(form(self.base, art="Generated by me, CC0; put bg.webp in the folder"))
        self.assertTrue(r["ok"], r["problems"])

    def test_a_bad_login_is_not_recorded(self):
        r = self.run_form(form(self.base), author="evil\"\n}, \"x\": 1")
        self.assertTrue(r["ok"], r["problems"])
        with open(os.path.join(self.root, r["listingPath"]), encoding="utf-8") as f:
            self.assertEqual({"name": "anonymous"}, json.load(f)["author"])

    # ---- the form parser and the comment
    def test_headings_inside_a_code_fence_are_not_headings(self):
        body = "### Menu JSON\n\n```json\n{\n### Title\n}\n```\n\n### Title\n\nReal\n"
        f = submission.parse_form(body)
        self.assertEqual("Real", f["Title"])
        self.assertIn("### Title", f["Menu JSON"])

    def test_no_response_is_empty(self):
        self.assertEqual("", submission.parse_form("### Tags\n\n_No response_\n")["Tags"])

    def test_comment_neutralises_user_text(self):
        result = {"ok": False, "warnings": ["see @everyone and https://evil.example"],
                  "problems": ["label `x` <img src=x onerror=alert(1)>\n@maintainers #1 [click](https://evil.example)"]}
        text = submission.render_comment(result)
        for line in text.splitlines():
            if line.startswith("- "):
                self.assertTrue(line.startswith("- ``") and line.rstrip().endswith("``"), line)
        self.assertNotIn("`x`", text)          # embedded backticks can't break out of the code span
        self.assertNotIn("\n@", text)
        self.assertLess(len(submission.code("y" * 5000)), 400)

    def test_pull_request_text(self):
        r = submission.build(form(self.base, title="Tricky @everyone `title` " + "z" * 60), "octocat", self.root, PLUGIN, self.out, issue=42)
        self.assertTrue(r["ok"], r["problems"])
        with open(os.path.join(self.out, "pr-title.txt")) as f:
            title = f.read()
        self.assertLessEqual(len(title), 100)
        self.assertNotIn("@", title)
        self.assertNotIn("`", title)
        self.assertNotIn("\n", title.strip())
        with open(os.path.join(self.out, "pr-body.md")) as f:
            body = f.read()
        self.assertIn("Closes #42", body)
        self.assertIn(r["menuPath"], body)

    def test_pr_title_is_one_short_plain_line(self):
        for raw in ("x" * 500, "a\nb\r\nc", "@everyone **bold** <b>[l](u)</b>", ""):
            t = submission.pr_title(raw)
            self.assertLessEqual(len(t), 100)
            self.assertFalse(set("@`*<>[]\n\r") & set(t), t)

    def test_failures_write_no_pull_request_text(self):
        self.run_form(form("{ nope"))
        self.assertFalse(os.path.exists(os.path.join(self.out, "pr-title.txt")))

    def test_cli_writes_github_output(self):
        body = os.path.join(self.tmp, "body.md")
        with open(body, "w", encoding="utf-8") as f:
            f.write(form(self.base))
        gh = os.path.join(self.tmp, "gh_output")
        code = submission.main(["--body", body, "--author", "octocat", "--plugin", PLUGIN, "--root", self.root,
                                "--out", self.out, "--github-output", gh])
        self.assertEqual(0, code)
        with open(gh) as f:
            text = f.read()
        self.assertIn("ok=true", text)
        self.assertIn(f"menu_id={NEW_ID}", text)
        self.assertEqual(2, submission.main(["--nope"]))


if __name__ == "__main__":
    unittest.main()
