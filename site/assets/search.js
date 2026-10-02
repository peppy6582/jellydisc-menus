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
  const h = document.createElement("h3");
  const a = document.createElement("a");
  a.textContent = (data.meta && data.meta.title) || data.url;
  a.href = data.url;
  h.appendChild(a);
  const p = document.createElement("p");
  p.textContent = data.raw_content ? data.raw_content.slice(0, 160) : "";
  li.append(h, p);
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
