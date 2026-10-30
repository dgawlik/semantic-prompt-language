import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import javascript from 'highlight.js/lib/languages/javascript';
import powershell from 'highlight.js/lib/languages/powershell';
import ebnf from 'highlight.js/lib/languages/ebnf';
import markdown from 'highlight.js/lib/languages/markdown';

hljs.registerLanguage('spl', (engine) => {
    const keywords = {
        keyword: 'let def if elif else for in while return try except assert fail success enforce forbid restrict ask think agent human break continue pass and or not',
        literal: 'True False None',
        built_in: 'len str int float bool type list range abs round min max sum sorted reversed enumerate zip any all keys values items json_parse json_stringify log read_file write_file web_fetch web_search shell',
    };
    const substitution = { scope: 'subst', begin: /\{/, end: /\}/, keywords, contains: [] };
    const string = {
        scope: 'string',
        variants: [
            { begin: /'''/, end: /'''/ },
            { begin: /"""/, end: /"""/ },
            { begin: /'/, end: /'|$/ },
            { begin: /"/, end: /"|$/ },
        ],
        contains: [
            { scope: 'char.escape', match: /\\(?:[ntr0\\'"{}]|\r?\n)/ },
            { match: /\{\{|\}\}/ },
            substitution,
        ],
    };
    const expression = [
        engine.HASH_COMMENT_MODE,
        {
            scope: 'string',
            variants: [
                { begin: /\br'''/, end: /'''/ },
                { begin: /\br"""/, end: /"""/ },
                { begin: /\br'/, end: /'|$/ },
                { begin: /\br"/, end: /"|$/ },
            ],
        },
        string,
        { scope: 'variable', match: /\$(?:env|args)\b/ },
        {
            match: [/\bdef\b/, /\s+/, /[A-Za-z_]\w*/],
            scope: { 1: 'keyword', 3: 'title.function' },
        },
        { scope: 'attr', match: /\b(?:len|fmt|reasoning|hide|schema|repairs|model|level)\b(?=\s*=(?!=))/ },
        { scope: 'number', match: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/ },
        { scope: 'operator', match: /\/\/=|\*\*|\/\/|==|!=|<=|>=|[-+*/%<>=]=?/ },
    ];
    const braces = { begin: /\{/, end: /\}/, keywords, contains: [...expression, 'self'] };
    substitution.contains = [...expression, braces];
    return { name: 'SPL', keywords, contains: expression };
});

hljs.registerLanguage('markdown', (engine) => {
    const language = markdown(engine);
    const reference = { scope: 'variable', match: /(?<![\w@])@[A-Za-z_]\w*/ };
    const marker = { scope: 'keyword', match: /(?<![\w@])@(?:ENFORCE|FORBID|RESTRICT|HUMAN|SUCCESS|fail|validate)\b/ };
    const quote = language.contains.find((mode) => mode.className === 'quote');
    quote.begin = /^ {0,3}>[ \t]?/;
    quote.contains.unshift(marker, reference);
    language.contains.unshift({
        begin: /^ {0,3}(`{3,}|~{3,})spl[ \t]*\r?$/,
        end: /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/,
        beginScope: 'meta',
        endScope: 'meta',
        subLanguage: 'spl',
        'on:begin': (match, response) => { response.data.fence = match[1]; },
        'on:end': (match, response) => {
            const fence = response.data.fence;
            if (match[1][0] !== fence[0] || match[1].length < fence.length) response.ignoreMatch();
        },
    });
    return language;
});

for (const [name, grammar] of Object.entries({ bash, sh: bash, json, js: javascript, javascript, powershell, ebnf })) hljs.registerLanguage(name, grammar);

export default hljs;
