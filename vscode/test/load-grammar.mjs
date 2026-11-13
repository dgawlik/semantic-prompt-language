import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const vsctm = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INJECTION = 'spl.markdown.injection';

const fenced = (languages, embedded) => ({
    begin: `^ {0,3}(\`{3,}|~{3,})[ \\t]*(?i:${languages})(?=\\s|$).*$`,
    end: '^ {0,3}\\1[`~]*\\s*$',
    name: 'markup.fenced_code.block.markdown',
    contentName: `meta.embedded.block.${embedded}`,
});

// A stand-in for VS Code's Markdown grammar: only the scopes the injection selector depends on.
// VS Code embeds its own JavaScript and TypeScript grammars in fences; here their content stays plain.
const markdown = {
    scopeName: 'text.html.markdown',
    patterns: [
        { begin: '<!--', end: '-->', name: 'comment.block.html' },
        fenced('js|javascript|mjs', 'javascript'),
        fenced('ts|typescript|mts', 'typescript'),
        { begin: '^ {0,3}(`{3,}|~{3,}).*$', end: '^ {0,3}\\1[`~]*\\s*$', name: 'markup.fenced_code.block.markdown' },
        { match: '^ {4}.*$', name: 'markup.raw.block.markdown' },
        { begin: '`', end: '`', name: 'markup.inline.raw.string.markdown' },
        { begin: '^ {0,3}> ?', end: '$', name: 'markup.quote.markdown' },
    ],
};

let engine;
/** The regular expression engine VS Code tokenizes with; its WebAssembly module loads once. */
function onigLib() {
    engine ??= oniguruma.loadWASM(fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer).then(() => ({
        createOnigScanner: (p) => new oniguruma.OnigScanner(p),
        createOnigString: (s) => new oniguruma.OnigString(s),
    }));
    return engine;
}

/** Loads the stand-in Markdown grammar with the extension's blockquote injection applied. */
export async function loadGrammar() {
    const registry = new vsctm.Registry({
        onigLib: onigLib(),
        getInjections: (scope) => scope === markdown.scopeName ? [INJECTION] : [],
        loadGrammar: async (scope) => {
            if (scope === markdown.scopeName) return markdown;
            if (scope !== INJECTION) return null;
            const file = path.join(root, 'syntaxes', 'markdown.tmLanguage.json');
            return vsctm.parseRawGrammar(fs.readFileSync(file, 'utf8'), file);
        },
    });
    return registry.loadGrammar(markdown.scopeName);
}

// Stand-ins for the grammars a `.spl` file embeds. The JavaScript one has constructs that span
// lines, as the real grammar does: a block must end at its closing tag even inside one of them.
const embedded = {
    'source.js': {
        scopeName: 'source.js',
        patterns: [
            { begin: '/\\*', end: '\\*/', name: 'comment.block.js' },
            { begin: '`', end: '`', name: 'string.template.js' },
            { begin: "'", end: "'|$", name: 'string.quoted.single.js' },
            { match: '\\b(?:const|let|await|function|return)\\b', name: 'keyword.js' },
        ],
    },
    'source.ts': { scopeName: 'source.ts', patterns: [{ match: '\\b(?:const|interface|number)\\b', name: 'keyword.ts' }] },
    'source.yaml': { scopeName: 'source.yaml', patterns: [{ match: '^[\\w-]+(?=:)', name: 'entity.name.tag.yaml' }, { begin: "'", end: "'", name: 'string.quoted.single.yaml' }] },
    'source.json': { scopeName: 'source.json', patterns: [{ begin: '"', end: '"', name: 'string.quoted.double.json' }] },
};
export const SPL = 'source.spl';

/** Loads the grammar of `.spl` files with stand-ins for the languages it embeds. */
export async function loadSplGrammar() {
    const registry = new vsctm.Registry({
        onigLib: onigLib(),
        loadGrammar: async (scope) => {
            if (Object.hasOwn(embedded, scope)) return embedded[scope];
            if (scope !== SPL) return null;
            const file = path.join(root, 'syntaxes', 'spl.tmLanguage.json');
            return vsctm.parseRawGrammar(fs.readFileSync(file, 'utf8'), file);
        },
    });
    return registry.loadGrammar(SPL);
}

/** Tokenizes consecutive lines: each line with its tokens and the depth of the constructs still open after it. */
export function tokenizeLines(grammar, lines) {
    let stack = vsctm.INITIAL;
    return lines.map((line) => {
        const result = grammar.tokenizeLine(line, stack);
        stack = result.ruleStack;
        return {
            line,
            depth: stack.depth,
            tokens: result.tokens.map((token) => ({
                text: line.slice(token.startIndex, token.endIndex), start: token.startIndex, end: token.endIndex, scopes: token.scopes,
            })),
        };
    });
}
