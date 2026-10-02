// Full-text search with Pagefind's index. Results are built with textContent only, never innerHTML.
const base = document.body.dataset.base;
const input = document.getElementById("s-q");
const status = document.getElementById("s-status");
const list = document.getElementById("s-results");
let pagefind = null;
let ticket = 0;

async function load() {
  if (!pagefind) {
    pagefind = await import(base + "pagefind/pagefind.js");
    await pagefind.options({ baseUrl: base });
  }
  return pagefind;
}

function card(data) {
  const li = document.createElement("li");
  li.className = "card";
  const href = data.url;
  // a thumbnail only if it is one of this site's own files
  const image = data.meta && data.meta.image;
  if (typeof image === "string" && image.startsWith(base + "assets/thumbs/") && !image.includes("..")) {
    const t = document.createElement("a");
    t.className = "thumb";
    t.href = href;
    t.tabIndex = -1;
    t.setAttribute("aria-hidden", "true");
    const img = document.createElement("img");
    img.src = image;
    img.alt = "";
    img.width = 640;
    img.height = 360;
    img.loading = "lazy";
    t.appendChild(img);
    li.appendChild(t);
  }
  const body = document.createElement("div");
  body.className = "body";
  const h = document.createElement("h3");
  const a = document.createElement("a");
  a.textContent = (data.meta && data.meta.title) || data.url;
  a.href = href;
  h.appendChild(a);
  const p = document.createElement("p");
  p.className = "desc";
  p.textContent = data.raw_content ? data.raw_content.slice(0, 200) : "";
  body.append(h, p);
  li.appendChild(body);
  return li;
}

async function run() {
  const mine = ++ticket;
  const text = input.value.trim();
  list.replaceChildren();
  if (!text) { status.textContent = ""; return; }
  try {
    const pf = await load();
    const found = await pf.search(text);
    if (mine !== ticket) return;
    const datas = await Promise.all(found.results.slice(0, 30).map((r) => r.data()));
    if (mine !== ticket) return;
    status.textContent = found.results.length + (found.results.length === 1 ? " menu" : " menus");
    datas.forEach((d) => list.appendChild(card(d)));
  } catch (e) {
    status.textContent = "Search isn't available right now. You can browse the list instead.";
  }
}

document.getElementById("s-form").addEventListener("submit", (e) => { e.preventDefault(); run(); });
input.addEventListener("input", run);
