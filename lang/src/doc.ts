import * as fs from 'node:fs';
import { Marked, Renderer, type Tokens } from 'marked';
import { SplSyntaxError } from './errors.js';
import hljs from './highlight.js';
import { scan as scanSource, type FileDefaults, type SplBlock } from './scanner.js';

export interface DocOptions {
    /** Shifts every heading of the prose down by this many levels, to nest the document in a larger one. */
    demote?: number;
}

const inline = (value: unknown): string => Array.isArray(value) ? value.map(inline).join(', ')
    : `\`${typeof value === 'string' ? value : JSON.stringify(value)}\``;
const fenceFor = (code: string): string => '`'.repeat(Math.max(3, ...(code.match(/`+/g) ?? []).map(run => run.length + 1)));

/** Applies `change` to the lines outside fenced code. */
function outsideFences(markdown: string, change: (line: string, next: string | undefined) => string): string {
    let fence: string | undefined;
    return markdown.split('\n').map((line, index, lines) => {
        const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
        if (marker && (!fence || marker.startsWith(fence))) {
            fence = fence ? undefined : marker;
            return line;
        }
        return fence ? line : change(line, lines[index + 1]);
    }).join('\n');
}

/** A block as a callout: its mode, its settings as a small table and its instruction as quoted text. */
function callout(title: string, settings: [string, unknown][], text?: string): string {
    const lines = [`**${title}**`];
    if (settings.length) lines.push('', '| Setting | Value |', '| --- | --- |', ...settings.map(([key, value]) => `| \`${key}\` | ${inline(value).replace(/\|/g, '\\|')} |`));
    // The instruction keeps its line breaks: a plain line followed by another ends with a hard break.
    if (text) lines.push('', ...outsideFences(text, (line, next) => line.trim() && next?.trim() ? `${line}  ` : line).split('\n'));
    return lines.map(line => line ? `> ${line}` : '>').join('\n');
}

function blockCallout(block: SplBlock): string {
    const [output] = block.mode === 'ask' ? block.outputs : [];
    return callout(`${block.mode} block`, [
        ...(output ? [['outputVar', `${output.assign ? '=' : ''}${output.name}`] as [string, unknown]] : []),
        ...(output?.type ? [['outputType', output.type] as [string, unknown]] : []),
        ...Object.entries(block.settings),
    ], block.text);
}

/**
 * Documentation for a workflow, as Markdown. `//*` comments become prose, each run of top-level code
 * becomes one `ts` fence and each top-level block becomes a callout; a block nested in code stays in its fence.
 */
export function documentMarkdown(source: string, options: DocOptions = {}): string {
    const scan = scanSource(source);
    if (scan.problems.length) throw new SplSyntaxError(scan.problems);
    type Item = { line: number; endLine: number; render: () => string };
    const demote = options.demote ?? 0;
    const items: Item[] = [
        ...scan.comments.map(comment => ({
            line: comment.line, endLine: comment.endLine,
            render: () => demote ? outsideFences(comment.text, line => line.replace(/^#{1,6}(?=\s)/, marks => '#'.repeat(Math.min(6, marks.length + demote)))) : comment.text,
        })),
        ...scan.blocks.filter(block => block.depth === 0).map(block => ({ line: block.line, endLine: block.endLine, render: () => blockCallout(block) })),
        ...(scan.defaults ? [scan.defaults].map((defaults: FileDefaults) => ({
            line: defaults.line, endLine: defaults.endLine, render: () => callout('file defaults', Object.entries(defaults.settings)),
        })) : []),
    ].sort((a, b) => a.line - b.line);
    const parts: string[] = [];
    const code = (from: number, to: number): void => {
        const text = scan.lines.slice(from - 1, to).join('\n').replace(/^(?:[ \t]*\n)+|\s+$/g, '');
        if (!text) return;
        const fence = fenceFor(text);
        parts.push(`${fence}ts\n${text}\n${fence}`);
    };
    let line = 1;
    for (const item of items) {
        code(line, item.line - 1);
        parts.push(item.render());
        line = item.endLine + 1;
    }
    code(line, scan.lines.length);
    return `${parts.filter(Boolean).join('\n\n')}\n`;
}

const escape = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** The documentation site's stylesheet: shipped beside the compiled module, or read from the repository. */
function stylesheet(): string {
    for (const candidate of ['./style.css', '../../docs/assets/style.css']) {
        const file = new URL(candidate, import.meta.url);
        if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    }
    return '';
}

/** Documentation for a workflow as one self-contained HTML page, with the documentation site's styles and highlighter. */
export function documentHtml(source: string, title: string): string {
    const defaults = new Renderer();
    const parser = new Marked({ gfm: true, renderer: {
        code(token: Tokens.Code) {
            const language = token.lang?.split(/\s/)[0] || 'text';
            const content = hljs.getLanguage(language) ? hljs.highlight(token.text, { language }).value : escape(token.text);
            return `<figure class="code-block"><figcaption><span class="code-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="code-filename">${escape(language)}</span></figcaption><pre tabindex="0"><code class="language-${escape(language)}">${content}\n</code></pre></figure>\n`;
        },
        table(token: Tokens.Table) {
            return `<div class="table-scroll" tabindex="0">${defaults.table.call(this, token)}</div>\n`;
        },
        html(token: Tokens.HTML | Tokens.Tag) { return escape(token.text); },
    } });
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escape(title)}</title>
<style>${stylesheet()}</style>
</head>
<body>
<main id="page" class="standalone"><article class="prose">${parser.parse(documentMarkdown(source)) as string}</article></main>
</body>
</html>
`;
}
