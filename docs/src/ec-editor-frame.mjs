import { h } from "@expressive-code/core/hast";

const TERMINAL_LANGS = new Set([
  "ansi",
  "bash",
  "bat",
  "batch",
  "cmd",
  "console",
  "fish",
  "nu",
  "nushell",
  "powershell",
  "ps",
  "ps1",
  "psd1",
  "psm1",
  "sh",
  "shell",
  "shellscript",
  "shellsession",
  "zsh",
]);

const DEFAULT_FILENAMES = {
  js: "main.js",
  mjs: "main.mjs",
  cjs: "main.cjs",
  ts: "main.ts",
  tsx: "App.tsx",
  jsx: "App.jsx",
  json: "schema.json",
  jsonc: "config.jsonc",
  toml: "config.toml",
  yaml: "config.yaml",
  yml: "config.yml",
  css: "styles.css",
  html: "index.html",
  md: "README.md",
  mdx: "page.mdx",
};

const LANG_LABELS = {
  splx: "SPLX",
  spl: "SPLX",
  js: "JS",
  mjs: "ESM",
  cjs: "CJS",
  ts: "TS",
  tsx: "TSX",
  jsx: "JSX",
  json: "JSON",
  jsonc: "JSONC",
  bash: "BASH",
  sh: "SH",
  shell: "SHELL",
  zsh: "ZSH",
  powershell: "PWSH",
  ps1: "PWSH",
  cmd: "CMD",
  toml: "TOML",
  yaml: "YAML",
  yml: "YAML",
  css: "CSS",
  html: "HTML",
};

const SPLX_FILE_COMMENT_RE = /^\s*\/\/\s*([\w./~-]+\.splx?)\s*$/i;

function isTerminalBlock(codeBlock) {
  const frame = codeBlock.props.frame ?? "auto";
  if (frame === "terminal") return true;
  if (frame === "code" || frame === "none") return false;
  return TERMINAL_LANGS.has((codeBlock.language || "").toLowerCase());
}

function inferSplxFilename(code) {
  if (/\bllm\.agent(?:_replay)?\b/.test(code)) return "agent.splx";
  if (/\bllm\.ask(?:_raw)?\b/.test(code)) return "ask.splx";
  if (/\bllm\.tool\b/.test(code)) return "tools.splx";
  if (/\btraces\./.test(code)) return "traces.splx";
  if (/\bcodegen\./.test(code)) return "codegen.splx";
  if (/\breified\s+fn\b/.test(code)) return "reified.splx";
  if (/\b(?:pub\s+)?trait\b/.test(code)) return "traits.splx";
  if (/\b(?:HashMap|TreeSet|List)\b/.test(code)) return "collections.splx";
  if (/\b(?:par_map|async_all|async_race)\b/.test(code)) return "async.splx";
  if (/\b(?:fs|proc)\./.test(code)) return "io.splx";
  if (/\b(?:pub\s+)?enum\b/.test(code)) return "enums.splx";
  if (/\btype_schema\b|\bdecode</.test(code)) return "schema.splx";
  if (/\b(?:pub\s+)?type\b/.test(code)) return "types.splx";
  return "main.splx";
}

function extractSplxFilenameComment(codeBlock) {
  const lines = codeBlock.getLines(0, 4);
  for (let i = 0; i < lines.length; i++) {
    const match = SPLX_FILE_COMMENT_RE.exec(lines[i].text);
    if (match) {
      codeBlock.deleteLine(i);
      if (codeBlock.getLine(i)?.text.trim().length === 0) {
        codeBlock.deleteLine(i);
      }
      return match[1];
    }
  }
  return undefined;
}

function defaultTitleFor(codeBlock) {
  const lang = (codeBlock.language || "").toLowerCase();
  if (lang === "splx" || lang === "spl") {
    return inferSplxFilename(codeBlock.code);
  }
  if (DEFAULT_FILENAMES[lang]) return DEFAULT_FILENAMES[lang];
  return lang ? `snippet.${lang}` : "snippet.txt";
}

