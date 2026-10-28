// Site-wide values. The public address is used for share-card meta tags (which need absolute URLs).
// The catalogue's data stays at peppy6582.github.io/jellydisc-menus/ (the plugin and every installed menu point there),
// while people browse the copy of this site at discs.astermediaplayer.com, built by AsterMediaPlayer/discs.
const HOME = "https://discs.astermediaplayer.com/";
const url = (process.env.SITE_URL || "https://peppy6582.github.io/jellydisc-menus/").replace(/\/?$/, "/");
export default {
  name: "Disc Menus catalogue",
  url,
  // Where search engines and the "moved" banner send people.
  home: HOME,
  // True for the build at the old github.io address, which shows a banner pointing to the new site.
  moved: url !== HOME,
  tagline: "Shareable DVD and Blu-ray style menus for Jellyfin, in public-domain JSON.",
};
