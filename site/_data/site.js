// Site-wide values. The public address is used only for share-card meta tags (which need absolute URLs).
export default {
  name: "Disc Menus catalogue",
  url: (process.env.SITE_URL || "https://peppy6582.github.io/jellydisc-menus/").replace(/\/?$/, "/"),
  tagline: "Shareable DVD and Blu-ray style menus for Jellyfin, in public-domain JSON.",
};