function langBadgeFor(codeBlock) {
  const lang = (codeBlock.language || "").toLowerCase();
  if (!lang || lang === "txt" || lang === "text" || lang === "plaintext") return "TEXT";
  return LANG_LABELS[lang] || lang.toUpperCase();
}

export function pluginEditorFrame() {
  return {
    name: "SPL Editor Frame",
    baseStyles: ({ cssVar }) => `
      .frame.spl-editor-frame,
      .frame.spl-terminal-frame {
        border-radius: calc(${cssVar("borderRadius")} + ${cssVar("borderWidth")});
        box-shadow: var(--spl-editor-shadow, 0 12px 28px rgb(0 0 0 / 0.35));
      }

      /* ---- Editor title bar + active tab strip ---- */
      .frame.spl-editor-frame.has-title:not(.is-terminal) {
        --spl-header-min-h: 2.35rem;
        --button-spacing: calc(var(--spl-header-min-h) + 0.55rem);
      }

      .frame.spl-editor-frame.has-title:not(.is-terminal) .header {
        display: flex;
        align-items: stretch;
        gap: 0.65rem;
        min-block-size: var(--spl-header-min-h);
        padding-inline: 0.85rem 0.75rem;
        padding-block: 0;
        background: var(--spl-code-chrome);
        border: ${cssVar("borderWidth")} solid var(--spl-code-border);
        border-bottom: 1px solid var(--spl-code-border);
        border-radius: var(--header-border-radius) var(--header-border-radius) 0 0;
      }

      .frame.spl-editor-frame.has-title:not(.is-terminal) .header::before {
        display: none;
      }

      .frame.spl-editor-frame .spl-window-dots {
        display: inline-flex;
        align-items: center;
        gap: 0.38rem;
        flex-shrink: 0;
        padding-inline-end: 0.35rem;
      }

      .frame.spl-editor-frame .spl-window-dot {
        display: inline-block;
        inline-size: 0.58rem;
        block-size: 0.58rem;
        border-radius: 50%;
        border: 1px solid transparent;
      }

      .frame.spl-editor-frame .spl-window-dot:nth-child(1) {
        background: var(--spl-dot-red);
        border-color: var(--spl-dot-red);
      }

      .frame.spl-editor-frame .spl-window-dot:nth-child(2) {
        background: var(--spl-dot-amber);
        border-color: var(--spl-dot-amber);
      }

      .frame.spl-editor-frame .spl-window-dot:nth-child(3) {
        background: var(--spl-dot-muted);
        border-color: var(--spl-dot-muted);
      }

      .frame.spl-editor-frame.has-title:not(.is-terminal) .header .title {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
        margin-block-start: 0.25rem;
        margin-block-end: -1px;
        padding-block: 0.32rem;
        padding-inline: 0.85rem 1rem;
        color: var(--sl-color-white);
        background: var(--spl-code-bg);
        border: 1px solid var(--spl-code-border);
        border-bottom: 1px solid var(--spl-code-bg);
        border-radius: 0.22rem 0.22rem 0 0;
        font-family: var(--sl-font-mono);
        font-size: 0.78rem;
        font-weight: 500;
        letter-spacing: 0.01em;
        min-inline-size: 0;
        max-inline-size: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .frame.spl-editor-frame.has-title:not(.is-terminal) .header .title::before {
        content: "";
        display: inline-block;
        inline-size: 0.42rem;
        block-size: 0.42rem;
        border-radius: 1px;
        background: var(--sl-color-accent);
        flex-shrink: 0;
      }

      .frame.spl-editor-frame.has-title:not(.is-terminal) .header .title::after {
        content: "";
        position: absolute;
        pointer-events: none;
        inset-block-start: 0;
        inset-inline: 0;
        block-size: 2px;
        border: none;
        background: var(--sl-color-accent);
      }

      .frame.spl-editor-frame .spl-lang-badge,
      .frame.spl-terminal-frame .spl-lang-badge {
        margin-inline-start: auto;
        align-self: center;
        flex-shrink: 0;
        padding-block: 0.14rem;
        padding-inline: 0.48rem;
        border: 1px solid var(--spl-code-border);
        border-radius: 0.18rem;
        background: var(--spl-code-bg);
        color: var(--sl-color-accent-high);
        font-family: var(--spl-font-display);
        font-size: 0.7rem;
        letter-spacing: 0.08em;
        line-height: 1.3;
      }

      /* ---- Line numbers gutter ---- */
      .frame.spl-editor-frame .ec-line .gutter {
        display: flex;
        align-items: stretch;
        background: var(--spl-code-gutter-bg);
        color: var(--spl-code-gutter-fg);
        border-inline-end: 1px solid var(--spl-code-gutter-border);
        font-variant-numeric: tabular-nums;
      }

      .frame.spl-editor-frame .ec-line .gutter .ln {
        display: inline-flex;
        align-items: center;
        justify-content: flex-end;
        min-inline-size: var(--spl-ln-width, 3.2ch);
        padding-inline: 0.75ch 1ch;
        font-size: 0.8em;
        line-height: inherit;
        color: inherit;
      }

      .frame.spl-editor-frame .ec-line .gutter ~ .code {
        --ecGtrBrdWd: 0px;
        padding-inline-start: calc(var(--ecIndent, 0ch) + 1.1rem);
      }

      /* ---- Connect pre seamlessly to header & bottom status bar ---- */
      .frame.spl-editor-frame pre,
      .frame.spl-editor-frame pre > code {
        border-radius: 0;
      }

      .frame.spl-editor-frame pre {
        border-block: none;
        border-inline: ${cssVar("borderWidth")} solid var(--spl-code-border);
      }

      /* ---- Editor bottom status bar ---- */
      .frame.spl-editor-frame .spl-editor-statusbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 0.4rem 1rem;
        min-block-size: 1.65rem;
        padding-block: 0.22rem;
        padding-inline: 0.75rem;
        background: var(--spl-code-status-bg);
        color: var(--spl-code-status-fg);
        border: ${cssVar("borderWidth")} solid var(--spl-code-border);
        border-top: 1px solid var(--spl-code-border);
        border-radius: 0 0 var(--header-border-radius) var(--header-border-radius);
        font-family: var(--sl-font-mono);
        font-size: 0.7rem;
        line-height: 1.35;
        font-variant-numeric: tabular-nums;
      }

      .frame.spl-editor-frame .spl-status-group {
        display: inline-flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.55rem;
      }

      .frame.spl-editor-frame .spl-status-mode {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        padding-block: 0.05rem;
        padding-inline: 0.42rem;
        border-radius: 0.15rem;
        background: var(--sl-color-accent-low);
        border: 1px solid var(--spl-border);
        color: var(--sl-color-accent-high);
        font-family: var(--spl-font-display);
        letter-spacing: 0.06em;
      }

      .frame.spl-editor-frame .spl-status-item:not(:first-child)::before {
        content: "|";
        content: "|" / "";
        margin-inline-end: 0.55rem;
        opacity: 0.45;
      }

      /* ---- Terminal frame cohesion ---- */
      .frame.spl-terminal-frame.is-terminal .header {
        justify-content: space-between;
        padding-inline: 3.4rem 0.75rem;
        min-block-size: 2.25rem;
      }

      .frame.spl-terminal-frame.is-terminal .header::before {
        background-color: var(--sl-color-accent);
        opacity: 0.85;
      }

      @media (max-width: 34rem) {
        .frame.spl-editor-frame .spl-window-dots {
          display: none;
        }
      }

      @media (forced-colors: active) {
        .frame.spl-editor-frame,
        .frame.spl-terminal-frame {
          box-shadow: none;
        }

        .frame.spl-editor-frame .spl-window-dot {
          background: Canvas;
          border-color: CanvasText;
        }

        .frame.spl-editor-frame.has-title:not(.is-terminal) .header,
        .frame.spl-editor-frame.has-title:not(.is-terminal) .header .title,
        .frame.spl-editor-frame pre,
        .frame.spl-editor-frame .spl-editor-statusbar,
        .frame.spl-editor-frame .spl-lang-badge,
        .frame.spl-editor-frame .spl-status-mode {
          border-color: CanvasText;
        }

        .frame.spl-editor-frame.has-title:not(.is-terminal) .header .title::after {
          background: Highlight;
        }
      }
    `,
    hooks: {
      preprocessCode: ({ codeBlock, addGutterElement }) => {
        if (codeBlock.props.frame === "none") return;

        const isTerminal = isTerminalBlock(codeBlock);

        if (!isTerminal) {
          if (!codeBlock.props.title) {
            const lang = (codeBlock.language || "").toLowerCase();
            if (lang === "splx" || lang === "spl") {
              const extracted = extractSplxFilenameComment(codeBlock);
              if (extracted) {
                codeBlock.props.title = extracted;
              }
            }
          }

          if (!codeBlock.props.title) {
            codeBlock.props.title = defaultTitleFor(codeBlock);
          }

          addGutterElement({
            renderPhase: "earlier",
            renderLine: ({ lineIndex }) =>
              h("div", { className: "ln", "aria-hidden": "true" }, String(lineIndex + 1)),
            renderPlaceholder: () => h("div", { className: "ln", "aria-hidden": "true" }),
          });
        }
      },

      postprocessRenderedBlock: ({ codeBlock, renderData }) => {
        if (codeBlock.props.frame === "none") return;

        const figure = renderData.blockAst;
        if (!figure || figure.tagName !== "figure") return;

        const classes = Array.isArray(figure.properties?.className)
          ? figure.properties.className
          : [];
        const isTerminal = classes.includes("is-terminal");
        const header = figure.children?.find(
          (child) => child.type === "element" && child.tagName === "figcaption"
        );
        const langBadge = langBadgeFor(codeBlock);

        if (isTerminal) {
          classes.push("spl-terminal-frame");
          figure.properties.className = classes;
          if (header) {
            header.children.push(
              h("span", { className: "spl-lang-badge", "aria-hidden": "true" }, langBadge)
            );
          }
          return;
        }

        if (!classes.includes("has-title")) return;

        classes.push("spl-editor-frame");
        figure.properties.className = classes;

        const lineCount = codeBlock.getLines().length;
        const digitCount = Math.max(2, String(lineCount).length);
        const existingStyle = typeof figure.properties.style === "string" ? figure.properties.style : "";
        figure.properties.style = `${existingStyle}${existingStyle ? ";" : ""}--spl-ln-width:${digitCount + 1.4}ch`;

        if (header) {
          const dots = h("span", { className: "spl-window-dots", "aria-hidden": "true" }, [
            h("span", { className: "spl-window-dot" }),
            h("span", { className: "spl-window-dot" }),
            h("span", { className: "spl-window-dot" }),
          ]);
          const badge = h("span", { className: "spl-lang-badge", "aria-hidden": "true" }, langBadge);
          header.children = [dots, ...header.children, badge];
        }

        const statusBar = h("div", { className: "spl-editor-statusbar", "aria-hidden": "true" }, [
          h("div", { className: "spl-status-group" }, [
            h("span", { className: "spl-status-mode" }, langBadge),
            h("span", { className: "spl-status-item" }, `${lineCount} ${lineCount === 1 ? "line" : "lines"}`),
          ]),
          h("div", { className: "spl-status-group" }, [
            h("span", { className: "spl-status-item" }, "Spaces: 4"),
            h("span", { className: "spl-status-item" }, "UTF-8"),
            h("span", { className: "spl-status-item" }, "LF"),
          ]),
        ]);

        const preIndex = figure.children.findIndex(
          (child) => child.type === "element" && child.tagName === "pre"
        );
        if (preIndex !== -1) {
          figure.children.splice(preIndex + 1, 0, statusBar);
        } else {
          figure.children.push(statusBar);
        }
      },
    },
  };
}
