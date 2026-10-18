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
  var root = document.documentElement;

  /* ---------- theme ---------- */
  var saved = null;
  try { saved = localStorage.getItem("spl-theme"); } catch (e) {}
  var theme = saved || (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  root.setAttribute("data-theme", theme);

  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (html != null) n.innerHTML = html;
    return n;
  }
  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function span(cls, text) { return '<span class="t-' + cls + '">' + esc(text) + "</span>"; }

  /* ---------- syntax highlighting ---------- */
  var KEYWORDS = "let if elif else for in while def return try except assert fail success enforce forbid restrict break continue pass and or not fs net exec".split(" ");
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
        '<span class="dots"><i></i><i></i><i></i></span>' +
        (file ? '<span class="file">' + esc(file) + "</span>" : "") +
        '<span class="lang">' + (LABELS[lang] || lang) + "</span>");
      var btn = el("button", { "class": "copy-btn", type: "button", "aria-label": "Copy code" }, "Copy");
      btn.addEventListener("click", function () {
        var done = function () { btn.textContent = "Copied"; setTimeout(function () { btn.textContent = "Copy"; }, 1400); };
        if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done); else done();
      });
      head.appendChild(btn);
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(head);
      wrap.appendChild(pre);
    });
  }

  /* ---------- layout ---------- */
  function slug(t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

  function build() {
    var main = document.getElementById("page");
    var current = FLAT.filter(function (p) { return p.id === page; })[0] || FLAT[0];

    // header
    var header = el("header", { "class": "site-header" });
    header.innerHTML =
      '<button class="icon-btn menu-btn" aria-label="Menu" id="menu-btn">☰</button>' +
      '<a class="brand" href="index.html"><span class="brand-mark">?</span><span>SPL</span><small>v0.1</small></a>' +
      '<nav class="header-nav">' +
      [["getting-started", "Get started"], ["language", "Language"], ["cli", "Reference"], ["examples", "Examples"]].map(function (l) {
        var cur = FLAT.filter(function (p) { return p.id === l[0]; })[0];
        var active = current.group === cur.group ? " active" : "";
        return '<a class="' + active.trim() + '" href="' + cur.href + '">' + l[1] + "</a>";
      }).join("") + "</nav>" +
      '<span class="header-spacer"></span>' +
      '<button class="search-btn" id="search-btn"><span>🔍</span><span class="lbl">Search docs</span><kbd>Ctrl K</kbd></button>' +
      '<button class="icon-btn" id="theme-btn" aria-label="Toggle theme"></button>';

    // sidebar
    var sidebar = el("aside", { "class": "sidebar" });
    sidebar.innerHTML = NAV.map(function (g) {
      return "<h4>" + g.group + "</h4>" + g.items.map(function (i) {
        return '<a href="' + i.href + '"' + (i.id === page ? ' class="active"' : "") + ">" + esc(i.title) + "</a>";
      }).join("");
    }).join("");

    // content
    var content = el("article", { "class": "content" });
    while (main.firstChild) content.appendChild(main.firstChild);
    main.parentNode.removeChild(main);

    // headings: anchors + toc
    var heads = Array.prototype.filter.call(content.querySelectorAll("h2, h3"), function (h) { return !h.closest(".card"); });
    var toc = el("nav", { "class": "toc" }, "<h5>On this page</h5>");
    heads.forEach(function (h) {
      if (!h.id) h.id = slug(h.textContent);
      var label = h.textContent.trim();
      h.appendChild(el("a", { "class": "anchor", href: "#" + h.id, "aria-label": "Link" }, "#"));
      var a = el("a", { href: "#" + h.id, "class": h.tagName === "H3" ? "l3" : "" });
      a.textContent = label;
      toc.appendChild(a);
    });

    // prev / next
    var idx = FLAT.indexOf(current);
    if (document.body.getAttribute("data-nav") !== "none") {
      var pn = el("div", { "class": "page-nav" });
      pn.innerHTML = (idx > 0 ? '<a class="prev" href="' + FLAT[idx - 1].href + '"><small>Previous</small>← ' + esc(FLAT[idx - 1].title) + "</a>" : '<span class="spacer"></span>') +
        (idx < FLAT.length - 1 ? '<a class="next" href="' + FLAT[idx + 1].href + '"><small>Next</small>' + esc(FLAT[idx + 1].title) + " →</a>" : '<span class="spacer"></span>');
      content.appendChild(pn);
    }
    content.appendChild(el("footer", { "class": "site-footer" },
      'Semantic Prompt Language &middot; documentation generated from the repository sources &middot; ' +
      '<a href="https://github.com/dgawlik/semantic-prompt-language">GitHub</a>'));

    var wrap = el("div", { "class": "content-wrap" });
    wrap.appendChild(content);
    if (heads.length > 1) wrap.appendChild(toc);
    var layout = el("div", { "class": "layout" });
    layout.appendChild(sidebar);
    layout.appendChild(wrap);
    document.body.insertBefore(layout, document.body.firstChild);
    document.body.insertBefore(header, document.body.firstChild);

    document.title = (content.querySelector("h1") ? content.querySelector("h1").textContent.replace(/\s+/g, " ").trim() + " · " : "") + "SPL docs";

    enhanceCode();
    wireTheme(); wireMenu(); wireSearch(); wireScrollSpy(heads, toc);

    var active = sidebar.querySelector("a.active");
    if (active && active.scrollIntoView) sidebar.scrollTop = Math.max(0, active.offsetTop - 140);
  }

  function wireTheme() {
    var btn = document.getElementById("theme-btn");
    function paint() { btn.textContent = root.getAttribute("data-theme") === "dark" ? "☀️" : "🌙"; }
    paint();
    btn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("spl-theme", next); } catch (e) {}
      paint();
    });
  }

  function wireMenu() {
    document.getElementById("menu-btn").addEventListener("click", function () { document.body.classList.toggle("nav-open"); });
    document.querySelector(".content-wrap").addEventListener("click", function () { document.body.classList.remove("nav-open"); });
  }

  function wireScrollSpy(heads, toc) {
    if (!heads.length || !("IntersectionObserver" in window)) return;
    var links = {};
    Array.prototype.forEach.call(toc.querySelectorAll("a"), function (a) { links[a.getAttribute("href").slice(1)] = a; });
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting && links[e.target.id]) {
          Object.keys(links).forEach(function (k) { links[k].classList.remove("active"); });
          links[e.target.id].classList.add("active");
        }
      });
    }, { rootMargin: "-80px 0px -70% 0px" });
    heads.forEach(function (h) { obs.observe(h); });
  }

  /* ---------- search ---------- */
  function wireSearch() {
    var index = window.SPL_SEARCH_INDEX || [];
    var overlay = el("div", { "class": "search-overlay" },
      '<div class="search-box"><input type="text" placeholder="Search the documentation…" aria-label="Search"><div class="search-results"></div></div>');
    document.body.appendChild(overlay);
    var input = overlay.querySelector("input"), results = overlay.querySelector(".search-results");
    var sel = 0, shown = [];

    function open() { overlay.classList.add("open"); input.value = ""; render(""); input.focus(); }
    function close() { overlay.classList.remove("open"); }

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
      if (!shown.length) { results.innerHTML = '<div class="search-empty">No results for “' + esc(q) + '”</div>'; return; }
      results.innerHTML = shown.map(function (e, i) {
        return '<a href="' + e.href + '"' + (i === 0 ? ' class="sel"' : "") + "><span>" + esc(e.title) + "</span><small>" + esc(e.page) + (e.level > 1 ? " › " + esc(e.title) : "") + "</small></a>";
      }).join("");
    }
    function move(d) {
      var items = results.querySelectorAll("a"); if (!items.length) return;
      items[sel].classList.remove("sel");
      sel = (sel + d + items.length) % items.length;
      items[sel].classList.add("sel");
      items[sel].scrollIntoView({ block: "nearest" });
    }
    input.addEventListener("input", function () { render(input.value); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "Enter" && shown[sel]) { window.location.href = shown[sel].href; }
    });
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    document.getElementById("search-btn").addEventListener("click", open);
    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); open(); }
      else if (e.key === "/" && !/input|textarea/i.test((e.target.tagName || ""))) { e.preventDefault(); open(); }
      else if (e.key === "Escape") close();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
