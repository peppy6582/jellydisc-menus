// Per-menu page values as plain strings. (Front-matter computed values are themselves templates and would be escaped twice
// once the layout escapes them again: an apostrophe in a title would show as &#39; in the browser tab and share cards.)
export default {
  eleventyComputed: {
    title: (data) => data.e.title,
    description: (data) => data.e.description,
    ogImage: (data) => data.e.thumb,
  },
};
