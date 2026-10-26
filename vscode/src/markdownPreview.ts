import hljs from 'highlight.js/lib/core';
import type { HLJSApi, Language, Mode } from 'highlight.js';

const KEYWORDS = [
    'def', 'let', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'return', 'pass',
    'try', 'except', 'assert', 'fail', 'success', 'enforce', 'forbid', 'restrict',
    'ask', 'think', 'agent', 'human', 'and', 'or', 'not', 'in',
];
const LITERALS = ['True', 'False', 'None'];
const BUILTINS = [
    'len', 'str', 'int', 'float', 'bool', 'type', 'list', 'range', 'abs', 'round', 'min', 'max', 'sum',
    'sorted', 'reversed', 'enumerate', 'zip', 'any', 'all', 'keys', 'values', 'items',
    'json_parse', 'json_stringify', 'log',
    'read_file', 'write_file', 'web_fetch', 'web_search', 'shell',
];
const NOT_A_CALL = new RegExp(`\\b(?!(?:${[...KEYWORDS, ...BUILTINS].join('|')})\\b)`);

export function splLanguage(api: HLJSApi): Language {
    const keywords = { keyword: KEYWORDS, literal: LITERALS, built_in: BUILTINS };
    const number: Mode = { scope: 'number', match: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, relevance: 0 };
    const subst: Mode = { scope: 'subst', begin: /\{/, end: /\}/, keywords, contains: [] };
    const stringContent: Mode[] = [
        { scope: 'char.escape', match: /\\[\s\S]/ },
        { scope: 'char.escape', match: /\{\{|\}\}/ },
        subst,
    ];
    const string: Mode = {
        scope: 'string',
        variants: [
            { begin: /[rR]'''/, end: /'''/ },
            { begin: /[rR]"""/, end: /"""/ },
            { begin: /[rR]'/, end: /'|$/ },
            { begin: /[rR]"/, end: /"|$/ },
            { begin: /'''/, end: /'''/, contains: stringContent },
            { begin: /"""/, end: /"""/, contains: stringContent },
            { begin: /'/, end: /'|$/, contains: stringContent },
            { begin: /"/, end: /"|$/, contains: stringContent },
        ],
    };
    const expression: Mode[] = [
        api.HASH_COMMENT_MODE,
        string,
        number,
        { scope: 'variable.language', match: /\$(?:env|args)\b/ },
        { match: [/\bdef/, /\s+/, /[A-Za-z_]\w*/], scope: { 1: 'keyword', 3: 'title.function' } },
        { match: [/\blet/, /\s+/, /[A-Za-z_]\w*/], scope: { 1: 'keyword', 3: 'variable' } },
        { scope: 'attr', match: /\b(?:len|fmt|reasoning|show|schema|repairs|model|level)(?=\s*=(?!=))/ },
        { scope: 'title.function.invoke', match: api.regex.concat(NOT_A_CALL, /[A-Za-z_]\w*(?=\s*\()/), relevance: 0 },
    ];
    subst.contains = expression;

    return {
        name: 'SPL',
        aliases: ['spl'],
        keywords,
        contains: [
            {
                scope: 'meta',
                begin: /@\(/,
                end: /\)/,
                contains: [string, { scope: 'attr', match: /\b[A-Za-z_]\w*(?=\s*=(?!=))/ }],
            },
            ...expression,
        ],
    };
}

hljs.registerLanguage('spl', splLanguage);

type Highlighter = (code: string, lang: string, attrs: string) => string;
interface MarkdownIt {
    options: { highlight?: Highlighter | null };
}

export function extendMarkdownIt<T extends MarkdownIt>(md: T): T {
    const fallback = md.options.highlight;
    md.options.highlight = (code, lang, attrs) => {
        if (lang?.toLowerCase() === 'spl') {
            return hljs.highlight(code, { language: 'spl', ignoreIllegals: true }).value;
        }
        return fallback ? fallback(code, lang, attrs) : '';
    };
    return md;
}
