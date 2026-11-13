import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import powershell from 'highlight.js/lib/languages/powershell';
import markdown from 'highlight.js/lib/languages/markdown';

// Fence info strings the runtime executes, by the highlight.js language that colors them.
const FENCES = { javascript: 'js|javascript|mjs', typescript: 'ts|typescript|mts' };

// Workflow documents shown inside `markdown` blocks: blockquotes are agent commands and
// js/ts fences are code, so both get more than plain Markdown coloring.
hljs.registerLanguage('markdown', (engine) => {
    const language = markdown(engine);
    // highlight.js drops regex flags, so case-insensitive markers spell out both cases.
    const anyCase = (word) => [...word].map((letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`).join('');
    const marker = { scope: 'keyword', match: new RegExp(`(?<![\\w@\\\\])@(?:${['CTL', 'CODEGEN', 'validate', 'success', 'fail'].map(anyCase).join('|')})\\b`) };
    const reference = { scope: 'variable', match: /(?<![\w@\\])@(?:env\.[A-Za-z_]\w*|[A-Za-z_]\w*)/ };
    const control = { scope: 'attr', match: /\b(?:restrict|enforce|forbid|model|reasoning)\b(?=\s*=)/ };
    const quote = language.contains.find((mode) => mode.className === 'quote');
    quote.begin = /^ {0,3}>[ \t]?/;
    quote.contains.unshift(marker, control, reference);
    language.contains.unshift(...Object.entries(FENCES).map(([subLanguage, names]) => ({
        begin: new RegExp(`^ {0,3}(\`{3,}|~{3,})[ \\t]*(?:${names})(?:[ \\t][^\`\\r\\n]*)?\\r?$`),
        end: /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/,
        beginScope: 'meta',
        endScope: 'meta',
        subLanguage,
        'on:begin': (match, response) => { response.data.fence = match[1]; },
        'on:end': (match, response) => {
            const fence = response.data.fence;
            if (match[1][0] !== fence[0] || match[1].length < fence.length) response.ignoreMatch();
        },
    })));
    return language;
});

// `.spl` workflows shown inside `spl` blocks: the same steps as blocks, each tag on its own line.
hljs.registerLanguage('spl', () => {
    const line = (pattern) => new RegExp(`^[ \\t]*${pattern}[ \\t]*\\r?$`);
    const string = {
        scope: 'string',
        variants: [
            { begin: /r?'''/, end: /'''/ }, { begin: /r?"""/, end: /"""/ },
            { begin: /r?'/, end: /'|$/ }, { begin: /r?"/, end: /"|$/ }, { begin: /`/, end: /`/ },
        ],
        contains: [{ match: /\\./ }],
    };
    const list = { begin: /\[/, end: /\]/, contains: [string] };
    const restrictions = { begin: /\{/, end: /\}/, contains: [{ scope: 'attr', match: /\b(?:fs|exec|net|mcp)\b(?=\s*:)/ }, string, list] };
    const settings = [{ scope: 'attr', match: /\b(?:restrict|enforce|forbid|model|reasoning)\b(?=\s*=)/ }, string, restrictions, list];
    const marker = { scope: 'keyword', match: /(?<![\w@\\])@(?:validate|success|fail)\b/ };
    const reference = { scope: 'variable', match: /(?<![\w@\\])@(?:env\.[A-Za-z_]\w*|[A-Za-z_]\w*)/ };
    const code = (tag, subLanguage) => ({
        begin: line(`\\{${tag}(?:[ \\t]+(?:ignore|no-run))?[ \\t]*\\}`), end: line(`\\{/${tag}\\}`),
        beginScope: 'meta', endScope: 'meta', subLanguage,
    });
    // The opening tag carries literal settings; the text up to the closing tag is for a model.
    const instruction = (tag, contains) => ({
        begin: new RegExp(`^[ \\t]*\\{${tag}(?=[\\s}])`), end: /\}/, beginScope: 'meta', endScope: 'meta', contains: settings,
        starts: { scope: 'quote', end: line(`\\{/${tag}\\}`), endScope: 'meta', contains },
    });
    return {
        name: 'SPL',
        contains: [
            { scope: 'meta', begin: /^---[ \t]*\r?$/, end: /^(?:---|\.\.\.)[ \t]*\r?$/, contains: [{ scope: 'attr', match: /^[A-Za-z_][\w-]*(?=:)/ }, string] },
            { scope: 'comment', begin: line('\\{comment\\}'), end: line('\\{/comment\\}') },
            code('js', 'javascript'), code('ts', 'typescript'), code('lock', 'json'),
            instruction('agent', [marker, reference]), instruction('codegen', []),
        ],
    };
});

// `js`, `ts` and `sh` resolve through the aliases declared by the grammars themselves.
for (const [name, grammar] of Object.entries({ bash, json, javascript, typescript, powershell })) hljs.registerLanguage(name, grammar);

export default hljs;
