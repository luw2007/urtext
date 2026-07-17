/* Urtext Docs — standalone app runtime.
 * DOCS (map of "relative/path.md" -> { en, zh, title }) and NAV (ordered nav
 * structure) are injected by the build step as `window.__URTEXT__`. */
(function () {
  "use strict";

  var DATA = window.__URTEXT__ || { docs: {}, nav: [], order: [] };
  var DOCS = DATA.docs;
  var NAV = DATA.nav;
  var ORDER = DATA.order; // flat ordered list of paths for prev/next

  // ---- Persisted preferences ----
  var LS = window.localStorage;
  function pref(key, fallback) {
    try { var v = LS.getItem(key); return v === null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function setPref(key, val) { try { LS.setItem(key, val); } catch (e) {} }

  var state = {
    lang: pref("urtext.lang", detectLang()),
    theme: pref("urtext.theme", detectTheme()),
    collapsed: pref("urtext.sidebar", "0") === "1",
    path: "index.md"
  };

  function detectLang() {
    var n = (navigator.language || "en").toLowerCase();
    return n.indexOf("zh") === 0 ? "zh" : "en";
  }
  function detectTheme() {
    try {
      return window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark" : "light";
    } catch (e) { return "light"; }
  }

  // ---- Markdown rendering (marked, GFM) ----
  marked.use({ gfm: true, breaks: false });
  var renderer = new marked.Renderer();
  var baseLink = renderer.link.bind(renderer);
  // We post-process links in the DOM instead of here, so keep default render.

  function normalizePath(from, target) {
    // Resolve a relative md target against the current doc path.
    // from = "concepts/01-x.md", target = "../guides/05-y.md"
    var base = from.split("/").slice(0, -1);
    var parts = target.split("/");
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === "." || parts[i] === "") continue;
      if (parts[i] === "..") { base.pop(); continue; }
      base.push(parts[i]);
    }
    return base.join("/");
  }

  function renderDoc(path) {
    var doc = DOCS[path];
    if (!doc) return "<h1>404</h1><p>Document not found: " + esc(path) + "</p>";
    var lang = state.lang;
    var md = doc[lang];
    var fellBack = false;
    if (!md) { md = doc.en; fellBack = true; }
    var html = marked.parse(md || "");
    var banner = "";
    if (fellBack && lang === "zh") {
      banner =
        '<div class="lang-fallback">该页面暂无中文翻译，显示英文原文。</div>';
    }
    return banner + '<div class="md">' + html + "</div>";
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ---- Link + table post-processing on rendered DOM ----
  function processContent(container, path) {
    // Wrap tables for horizontal scroll
    var tables = container.querySelectorAll("table");
    tables.forEach(function (t) {
      if (t.parentElement && t.parentElement.classList.contains("table-scroll"))
        return;
      var wrap = document.createElement("div");
      wrap.className = "table-scroll";
      t.parentNode.insertBefore(wrap, t);
      wrap.appendChild(t);
    });

    // Fix links
    var links = container.querySelectorAll("a[href]");
    links.forEach(function (a) {
      var href = a.getAttribute("href");
      if (!href) return;

      // external
      if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
        a.classList.add("external");
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
        return;
      }
      // pure in-page anchor
      if (href.charAt(0) === "#") {
        a.addEventListener("click", function (e) {
          e.preventDefault();
          scrollToAnchor(href.slice(1));
        });
        return;
      }
      // relative md link, possibly with #anchor
      var hashIdx = href.indexOf("#");
      var rel = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
      var anchor = hashIdx >= 0 ? href.slice(hashIdx + 1) : "";
      if (!rel) { // e.g. "#C003" already handled; guard
        return;
      }
      var resolved = normalizePath(path, rel);
      if (DOCS[resolved]) {
        a.setAttribute("href", "#/" + resolved + (anchor ? "#" + anchor : ""));
        a.addEventListener("click", function (e) {
          e.preventDefault();
          navigate(resolved, anchor);
        });
      } else {
        // Target doc not in the app — a broken/out-of-scope link.
        // Repair by making it non-navigating and clearly marked, keeping text.
        a.classList.add("missing");
        a.setAttribute(
          "title",
          "该链接指向文档集之外的文件：" + rel
        );
        a.removeAttribute("href");
        a.addEventListener("click", function (e) { e.preventDefault(); });
      }
    });
  }

  function scrollToAnchor(id) {
    if (!id) return;
    var target =
      document.getElementById(id) ||
      findHeadingByText(id);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function slugify(text) {
    return String(text)
      .toLowerCase()
      .trim()
      .replace(/[^\w\u4e00-\u9fa5\- ]/g, "")
      .replace(/\s+/g, "-");
  }

  function findHeadingByText(id) {
    // marked doesn't add ids by default; we add them in assignHeadingIds.
    return document.getElementById(id);
  }

  function assignHeadingIds(container) {
    var used = {};
    container.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach(function (h) {
      var base = slugify(h.textContent) || "section";
      var id = base, n = 1;
      while (used[id]) { id = base + "-" + n++; }
      used[id] = true;
      h.id = id;
    });
  }

  // ---- Navigation ----
  function navigate(path, anchor) {
    if (!DOCS[path]) path = "index.md";
    state.path = path;
    var hash = "#/" + path + (anchor ? "#" + anchor : "");
    if (location.hash !== hash) {
      history.pushState(null, "", hash);
    }
    render(anchor);
    if (document.body.classList.contains("sidebar-open")) {
      document.body.classList.remove("sidebar-open");
    }
  }

  function parseHash() {
    var h = location.hash || "";
    if (h.indexOf("#/") !== 0) return { path: "index.md", anchor: "" };
    var rest = h.slice(2);
    // path may itself contain a trailing #anchor
    var hi = rest.indexOf("#");
    var path = hi >= 0 ? rest.slice(0, hi) : rest;
    var anchor = hi >= 0 ? rest.slice(hi + 1) : "";
    if (!DOCS[path]) path = "index.md";
    return { path: path, anchor: anchor };
  }

  // ---- Rendering the whole page ----
  var elContent, elSidebar;

  function render(anchor) {
    var path = state.path;
    document.documentElement.setAttribute("data-theme", state.theme);

    elContent.innerHTML = renderDoc(path) + renderPageNav(path);
    var md = elContent.querySelector(".md");
    if (md) {
      assignHeadingIds(md);
      processContent(md, path);
    }
    // page-nav links
    elContent.querySelectorAll("a[data-nav]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        navigate(a.getAttribute("data-nav"), "");
        window.scrollTo({ top: 0 });
      });
    });

    renderSidebar();
    updateToggleUI();

    if (anchor) {
      setTimeout(function () { scrollToAnchor(anchor); }, 40);
    } else {
      window.scrollTo({ top: 0 });
    }
    document.title = titleFor(path) + " · Urtext Docs";
  }

  function titleFor(path) {
    var d = DOCS[path];
    if (!d) return path;
    return (state.lang === "zh" && d.title_zh) ? d.title_zh : d.title;
  }

  function renderSidebar() {
    var html = "";
    NAV.forEach(function (group) {
      html += '<div class="group">';
      var gt = state.lang === "zh" ? group.title_zh || group.title : group.title;
      html += '<div class="group-title">' + esc(gt) + "</div>";
      group.items.forEach(function (item) {
        var active = item.path === state.path ? " active" : "";
        var label =
          state.lang === "zh" && item.title_zh ? item.title_zh : item.title;
        var idx = item.idx ? '<span class="idx">' + item.idx + "</span>" : "";
        html +=
          '<a class="nav-link' + active + '" href="#/' + item.path + '" data-path="' +
          item.path + '">' + idx + esc(label) + "</a>";
      });
      html += "</div>";
    });
    elSidebar.innerHTML = html;
    elSidebar.querySelectorAll("a.nav-link").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        navigate(a.getAttribute("data-path"), "");
      });
    });
  }

  function renderPageNav(path) {
    var i = ORDER.indexOf(path);
    if (i < 0) return "";
    var prev = i > 0 ? ORDER[i - 1] : null;
    var next = i < ORDER.length - 1 ? ORDER[i + 1] : null;
    var out = '<div class="page-nav">';
    var prevLbl = state.lang === "zh" ? "上一页" : "Previous";
    var nextLbl = state.lang === "zh" ? "下一页" : "Next";
    if (prev) {
      out +=
        '<a class="prev" data-nav="' + prev + '"><div class="dir">← ' +
        prevLbl + '</div><div class="ttl">' + esc(titleFor(prev)) + "</div></a>";
    }
    if (next) {
      out +=
        '<a class="next" data-nav="' + next + '"><div class="dir">' +
        nextLbl + ' →</div><div class="ttl">' + esc(titleFor(next)) +
        "</div></a>";
    }
    out += "</div>";
    return out;
  }

  // ---- Toggle UI wiring ----
  function updateToggleUI() {
    document.body.classList.toggle("sidebar-collapsed", state.collapsed);
    document.querySelectorAll("[data-lang-btn]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-lang-btn") === state.lang);
    });
    var tb = document.getElementById("theme-btn");
    if (tb) {
      tb.innerHTML = state.theme === "dark" ? ICON.sun : ICON.moon;
      tb.setAttribute("title", state.theme === "dark" ? "浅色 / Light" : "深色 / Dark");
    }
  }

  var ICON = {
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.9" y1="4.9" x2="7" y2="7"/><line x1="17" y1="17" x2="19.1" y2="19.1"/><line x1="4.9" y1="19.1" x2="7" y2="17"/><line x1="17" y1="7" x2="19.1" y2="4.9"/></svg>'
  };

  function bindControls() {
    document.getElementById("menu-btn").addEventListener("click", function () {
      if (window.matchMedia("(max-width: 900px)").matches) {
        document.body.classList.toggle("sidebar-open");
      } else {
        state.collapsed = !state.collapsed;
        setPref("urtext.sidebar", state.collapsed ? "1" : "0");
        updateToggleUI();
      }
    });

    document.getElementById("theme-btn").addEventListener("click", function () {
      state.theme = state.theme === "dark" ? "light" : "dark";
      setPref("urtext.theme", state.theme);
      document.documentElement.setAttribute("data-theme", state.theme);
      updateToggleUI();
    });

    document.querySelectorAll("[data-lang-btn]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.lang = b.getAttribute("data-lang-btn");
        setPref("urtext.lang", state.lang);
        render("");
      });
    });

    document.querySelector(".scrim").addEventListener("click", function () {
      document.body.classList.remove("sidebar-open");
    });

    window.addEventListener("popstate", function () {
      var p = parseHash();
      state.path = p.path;
      render(p.anchor);
    });
  }

  // ---- Boot ----
  document.addEventListener("DOMContentLoaded", function () {
    elContent = document.getElementById("content");
    elSidebar = document.getElementById("sidebar");
    document.documentElement.setAttribute("data-theme", state.theme);
    bindControls();
    var p = parseHash();
    state.path = p.path;
    render(p.anchor);
  });
})();
