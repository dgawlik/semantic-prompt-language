import { Compartment, EditorState, Prec } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  hoverTooltip,
  type Tooltip,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import {
  autocompletion,
  completionKeymap,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import {
  analyzePlayground,
  getPlaygroundCompletions,
  getPlaygroundHover,
  getPlaygroundSignatureHelp,
  runPlaygroundCode,
  type LspCompletionItem,
  type LspDiagnostic,
} from "./spl-engine.ts";
import { createSplEditorTheme, splLanguage } from "./spl-language.ts";
import { PLAYGROUND_PRESETS, findPreset, type PlaygroundPreset } from "./presets.ts";

const KIND_LABELS: Record<number, string> = {
  2: "mth",
  3: "fn",
  5: "fld",
  6: "var",
  8: "trt",
  9: "mod",
  10: "arg",
  13: "enm",
  14: "kw",
  20: "var",
  22: "typ",
};

function offsetFromLspPos(doc: EditorState["doc"], line0: number, char0: number): number {
  const clampedLine = Math.max(1, Math.min(doc.lines, line0 + 1));
  const line = doc.line(clampedLine);
  return Math.max(line.from, Math.min(line.to, line.from + Math.max(0, char0)));
}

function encodeCodeToHash(code: string): string {
  const bytes = new TextEncoder().encode(code);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCodeFromHash(hash: string): string | null {
  const match = hash.match(/code=([A-Za-z0-9_-]+)/);
  if (!match) return null;
  try {
    const b64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const bin = atob(b64 + pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function stripMarkdownBackticks(md: string): string {
  return md
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/```/g, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .trim();
}

function createInfoNode(docText: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "spl-cm-doc";
  box.textContent = stripMarkdownBackticks(docText);
  return box;
}

function splCompletionSource(context: CompletionContext): CompletionResult | null {
  const doc = context.state.doc;
  const pos = context.pos;
  const line = doc.lineAt(pos);
  const line0 = line.number - 1;
  const char0 = pos - line.from;
  const before = line.text.slice(0, char0);

  // Trigger after `.` / `?.`, inside `from "std/...`, on identifiers, or explicitly (Ctrl+Space)
  const importMatch = before.match(/\bfrom\s+"([^"]*)$/);
  const dotMatch = before.match(/(?:\?\.|\.)([A-Za-z_][A-Za-z0-9_]*)?$/);
  const wordMatch = before.match(/[A-Za-z_][A-Za-z0-9_]*$/);

  if (!context.explicit && !importMatch && !dotMatch && !wordMatch) {
    return null;
  }

  const source = doc.toString();
  const lspItems: LspCompletionItem[] = getPlaygroundCompletions(source, line0, char0);
  if (lspItems.length === 0) return null;

  let from = pos;
  if (importMatch) {
    from = pos - importMatch[1].length;
  } else if (dotMatch && dotMatch[1]) {
    from = pos - dotMatch[1].length;
  } else if (wordMatch) {
    from = pos - wordMatch[0].length;
  }

  const options: Completion[] = lspItems.map((item, idx) => {
    const kindCode = KIND_LABELS[item.kind] ?? "sym";
    const completion: Completion & { splKind?: string } = {
      label: item.label,
      detail: item.detail,
      apply: item.insertText ?? item.label,
      boost: item.sortText?.startsWith("00")
        ? 90
        : item.sortText?.startsWith("01")
          ? 70
          : item.kind === 5 || item.kind === 2
            ? 50
            : Math.max(-50, 20 - Math.floor(idx / 10)),
      splKind: kindCode,
    };
    if (item.documentation?.value) {
      completion.info = () => createInfoNode(item.documentation!.value);
    }
    return completion;
  });

  return {
    from,
    options,
    validFor: importMatch ? /^[A-Za-z0-9_/-]*$/ : /^[A-Za-z0-9_]*$/,
  };
}

function splHoverSource(view: EditorView, pos: number): Tooltip | null {
  const doc = view.state.doc;
  const line = doc.lineAt(pos);
  const hover = getPlaygroundHover(doc.toString(), line.number - 1, pos - line.from);
  if (!hover || !hover.contents?.value) return null;

  const from = hover.range
    ? offsetFromLspPos(doc, hover.range.start.line, hover.range.start.character)
    : pos;
  const to = hover.range
    ? offsetFromLspPos(doc, hover.range.end.line, hover.range.end.character)
    : pos;

  return {
    pos: from,
    end: Math.max(from, to),
    above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "spl-hover-tooltip";
      dom.textContent = stripMarkdownBackticks(hover.contents.value);
      return { dom };
    },
  };
}

function installFocusgroupFallback(
  container: HTMLElement,
  getItems: () => HTMLElement[],
  options: { wrap: boolean; onMove?: (target: HTMLElement) => void }
): void {
  if ("focusGroup" in HTMLElement.prototype) return;

  const syncTabStops = (active?: HTMLElement) => {
    const items = getItems();
    const chosen =
      active ??
      items.find((el) => el.getAttribute("aria-selected") === "true" || el.hasAttribute("focusgroupstart")) ??
      items[0];
    items.forEach((el) => {
      el.tabIndex = el === chosen ? 0 : -1;
    });
  };

  syncTabStops();

  container.addEventListener("focusin", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    const items = getItems();
    if (items.includes(target)) {
      syncTabStops(target);
    }
  });

  container.addEventListener("keydown", (ev) => {
    const items = getItems();
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (idx === -1) return;

    const rtl = getComputedStyle(container).direction === "rtl";
    let nextIdx = -1;

    if (ev.key === "ArrowRight") {
      nextIdx = idx + (rtl ? -1 : 1);
    } else if (ev.key === "ArrowLeft") {
      nextIdx = idx + (rtl ? 1 : -1);
    } else if (ev.key === "Home") {
      nextIdx = 0;
    } else if (ev.key === "End") {
      nextIdx = items.length - 1;
    } else {
      return;
    }

    ev.preventDefault();
    if (options.wrap) {
      nextIdx = (nextIdx + items.length) % items.length;
    } else {
      nextIdx = Math.max(0, Math.min(items.length - 1, nextIdx));
    }

    const nextEl = items[nextIdx];
    if (nextEl) {
      syncTabStops(nextEl);
      nextEl.focus();
      options.onMove?.(nextEl);
    }
  });
}

export function mountSplPlayground(root: HTMLElement): void {
  const editorHost = root.querySelector<HTMLElement>("[data-pg-editor]");
  const toolbarEl = root.querySelector<HTMLElement>('[role="toolbar"]');
  const presetSelect = root.querySelector<HTMLSelectElement>("[data-pg-preset]");
  const runBtn = root.querySelector<HTMLButtonElement>("[data-pg-run]");
  const completeBtn = root.querySelector<HTMLButtonElement>("[data-pg-complete]");
  const shareBtn = root.querySelector<HTMLButtonElement>("[data-pg-share]");
  const resetBtn = root.querySelector<HTMLButtonElement>("[data-pg-reset]");
  const liveStatus = root.querySelector<HTMLElement>("[data-pg-live-status]");
  const filenameEl = root.querySelector<HTMLElement>("[data-pg-filename]");
  const cursorStatusEl = root.querySelector<HTMLElement>("[data-pg-cursor]");
  const diagStatusEl = root.querySelector<HTMLElement>("[data-pg-diag-summary]");
  const sigBarEl = root.querySelector<HTMLElement>("[data-pg-signature]");
  const outputEl = root.querySelector<HTMLElement>("[data-pg-output]");
  const runMetaEl = root.querySelector<HTMLElement>("[data-pg-run-meta]");
  const jsEl = root.querySelector<HTMLElement>("[data-pg-js]");
  const problemsEl = root.querySelector<HTMLElement>("[data-pg-problems]");
  const schemasEl = root.querySelector<HTMLElement>("[data-pg-schemas]");
  const problemsBadgeEl = root.querySelector<HTMLElement>("[data-pg-problems-count]");
  const schemasBadgeEl = root.querySelector<HTMLElement>("[data-pg-schemas-count]");
  const tablistEl = root.querySelector<HTMLElement>("[data-pg-tablist]");
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-pg-tablist] > button'));
  const panels = Array.from(root.querySelectorAll<HTMLElement>('[role="tabpanel"]'));

  if (!editorHost || !outputEl || !jsEl || !problemsEl || !schemasEl) return;

  const announce = (msg: string) => {
    if (!liveStatus) return;
    liveStatus.textContent = "";
    requestAnimationFrame(() => {
      liveStatus.textContent = msg;
    });
  };

  // ---- Tabs setup (modern-web-guidance: focusgroup + hidden="until-found" + beforematch) ----
  const selectTab = (tabId: string, scrollIntoView = false) => {
    tabs.forEach((tab) => {
      const selected = tab.id === tabId;
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.toggleAttribute("focusgroupstart", selected);
      if (!("focusGroup" in HTMLElement.prototype)) {
        tab.tabIndex = selected ? 0 : -1;
      }
      if (selected && scrollIntoView) {
        tab.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    });

    panels.forEach((panel) => {
      const active = panel.getAttribute("aria-labelledby") === tabId;
      if (active) {
        panel.removeAttribute("hidden");
        panel.tabIndex = 0;
      } else {
        panel.setAttribute("hidden", "until-found");
        panel.removeAttribute("tabindex");
      }
    });
  };

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => selectTab(tab.id, true));
    tab.addEventListener("focus", () => {
      if (document.activeElement === tab) selectTab(tab.id, true);
    });
  });

  panels.forEach((panel) => {
    panel.addEventListener("beforematch", () => {
      const tabId = panel.getAttribute("aria-labelledby");
      if (tabId) selectTab(tabId, true);
    });
  });

  if (tablistEl) {
    if (!("focusGroup" in HTMLElement.prototype)) {
      tablistEl.setAttribute("role", "tablist");
      tabs.forEach((t) => t.setAttribute("role", "tab"));
    }
    installFocusgroupFallback(tablistEl, () => tabs, {
      wrap: false,
      onMove: (el) => selectTab(el.id, true),
    });
  }

  if (toolbarEl) {
    const getToolbarControls = () =>
      Array.from(toolbarEl.querySelectorAll<HTMLElement>("button, select"));
    installFocusgroupFallback(toolbarEl, getToolbarControls, { wrap: true });
  }

  // ---- Initial preset or shared URL hash ----
  const params = new URLSearchParams(window.location.search);
  let activePreset: PlaygroundPreset = findPreset(params.get("example"));
  const sharedCode = decodeCodeFromHash(window.location.hash);
  const initialCode = sharedCode ?? activePreset.code;

  if (presetSelect) {
    presetSelect.value = activePreset.id;
  }
  if (filenameEl) {
    filenameEl.textContent = sharedCode ? "shared.splx" : activePreset.filename;
  }

  let latestDiagnostics: LspDiagnostic[] = [];
  let isRunning = false;

  const isLightTheme = () => document.documentElement.dataset.theme === "light";
  const themeCompartment = new Compartment();

  const renderProblems = (diags: LspDiagnostic[], view: EditorView) => {
    latestDiagnostics = diags;
    if (problemsBadgeEl) {
      problemsBadgeEl.textContent = String(diags.length);
      problemsBadgeEl.dataset.hasErrors = diags.length > 0 ? "true" : "false";
    }
    if (diagStatusEl) {
      diagStatusEl.textContent =
        diags.length === 0 ? "0 problems" : `${diags.length} ${diags.length === 1 ? "problem" : "problems"}`;
      diagStatusEl.dataset.hasErrors = diags.length > 0 ? "true" : "false";
    }

    problemsEl.replaceChildren();
    if (diags.length === 0) {
      const ok = document.createElement("p");
      ok.className = "spl-empty-state";
      ok.textContent = "No syntax or type errors.";
      problemsEl.append(ok);
      return;
    }

    const list = document.createElement("ul");
    list.className = "spl-problems-list";
    for (const d of diags) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "spl-problem-item";
      const loc = document.createElement("span");
      loc.className = "spl-problem-loc";
      loc.textContent = `Ln ${d.range.start.line + 1}, Col ${d.range.start.character + 1}`;
      const src = document.createElement("span");
      src.className = "spl-problem-src";
      src.textContent = d.source;
      const msg = document.createElement("span");
      msg.className = "spl-problem-msg";
      msg.textContent = d.message;
      btn.append(loc, src, msg);
      btn.addEventListener("click", () => {
        const targetPos = offsetFromLspPos(view.state.doc, d.range.start.line, d.range.start.character);
        view.dispatch({
          selection: { anchor: targetPos },
          scrollIntoView: true,
        });
        view.focus();
      });
      li.append(btn);
      list.append(li);
    }
    problemsEl.append(list);
  };

  const renderSchemas = (schemas: Array<{ line: number; schema: Record<string, unknown> }>) => {
    if (schemasBadgeEl) {
      schemasBadgeEl.textContent = String(schemas.length);
    }
    schemasEl.replaceChildren();
    if (schemas.length === 0) {
      const empty = document.createElement("p");
      empty.className = "spl-empty-state";
      empty.textContent = "Call type_schema<T>() in your code to inspect compile-time JSON Schemas here.";
      schemasEl.append(empty);
      return;
    }

    for (const entry of schemas) {
      const block = document.createElement("div");
      block.className = "spl-schema-card";
      const header = document.createElement("div");
      header.className = "spl-schema-head";
      header.textContent = `type_schema<T>() @ line ${entry.line}`;
      const pre = document.createElement("pre");
      pre.className = "spl-code-output";
      pre.textContent = JSON.stringify(entry.schema, null, 2);
      block.append(header, pre);
      schemasEl.append(block);
    }
  };

  const syncAnalysis = (view: EditorView): Diagnostic[] => {
    const source = view.state.doc.toString();
    const res = analyzePlayground(source);
    renderProblems(res.diagnostics, view);
    renderSchemas(res.schemas);

    if (res.jsCode !== undefined) {
      jsEl.textContent = res.jsCode;
    } else if (res.diagnostics.length > 0) {
      jsEl.textContent = `// Fix ${res.diagnostics.length} compile error(s) to emit JavaScript.\n// ${res.diagnostics[0].message}`;
    }

    return res.diagnostics.map((d) => {
      const from = offsetFromLspPos(view.state.doc, d.range.start.line, d.range.start.character);
      const rawTo = offsetFromLspPos(view.state.doc, d.range.end.line, d.range.end.character);
      const to = Math.max(from, Math.min(view.state.doc.length, rawTo > from ? rawTo : from + 1));
      return {
        from,
        to,
        severity: "error",
        source: d.source,
        message: d.message,
      };
    });
  };

  const updateCursorAndSignature = (view: EditorView) => {
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    const line0 = line.number - 1;
    const char0 = pos - line.from;

    if (cursorStatusEl) {
      cursorStatusEl.textContent = `Ln ${line.number}, Col ${char0 + 1}`;
    }

    if (sigBarEl) {
      const sig = getPlaygroundSignatureHelp(view.state.doc.toString(), line0, char0);
      if (sig && sig.signatures.length > 0) {
        const activeSig = sig.signatures[sig.activeSignature] ?? sig.signatures[0];
        sigBarEl.textContent = activeSig.label;
        sigBarEl.hidden = false;
      } else {
        sigBarEl.textContent = "";
        sigBarEl.hidden = true;
      }
    }
  };

  const runCurrentCode = async (view: EditorView) => {
    if (isRunning) return;
    isRunning = true;
    if (runBtn) {
      runBtn.setAttribute("aria-disabled", "true");
    }

    selectTab("pg-tab-output");
    outputEl.replaceChildren();
    if (runMetaEl) {
      runMetaEl.textContent = "Running...";
      runMetaEl.dataset.state = "running";
    }

    let lineBuffer = "";
    const flushInline = () => {
      if (!lineBuffer) return;
      const line = document.createElement("div");
      line.className = "spl-out-line";
      line.textContent = lineBuffer;
      outputEl.append(line);
      lineBuffer = "";
    };

    const appendLine = (text: string, cls: string) => {
      flushInline();
      const line = document.createElement("div");
      line.className = cls;
      line.textContent = text;
      outputEl.append(line);
    };

    const result = await runPlaygroundCode(view.state.doc.toString(), (chunk) => {
      if (chunk.kind === "inline") {
        lineBuffer += chunk.text;
        if (lineBuffer.includes("\n")) {
          const parts = lineBuffer.split("\n");
          for (let i = 0; i < parts.length - 1; i++) {
            appendLine(parts[i], "spl-out-line");
          }
          lineBuffer = parts[parts.length - 1];
        }
      } else if (chunk.kind === "warn") {
        appendLine(chunk.text, "spl-out-line spl-out-warn");
      } else if (chunk.kind === "error") {
        appendLine(chunk.text, "spl-out-line spl-out-error");
      } else {
        appendLine(chunk.text, "spl-out-line");
      }
    });

    flushInline();

    if (!result.ok) {
      appendLine(result.error ?? "Execution failed.", "spl-out-line spl-out-error");
      if (runMetaEl) {
        runMetaEl.textContent = `Error (${result.elapsedMs}ms)`;
        runMetaEl.dataset.state = "error";
      }
      announce(`Execution failed: ${result.error ?? "error"}`);
    } else {
      if (outputEl.childElementCount === 0) {
        const empty = document.createElement("p");
        empty.className = "spl-empty-state";
        empty.textContent = "Program completed with no output.";
        outputEl.append(empty);
      }
      if (runMetaEl) {
        runMetaEl.textContent = `OK (${result.elapsedMs}ms)`;
        runMetaEl.dataset.state = "ok";
      }
      announce(`Execution completed in ${result.elapsedMs} milliseconds`);
    }

    isRunning = false;
    if (runBtn) {
      runBtn.removeAttribute("aria-disabled");
    }
  };

  let viewRef: EditorView;

  const editorState = EditorState.create({
    doc: initialCode,
    extensions: [
      lineNumbers(),
      lintGutter(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      history(),
      indentOnInput(),
      bracketMatching(),
      splLanguage,
      themeCompartment.of(createSplEditorTheme(isLightTheme())),
      autocompletion({
        override: [splCompletionSource],
        activateOnTyping: true,
        icons: false,
        maxRenderedOptions: 60,
        addToOptions: [
          {
            render(completion) {
              const badge = document.createElement("span");
              badge.className = "spl-cm-kind";
              badge.textContent = (completion as Completion & { splKind?: string }).splKind ?? "sym";
              return badge;
            },
            position: 20,
          },
        ],
      }),
      linter((v) => syncAnalysis(v), { delay: 220 }),
      hoverTooltip(splHoverSource, { hoverTime: 260 }),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: (v) => {
              void runCurrentCode(v);
              return true;
            },
          },
          {
            key: "Ctrl-Space",
            run: startCompletion,
          },
        ])
      ),
      keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          updateCursorAndSignature(update.view);
        }
        // Auto-open completions right after typing `.` or `?.` or `"std/`
        if (update.docChanged) {
          const head = update.state.selection.main.head;
          const line = update.state.doc.lineAt(head);
          const before = line.text.slice(0, head - line.from);
          if (before.endsWith(".") || /\bfrom\s+"std\/?$/.test(before)) {
            startCompletion(update.view);
          }
        }
      }),
      EditorView.contentAttributes.of({
        "aria-label": "SPL source code editor",
      }),
    ],
  });

  viewRef = new EditorView({
    state: editorState,
    parent: editorHost,
  });

  // Sync CodeMirror theme when Starlight toggles dark / light mode
  const themeObserver = new MutationObserver(() => {
    viewRef.dispatch({
      effects: themeCompartment.reconfigure(createSplEditorTheme(isLightTheme())),
    });
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  // Wire toolbar controls
  runBtn?.addEventListener("click", () => {
    if (runBtn.getAttribute("aria-disabled") === "true") return;
    void runCurrentCode(viewRef);
  });

  completeBtn?.addEventListener("click", () => {
    viewRef.focus();
    startCompletion(viewRef);
  });

  shareBtn?.addEventListener("click", async () => {
    const hash = `code=${encodeCodeToHash(viewRef.state.doc.toString())}`;
    const url = `${window.location.origin}${window.location.pathname}#${hash}`;
    window.history.replaceState(null, "", `#${hash}`);
    try {
      await navigator.clipboard.writeText(url);
      announce("Shareable playground link copied to clipboard");
    } catch {
      announce("Updated URL hash — copy the address bar to share");
    }
  });

  const showManualRunPrompt = (preset: PlaygroundPreset) => {
    selectTab("pg-tab-output");
    outputEl.replaceChildren();
    const note = document.createElement("p");
    note.className = "spl-empty-state";
    note.textContent = `Ready to run ${preset.filename} live against /api/llm. Press Run (Ctrl+Enter) to execute.`;
    outputEl.append(note);
    if (runMetaEl) {
      runMetaEl.textContent = "Ready";
      runMetaEl.dataset.state = "idle";
    }
  };

  resetBtn?.addEventListener("click", () => {
    viewRef.dispatch({
      changes: { from: 0, to: viewRef.state.doc.length, insert: activePreset.code },
    });
    if (filenameEl) filenameEl.textContent = activePreset.filename;
    announce(`Reset editor to ${activePreset.filename}`);
    if (activePreset.autoRun === false) {
      showManualRunPrompt(activePreset);
    } else {
      void runCurrentCode(viewRef);
    }
  });

  presetSelect?.addEventListener("change", () => {
    activePreset = findPreset(presetSelect.value);
    viewRef.dispatch({
      changes: { from: 0, to: viewRef.state.doc.length, insert: activePreset.code },
    });
    if (filenameEl) filenameEl.textContent = activePreset.filename;
    window.history.replaceState(null, "", `${window.location.pathname}?example=${activePreset.id}`);
    announce(`Loaded example ${activePreset.filename}`);
    if (activePreset.autoRun === false) {
      showManualRunPrompt(activePreset);
    } else {
      void runCurrentCode(viewRef);
    }
  });

  // Initial sync + initial run (skip auto-run for live LLM presets so API quota is only used on Run)
  syncAnalysis(viewRef);
  updateCursorAndSignature(viewRef);
  if (!sharedCode && activePreset.autoRun === false) {
    showManualRunPrompt(activePreset);
  } else {
    void runCurrentCode(viewRef);
  }
}

for (const el of document.querySelectorAll<HTMLElement>("[data-spl-playground]")) {
  mountSplPlayground(el);
}
