# Policy

*This is a community project. It is not affiliated with Jellyfin or TMDB, and nothing here is legal advice.*

## What the catalogue contains

Menu layouts and structure as JSON, plus a short description of each. It contains **no artwork, music or video** and no
copies of anything belonging to a studio or distributor. Every menu is dedicated to the public domain
([CC0 1.0](menus/LICENSE)) by whoever submitted it.

## Takedowns

If you hold rights in something in the catalogue, or believe a menu infringes someone's rights, open an issue titled
"Takedown" naming the file and what you hold, or use the contact in [SECURITY.md of the plugin](https://github.com/peppy6582/jellydisc/blob/main/SECURITY.md)
if you'd rather not do it publicly. A menu under a good-faith claim is withdrawn first and discussed after: its files are
deleted and its id is added to `config/withdrawn.json`, which the index publishes so clients can tell their users. A
contributor may dispute a withdrawal in the same issue.

## Privacy

The catalogue site and the index are static files. The site sets no cookies and runs no analytics. GitHub, which hosts
them, sees requests as any web host does. A menu preview only loads third-party images (from TMDB) if the visitor
explicitly turns that on. Clients are expected to match menus against a library **locally**; nothing about a library is
ever sent to the catalogue.

## Moderation

Every change is a pull request reviewed by the maintainers (see `.github/CODEOWNERS`) after the automated checks pass.
Menus that are hostile (try to run code, track viewers, shock or harass) are refused, and repeat offenders are blocked.

## Security

Menus are treated as untrusted input everywhere: checked by two independent implementations of the rules, rendered as
text only, and fetched by clients only against a published hash. Report a problem as described in the plugin's
[SECURITY.md](https://github.com/peppy6582/jellydisc/blob/main/SECURITY.md).

## Attribution

Movie and series identifiers are TMDB, IMDb and TVDB ids. This product uses the TMDB API but is not endorsed or certified
by TMDB.
