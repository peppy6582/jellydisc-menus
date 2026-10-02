// The site is built from the catalogue folder that tools/build_index.py writes (CATALOGUE_DIR, default _catalogue):
// its index.json is the single source of truth, so the site can only show menus that passed every check.
export default function (eleventyConfig) {
  // The published catalogue itself: the index, every menu revision, and the schemas.
  const dir = process.env.CATALOGUE_DIR || "_catalogue";
  eleventyConfig.addPassthroughCopy({ [`${dir}/v1`]: "v1", [`${dir}/schema`]: "schema" });
  eleventyConfig.addPassthroughCopy({ "site/assets": "assets" });
  // The renderer and adapter from the plugin, pinned (see tools/vendor_sync.py and vendor/VERSION.json).
  eleventyConfig.addPassthroughCopy({ vendor: "assets/vendor" });
  eleventyConfig.setQuietMode(true);
  return {
    dir: { input: "site", includes: "_includes", data: "_data", output: "_site" },
    // GitHub Pages serves a project site under /<repo>/. Every internal link goes through the `url` filter.
    pathPrefix: process.env.SITE_PREFIX || "/jellydisc-menus/",
    templateFormats: ["njk", "md"],
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
  };
}
