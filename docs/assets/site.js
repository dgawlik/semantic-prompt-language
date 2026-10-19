/* SPL documentation runtime: layout, navigation, syntax highlighting, search, theme. No dependencies. */
(function () {
  "use strict";

  var NAV = [
    { group: "Introduction", items: [
      { id: "index", href: "index.html", title: "Overview" },
      { id: "getting-started", href: "getting-started.html", title: "Getting started" },
    ]},
    { group: "The language", items: [
      { id: "language", href: "language.html", title: "Language basics" },
      { id: "llm-commands", href: "llm-commands.html", title: "LLM commands" },
      { id: "restrictions", href: "restrictions.html", title: "Restrictions" },
      { id: "failures", href: "failures.html", title: "Failures & errors" },
    ]},
    { group: "Reference", items: [
      { id: "builtins", href: "builtins.html", title: "Built-ins" },
      { id: "cli", href: "cli.html", title: "CLI & runtime" },
      { id: "grammar", href: "grammar.html", title: "Grammar (EBNF)" },
    ]},
    { group: "Guides", items: [
      { id: "examples", href: "examples.html", title: "Examples" },
      { id: "editor", href: "editor.html", title: "VS Code extension" },
      { id: "internals", href: "internals.html", title: "Architecture" },
    ]},
  ];
  var FLAT = [];
  NAV.forEach(function (g) { g.items.forEach(function (i) { i.group = g.group; FLAT.push(i); }); });

  var page = document.body.getAttribute("data-page") || "index";

  var COLOR_SCHEME_KEY = "color-scheme";
  var NAV_BREAKPOINT = "(max-width: 56rem)"; /* keep in sync with the sidebar breakpoint in style.css */

  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (html != null) n.innerHTML = html;
    return n;
  }
  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function span(cls, text) { return '<span class="t-' + cls + '">' + esc(text) + "</span>"; }

  /* ---------- syntax highlighting ---------- */
  var KEYWORDS = "let if elif else for in while def return try except assert fail success enforce forbid restrict break continue pass and or not fs net exec mcp".split(" ");
  var TOOLS = "read_file write_file web_fetch web_search shell".split(" ");
  var CONSTS = ["True", "False", "None"];
  var BUILTINS = "len str int float bool type list range abs round min max sum sorted reversed enumerate zip any all keys values items json_parse json_stringify log".split(" ");
  var MODS = "len fmt level show path content url command model".split(" ");

  function highlightString(src, i) {
    var raw = src[i] === "r" && /['"]/.test(src[i + 1] || "");
    var start = i;
    if (raw) i++;
    var q = src.substr(i, 3);
    var delim = q === "'''" || q === '"""' ? q : src[i];
    i += delim.length;
    var out = "", buf = "";
    function flush() { if (buf) { out += span("string", buf); buf = ""; } }
    var prefix = raw ? "r" : "";
    buf = prefix + delim;
    while (i < src.length) {
      if (src.substr(i, delim.length) === delim) { buf += delim; i += delim.length; break; }
      var c = src[i];
      if (!raw && c === "\\") { buf += src.substr(i, 2); i += 2; continue; }
      if (!raw && c === "{" && src[i + 1] === "{") { buf += "{{"; i += 2; continue; }
      if (!raw && c === "}" && src[i + 1] === "}") { buf += "}}"; i += 2; continue; }
      if (!raw && c === "{") {
        var depth = 1, j = i + 1;
        while (j < src.length && depth > 0) {
          if (src[j] === "{") depth++;
          else if (src[j] === "}") depth--;
          j++;
        }
        flush();
        out += span("interp", src.slice(i, j));
        i = j;
        continue;
      }
      buf += c; i++;
    }
    flush();
    return { html: out, end: i, start: start };
  }

  function highlightSpl(src) {
    var out = "", i = 0, n = src.length, m;
    var prevWord = "";
    while (i < n) {
      var c = src[i];
      if (c === "#") {
        var e = src.indexOf("\n", i); if (e < 0) e = n;
        out += span("comment", src.slice(i, e)); i = e; continue;
      }
      if (c === '"' || c === "'" || (c === "r" && /['"]/.test(src[i + 1] || "") && !/\w/.test(src[i - 1] || ""))) {
        var s = highlightString(src, i); out += s.html; i = s.end; prevWord = ""; continue;
      }
      if (c === "@" && src[i + 1] === "{") { out += span("directive", "@"); i++; continue; }
      if (c === "?") { out += span("llm", "?"); i++; continue; }
      if ((m = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i, i + 40)))) { out += span("number", m[0]); i += m[0].length; continue; }
      if ((m = /^[A-Za-z_]\w*/.exec(src.slice(i, i + 80)))) {
        var w = m[0], after = src.slice(i + w.length, i + w.length + 2);
        var cls = null;
        if (w === "think") cls = "llm";
        else if (TOOLS.indexOf(w) >= 0) cls = "tool";
        else if (KEYWORDS.indexOf(w) >= 0) cls = "keyword";
        else if (CONSTS.indexOf(w) >= 0) cls = "const";
        else if (prevWord === "def" || (after[0] === "(" && BUILTINS.indexOf(w) >= 0)) cls = "func";
        else if (/^\s*=[^=]/.test(src.slice(i + w.length, i + w.length + 4)) && MODS.indexOf(w) >= 0 && /\{[^}\n]*$/.test(src.slice(Math.max(0, i - 60), i))) cls = "const";
        out += cls ? span(cls, w) : esc(w);
        prevWord = w; i += w.length; continue;
      }
      if (/\s/.test(c)) { out += c; i++; continue; }
      out += span("punct", c); i++; prevWord = "";
    }
    return out;
  }

  /* Applies `fn` to every regex match and HTML-escapes the text in between. */
  function tokenize(src, re, fn) {
    var out = "", last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index)) + fn(m);
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;
    }
    return out + esc(src.slice(last));
  }

  function highlightBash(src) {
    return tokenize(src, /(^|\s)(#[^\n]*)|('[^']*'|"[^"]*")|([\s\[])(--?[A-Za-z][\w-]*)|(^\$ )/gm, function (m) {
      if (m[2] !== undefined) return esc(m[1]) + span("comment", m[2]);
      if (m[3]) return span("string", m[3]);
      if (m[5]) return esc(m[4]) + span("flag", m[5]);
      return span("prompt", m[6]);
    });
  }

  function highlightJson(src) {
    return tokenize(src, /"(?:[^"\\\n]|\\.)*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?/g, function (m) {
      var t = m[0];
      if (t[0] === '"') return m[1] ? span("const", t.slice(0, t.lastIndexOf('"') + 1)) + esc(m[1]) : span("string", t);
      if (/^[tfn]/.test(t)) return span("keyword", t);
      return span("number", t);
    });
  }

  function highlightEbnf(src) {
    var out = "", i = 0, n = src.length, m;
    while (i < n) {
      if (src.substr(i, 2) === "(*") {
        var e = src.indexOf("*)", i); e = e < 0 ? n : e + 2;
        out += span("comment", src.slice(i, e)); i = e; continue;
      }
      var c = src[i];
      if (c === '"' || c === "'") {
        var j = i + 1; while (j < n && src[j] !== c && src[j] !== "\n") j++;
        out += span("string", src.slice(i, j + 1)); i = j + 1; continue;
      }
      if ((m = /^[A-Za-z_][\w]*/.exec(src.slice(i, i + 60)))) {
        var atLineStart = /^\s*$/.test(src.slice(src.lastIndexOf("\n", i - 1) + 1, i)) && /^\s*=/.test(src.slice(i + m[0].length, i + m[0].length + 20));
        out += atLineStart ? span("func", m[0]) : (/^[A-Z_]+$/.test(m[0]) ? span("const", m[0]) : esc(m[0]));
        i += m[0].length; continue;
      }
      if (/[=|,;{}\[\]()*+]/.test(c)) { out += span("punct", c); i++; continue; }
      out += esc(c); i++;
    }
    return out;
  }

  var HIGHLIGHTERS = { spl: highlightSpl, bash: highlightBash, sh: highlightBash, json: highlightJson, ebnf: highlightEbnf };
  var LABELS = { spl: "SPL", bash: "shell", sh: "shell", json: "JSON", ebnf: "EBNF", text: "text" };

  function enhanceCode() {
    var blocks = document.querySelectorAll("pre > code[class*='language-']");
    Array.prototype.forEach.call(blocks, function (code) {
      var lang = (/language-(\w+)/.exec(code.className) || [])[1] || "text";
      var pre = code.parentNode;
      var text = code.textContent.replace(/^\n/, "").replace(/\s+$/, "");
      var h = HIGHLIGHTERS[lang];
      code.innerHTML = h ? h(text) : esc(text);
      var file = code.getAttribute("data-file");
      var wrap = el("div", { "class": "code-block" });
      var head = el("div", { "class": "code-head" },
        '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
        (file ? '<span class="file">' + esc(file) + "</span>" : "") +
        '<span class="lang">' + (LABELS[lang] || lang) + "</span>");
      var btn = el("button", { "class": "copy-btn", type: "button", "aria-label": "Copy " + (file || LABELS[lang] || lang) + " code" }, "Copy");
      btn.addEventListener("click", function () {
        var done = function (ok) {
          btn.textContent = ok === false ? "Failed" : "Copied";
          announce(ok === false ? "Copy failed" : "Copied to clipboard");
          setTimeout(function () { btn.textContent = "Copy"; }, 1400);
        };
        if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
        else done(false);
      });
      head.appendChild(btn);
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(head);
      wrap.appendChild(pre);
    });
  }

  /* ---------- layout ---------- */
  function slug(t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

  var announcer = null;
  function announce(message) {
    if (!announcer) return;
    announcer.textContent = "";
    setTimeout(function () { announcer.textContent = message; }, 50);
  }

  var ICON_MENU = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
  var ICON_CLOSE = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var ICON_SEARCH = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';

  function navListHtml() {
    return NAV.map(function (g) {
      return '<p class="nav-title">' + g.group + '</p><ul class="nav-list" role="list">' + g.items.map(function (i) {
        return '<li><a href="' + i.href + '"' + (i.id === page ? ' aria-current="page"' : "") + ">" + esc(i.title) + "</a></li>";
      }).join("") + "</ul>";
    }).join("");
  }

  function build() {
    var main = document.getElementById("page");
    var current = FLAT.filter(function (p) { return p.id === page; })[0] || FLAT[0];

    var skip = el("a", { "class": "skip-link", href: "#content" }, "Skip to content");

    // header
    var header = el("header", { "class": "site-header" });
    header.innerHTML =
      '<button class="icon-btn menu-btn" id="menu-btn" type="button" aria-label="Menu" aria-expanded="false" aria-controls="drawer">' + ICON_MENU + "</button>" +
      '<a class="brand" href="index.html"><span class="brand-mark" aria-hidden="true">?</span><span>SPL</span><small>v0.1</small></a>' +
      '<nav class="header-nav" aria-label="Primary">' +
      [["getting-started", "Get started"], ["language", "Language"], ["cli", "Reference"], ["examples", "Examples"]].map(function (l) {
        var cur = FLAT.filter(function (p) { return p.id === l[0]; })[0];
        return '<a href="' + cur.href + '"' + (current.group === cur.group ? ' aria-current="true"' : "") + ">" + l[1] + "</a>";
      }).join("") + "</nav>" +
      '<span class="header-spacer"></span>' +
      '<button class="search-btn" id="search-btn" type="button" commandfor="search" command="show-modal" aria-keyshortcuts="Control+K">' +
      ICON_SEARCH + '<span class="lbl">Search docs</span><kbd aria-hidden="true">Ctrl K</kbd></button>';

    // sidebar (wide screens) and drawer (narrow screens) share one nav list
    var sidebar = el("nav", { "class": "sidebar", "aria-label": "Documentation" }, navListHtml());
    var drawer = el("div", { "class": "Drawer", id: "drawer", popover: "manual" });
    drawer.innerHTML =
      '<div class="Drawer-scroller"><nav class="Drawer-sheet" tabindex="-1" aria-label="Documentation">' +
      '<div class="Drawer-head"><span>Documentation</span><button class="icon-btn" id="drawer-close" type="button" aria-label="Close menu">' + ICON_CLOSE + "</button></div>" +
      '<div class="Drawer-body">' + navListHtml() + "</div></nav></div>";

    // content: the original <main> becomes the main landmark and skip-link target
    main.id = "content";
    main.tabIndex = -1;
    var content = el("div", { "class": "content" });
    main.parentNode.replaceChild(content, main);
    content.appendChild(main);
    Array.prototype.forEach.call(main.querySelectorAll(".ico, .pipeline .arrow"), function (n) { n.setAttribute("aria-hidden", "true"); });

    // headings: anchors + toc
    var heads = Array.prototype.filter.call(main.querySelectorAll("h2, h3"), function (h) { return !h.closest(".card"); });
    var toc = el("nav", { "class": "toc", "aria-label": "On this page" }, '<p class="toc-title">On this page</p>');
    heads.forEach(function (h) {
      if (!h.id) h.id = slug(h.textContent);
      var label = h.textContent.trim();
      h.appendChild(el("a", { "class": "anchor", href: "#" + h.id, "aria-label": "Link to " + label }, "#"));
      var a = el("a", { href: "#" + h.id, "class": h.tagName === "H3" ? "l3" : "" });
      a.textContent = label;
      toc.appendChild(a);
    });

    // prev / next
    var idx = FLAT.indexOf(current);
    if (document.body.getAttribute("data-nav") !== "none") {
      var pn = el("nav", { "class": "page-nav", "aria-label": "Pagination" });
      pn.innerHTML = (idx > 0 ? '<a class="prev" rel="prev" href="' + FLAT[idx - 1].href + '"><small>Previous</small><span aria-hidden="true">← </span>' + esc(FLAT[idx - 1].title) + "</a>" : '<span class="spacer"></span>') +
        (idx < FLAT.length - 1 ? '<a class="next" rel="next" href="' + FLAT[idx + 1].href + '"><small>Next</small>' + esc(FLAT[idx + 1].title) + '<span aria-hidden="true"> →</span></a>' : '<span class="spacer"></span>');
      main.appendChild(pn);
    }
    var footer = el("footer", { "class": "site-footer" },
      '<p>Semantic Prompt Language &middot; documentation generated from the repository sources &middot; ' +
      '<a href="https://github.com/dgawlik/semantic-prompt-language">GitHub</a></p>' +
      '<label class="theme-picker">Theme <select id="theme-select"><option value="">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>');
    content.appendChild(footer);

    var wrap = el("div", { "class": "content-wrap" });
    wrap.appendChild(content);
    if (heads.length > 1) wrap.appendChild(toc);
    var layout = el("div", { "class": "layout" });
    layout.appendChild(sidebar);
    layout.appendChild(wrap);

    announcer = el("p", { "class": "visually-hidden", role: "status" });
    document.body.insertBefore(layout, document.body.firstChild);
    document.body.insertBefore(header, document.body.firstChild);
    document.body.insertBefore(skip, document.body.firstChild);
    document.body.appendChild(drawer);
    document.body.appendChild(announcer);

    document.title = (main.querySelector("h1") ? main.querySelector("h1").textContent.replace(/\s+/g, " ").trim() + " · " : "") + "SPL docs";

    enhanceCode();
    wireScrollers(main);
    wireTheme(document.getElementById("theme-select"));
    wireDrawer(drawer, [header, layout]);
    wireSearch();
    wireScrollSpy(heads, toc);

    var active = sidebar.querySelector("a[aria-current]");
    if (active) sidebar.scrollTop = Math.max(0, active.offsetTop - 140);
  }

  /* Scrollable tables and code are made keyboard-reachable only while they actually overflow. */
  function wireScrollers(scope) {
    if (!("ResizeObserver" in window)) return;
    var ro = new ResizeObserver(function (entries) {
      entries.forEach(function (entry) {
        var t = entry.target;
        if (t.scrollWidth > t.clientWidth) {
          t.tabIndex = 0;
          t.setAttribute("role", "group");
          t.setAttribute("aria-label", t.matches(".table-wrap") ? "Scrollable table" : "Scrollable code");
        } else {
          t.removeAttribute("tabindex");
          t.removeAttribute("role");
          t.removeAttribute("aria-label");
        }
      });
    });
    Array.prototype.forEach.call(scope.querySelectorAll(".table-wrap, .code-block pre, pre.plain"), function (t) { ro.observe(t); });
  }

  /* Three states: system (nothing stored), light, dark. The <meta name="color-scheme"> carries the choice; CSS mirrors it. */
  function wireTheme(select) {
    var meta = document.querySelector('meta[name="color-scheme"]');
    var dark = window.matchMedia("(prefers-color-scheme: dark)");
    function stored() {
      try { var v = localStorage.getItem(COLOR_SCHEME_KEY); return v === "light" || v === "dark" ? v : ""; } catch (e) { return ""; }
    }
    function apply(value) {
      meta.content = value || "light dark";
      select.value = value;
    }
    function paintSystemLabel() { select.options[0].textContent = "System (currently " + (dark.matches ? "dark" : "light") + ")"; }
    select.addEventListener("change", function () {
      try { if (select.value) localStorage.setItem(COLOR_SCHEME_KEY, select.value); else localStorage.removeItem(COLOR_SCHEME_KEY); } catch (e) {}
      apply(select.value);
    });
    window.addEventListener("storage", function (e) { if (e.key === COLOR_SCHEME_KEY || e.key === null) apply(stored()); });
    dark.addEventListener("change", paintSystemLabel);
    paintSystemLabel();
    apply(stored());
  }

  /* Drawer: a popover whose swipe is native scroll-snapping; an IntersectionObserver is the single source of open/closed state. */
  function wireDrawer(drawer, outside) {
    var openBtn = document.getElementById("menu-btn");
    var scroller = drawer.querySelector(".Drawer-scroller");
    var sheet = drawer.querySelector(".Drawer-sheet");

    /* While opening, the sheet's transient off-screen position (jump-scroll fallback) must not count as closed. */
    var opening = false;

    async function openDrawer() {
      opening = "jump";
      drawer.showPopover();
      if (!CSS.supports("scroll-initial-target", "nearest")) {
        scroller.scrollTo({ left: scroller.offsetWidth, behavior: "instant" });
        await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
      }
      opening = "final";
      scroller.scrollTo({ left: 0, behavior: "auto" });
      setTimeout(function () {
        if (!opening) return;
        opening = false;
        if (isOpen() && scroller.scrollLeft >= sheet.offsetWidth - 1) onClosed();
      }, 1500);
    }
    function closeDrawer() { scroller.scrollTo({ left: scroller.offsetWidth, behavior: "auto" }); }
    function isOpen() { return drawer.matches(":popover-open"); }

    function onOpened() {
      opening = false;
      outside.forEach(function (n) { n.inert = true; });
      openBtn.setAttribute("aria-expanded", "true");
      sheet.focus();
    }
    function onClosed() {
      if (isOpen()) drawer.hidePopover();
      outside.forEach(function (n) { n.inert = false; });
      openBtn.setAttribute("aria-expanded", "false");
      openBtn.focus();
    }

    var visibleThreshold = 1 / window.innerWidth;
    new IntersectionObserver(function (entries) {
      var entry = entries[entries.length - 1];
      if (entry.intersectionRatio < visibleThreshold) { if (isOpen() && !opening) onClosed(); }
      else if (entry.intersectionRatio === 1 && isOpen() && opening !== "jump") onOpened();
    }, { root: drawer, threshold: [visibleThreshold, 1] }).observe(sheet);

    if (!CSS.supports("animation-timeline: scroll()")) {
      scroller.addEventListener("scroll", function () {
        drawer.style.setProperty("--drawer-backdrop", 1 - scroller.scrollLeft / sheet.offsetWidth);
      });
    }

    openBtn.addEventListener("click", openDrawer);
    document.getElementById("drawer-close").addEventListener("click", closeDrawer);
    drawer.addEventListener("click", function (e) { if (!sheet.contains(e.target)) closeDrawer(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && isOpen()) closeDrawer(); });
    matchMedia(NAV_BREAKPOINT).addEventListener("change", function (e) { if (!e.matches && isOpen()) closeDrawer(); });
  }

  /* Native scroll-target-group + :target-current where available; the IntersectionObserver toggles the same class elsewhere. */
  function wireScrollSpy(heads, toc) {
    var links = Array.prototype.slice.call(toc.querySelectorAll("a"));
    if (!links.length) return;

    if (CSS.supports("scroll-target-group: auto")) {
      var sync = function () {
        var currentLink = toc.querySelector("a:target-current");
        links.forEach(function (a) { a.setAttribute("aria-current", a === currentLink ? "true" : "false"); });
      };
      sync();
      document.addEventListener("scrollend", sync);
      return;
    }

    if (!("IntersectionObserver" in window)) return;
    var byId = {};
    links.forEach(function (a) { byId[a.getAttribute("href").slice(1)] = a; });
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var target = byId[e.target.id];
        if (!e.isIntersecting || !target) return;
        links.forEach(function (a) {
          a.classList.toggle(":target-current", a === target);
          a.setAttribute("aria-current", a === target ? "true" : "false");
        });
      });
    }, { rootMargin: "-80px 0px -70% 0px" });
    heads.forEach(function (h) { obs.observe(h); });
  }

  /* ---------- search ---------- */
  function wireSearch() {
    var index = window.SPL_SEARCH_INDEX || [];
    var dialog = el("dialog", { "class": "search", id: "search", "aria-label": "Search documentation" },
      '<input class="search-input" type="text" role="combobox" enterkeyhint="search" aria-label="Search the documentation" aria-autocomplete="list" aria-expanded="true" aria-controls="search-results" autocomplete="off" spellcheck="false" autofocus placeholder="Search the documentation…">' +
      '<div class="search-results" id="search-results" role="listbox" aria-label="Results"></div>' +
      '<p class="visually-hidden" role="status"></p>');
    document.body.appendChild(dialog);
    var input = dialog.querySelector("input"), results = dialog.querySelector(".search-results"), status = dialog.querySelector("[role=status]");
    var sel = 0, shown = [];

    function open() { if (!dialog.open) dialog.showModal(); }

    function render(q) {
      q = q.trim().toLowerCase();
      var terms = q.split(/\s+/).filter(Boolean);
      var scored = [];
      index.forEach(function (e) {
        var hay = (e.title + " " + e.page + " " + (e.text || "")).toLowerCase();
        var score = 0;
        if (!terms.length) score = e.level === 1 ? 1 : 0;
        else {
          for (var i = 0; i < terms.length; i++) {
            if (hay.indexOf(terms[i]) < 0) return;
            score += e.title.toLowerCase().indexOf(terms[i]) >= 0 ? 10 : 1;
            if (e.title.toLowerCase() === terms[i]) score += 20;
          }
          if (e.level === 1) score += 3;
        }
        if (score > 0 || !terms.length && e.level === 1) scored.push({ e: e, s: score });
      });
      scored.sort(function (a, b) { return b.s - a.s; });
      shown = scored.slice(0, 30).map(function (x) { return x.e; });
      sel = 0;
      input.removeAttribute("aria-activedescendant");
      if (!shown.length) {
        results.innerHTML = '<div class="search-empty">No results for “' + esc(q) + '”</div>';
        status.textContent = "No results";
        return;
      }
      results.innerHTML = shown.map(function (e, i) {
        return '<a id="search-opt-' + i + '" role="option" aria-selected="' + (i === 0) + '" href="' + e.href + '"><span>' + esc(e.title) + "</span><small>" + esc(e.page) + (e.level > 1 ? " › " + esc(e.title) : "") + "</small></a>";
      }).join("");
      input.setAttribute("aria-activedescendant", "search-opt-0");
      status.textContent = terms.length ? shown.length + (shown.length === 1 ? " result" : " results") : "";
    }
    function move(d) {
      var items = results.querySelectorAll("a"); if (!items.length) return;
      items[sel].setAttribute("aria-selected", "false");
      sel = (sel + d + items.length) % items.length;
      items[sel].setAttribute("aria-selected", "true");
      input.setAttribute("aria-activedescendant", items[sel].id);
      items[sel].scrollIntoView({ block: "nearest" });
    }
    input.addEventListener("input", function () { render(input.value); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "Enter" && shown[sel]) { window.location.href = shown[sel].href; }
    });
    dialog.addEventListener("click", function (e) { if (e.target === dialog) dialog.close(); });
    dialog.addEventListener("close", function () { input.value = ""; render(""); });
    render("");

    // Invoker commands are native in current browsers; older ones get the same behavior from a click handler.
    if (!("commandForElement" in HTMLButtonElement.prototype)) document.getElementById("search-btn").addEventListener("click", open);
    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); open(); }
      else if (e.key === "/" && !dialog.open && !/input|textarea|select/i.test((e.target.tagName || "")) && !e.target.isContentEditable) { e.preventDefault(); open(); }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
