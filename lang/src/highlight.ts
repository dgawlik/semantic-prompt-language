import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import powershell from 'highlight.js/lib/languages/powershell';
import typescript from 'highlight.js/lib/languages/typescript';
import yaml from 'highlight.js/lib/languages/yaml';
import { HEADER_KEYS } from './scanner.js';

// `js`, `ts`, `sh` and `md` resolve through the aliases declared by the grammars themselves.
for (const [name, grammar] of Object.entries({ bash, json, javascript, typescript, powershell, markdown, yaml })) hljs.registerLanguage(name, grammar);

// A `.spl` file is TypeScript with Markdown comments and `---` blocks, each on lines of their own.
hljs.registerLanguage('spl', () => {
    const line = (pattern: string): RegExp => new RegExp(`^[ \\t]*${pattern}[ \\t]*\\r?$`);
    const reference = { scope: 'variable', match: /(?<![\w@])@=?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/ };
    return {
        name: 'SPL',
        subLanguage: 'typescript',
        contains: [
            { begin: line('//\\*'), end: line('\\*//'), beginScope: 'comment', endScope: 'comment', subLanguage: 'markdown' },
            {
                begin: line('---'), end: line('---'), beginScope: 'meta', endScope: 'meta', scope: 'quote',
                contains: [
                    { scope: 'attr', match: new RegExp(`^[ \\t]*(?:${HEADER_KEYS.map(key => key.name).join('|')})(?=[ \\t]*:(?:\\s|$))`) },
                    { scope: 'keyword', match: /->/ },
                    reference,
                ],
            },
        ],
    };
});

/** The highlighter of the documentation site and of `spl doc --format html`. */
export default hljs;
