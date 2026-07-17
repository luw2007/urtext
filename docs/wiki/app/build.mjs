/* Build a single self-contained app/index.html from the wiki docs.
 * Run:  node app/build.mjs
 * - EN sources are read from the wiki root (parent of app/).
 * - ZH translations are read from app/content/zh/<same-path>.
 * - marked, CSS, and JS are inlined so index.html works offline (file://). */
import { readFile, writeFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = __dirname;                 // .../docs/wiki/app
const ROOT = resolve(APP, "..");       // .../docs/wiki
const ZH = join(APP, "content", "zh");

// Ordered document structure — mirrors index.md's three layers.
const NAV = [
  {
    title: "Overview",
    title_zh: "概览",
    items: [{ path: "index.md", title: "Introduction", title_zh: "简介" }],
  },
  {
    title: "Concepts",
    title_zh: "理念",
    items: [
      { path: "concepts/01-paradigm-shift.md", idx: "1", title: "The Paradigm Shift", title_zh: "范式转变" },
      { path: "concepts/02-assembly-to-c.md", idx: "2", title: "Assembly to C", title_zh: "从汇编到 C" },
      { path: "concepts/03-why-decidable.md", idx: "3", title: "Why Specs Must Be Decidable", title_zh: "规范为何必须可判定" },
      { path: "concepts/04-vs-spec-driven-dev.md", idx: "4", title: "Urtext vs Spec-Driven Dev", title_zh: "Urtext 与规范驱动开发" },
      { path: "concepts/05-source-of-truth-flip.md", idx: "5", title: "The Source-of-Truth Flip", title_zh: "事实源翻转" },
      { path: "concepts/06-metaphor.md", idx: "6", title: "The Urtext Metaphor", title_zh: "Urtext 隐喻" },
    ],
  },
  {
    title: "Mechanisms",
    title_zh: "机制",
    items: [
      { path: "mechanisms/01-clause-and-oracle.md", idx: "1", title: "Clauses and Oracles", title_zh: "子句与 oracle" },
      { path: "mechanisms/02-registry.md", idx: "2", title: "The Registry", title_zh: "注册表" },
      { path: "mechanisms/03-verifier.md", idx: "3", title: "The Verifier", title_zh: "验证器" },
      { path: "mechanisms/04-linker-impact.md", idx: "4", title: "The Linker", title_zh: "链接器" },
      { path: "mechanisms/05-dwarf-mapping.md", idx: "5", title: "DWARF Mapping", title_zh: "DWARF 映射" },
      { path: "mechanisms/06-meta-audit-gate.md", idx: "6", title: "Meta-Audit and the Gate", title_zh: "元审计与裁决门" },
      { path: "mechanisms/07-unsafe-lane.md", idx: "7", title: "The Unsafe Lane", title_zh: "不安全通道" },
    ],
  },
  {
    title: "Guides",
    title_zh: "指南",
    items: [
      { path: "guides/01-quickstart.md", idx: "1", title: "Quickstart", title_zh: "快速开始" },
      { path: "guides/02-authoring-clauses.md", idx: "2", title: "Authoring Clauses", title_zh: "编写子句" },
      { path: "guides/03-command-reference.md", idx: "3", title: "Command Reference", title_zh: "命令参考" },
      { path: "guides/04-persistence-model.md", idx: "4", title: "Persistence Model", title_zh: "持久化模型" },
      { path: "guides/05-adoption-and-limits.md", idx: "5", title: "Adoption and Limits", title_zh: "采用与边界" },
    ],
  },
];

async function readIfExists(p) {
  try {
    await stat(p);
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function main() {
  const order = [];
  const docs = {};
  let zhCount = 0;

  for (const group of NAV) {
    for (const item of group.items) {
      order.push(item.path);
      const en = await readFile(join(ROOT, item.path), "utf8");
      const zh = await readIfExists(join(ZH, item.path));
      if (zh) zhCount++;
      docs[item.path] = {
        title: item.title,
        title_zh: item.title_zh,
        en,
        zh: zh || null,
      };
    }
  }

  const data = {
    docs,
    order,
    nav: NAV.map((g) => ({
      title: g.title,
      title_zh: g.title_zh,
      items: g.items.map((i) => ({
        path: i.path,
        idx: i.idx || "",
        title: i.title,
        title_zh: i.title_zh,
      })),
    })),
  };

  const marked = await readFile(join(APP, "vendor", "marked.min.js"), "utf8");
  const css = await readFile(join(APP, "src", "app.css"), "utf8");
  const js = await readFile(join(APP, "src", "app.js"), "utf8");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Urtext Docs</title>
<style>
${css}
</style>
</head>
<body>
<header class="app-header">
  <button class="icon-btn" id="menu-btn" title="侧边栏 / Sidebar" aria-label="Toggle sidebar">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
  </button>
  <div class="brand">Urtext <span class="tag">Code is just an interpretation.</span></div>
  <div class="spacer"></div>
  <div class="seg" role="group" aria-label="Language">
    <button data-lang-btn="zh">中文</button>
    <button data-lang-btn="en">EN</button>
  </div>
  <button class="icon-btn" id="theme-btn" title="主题 / Theme" aria-label="Toggle theme"></button>
</header>
<div class="app-body">
  <nav class="sidebar" id="sidebar"></nav>
  <div class="scrim"></div>
  <div class="content-wrap">
    <main class="content" id="content"></main>
  </div>
</div>
<script>
${marked}
</script>
<script>
window.__URTEXT__ = ${JSON.stringify(data)};
</script>
<script>
${js}
</script>
</body>
</html>
`;

  await writeFile(join(APP, "index.html"), html, "utf8");
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(
    `built app/index.html (${kb} KB) — ${order.length} docs, ${zhCount} with zh translations`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
