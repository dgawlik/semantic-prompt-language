import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import hljs from '../../docs/highlight.mjs';

const highlight = (text, language = 'spl') => hljs.highlight(text, { language }).value;
const decode = (html) => html.replace(/<\/?span\b[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

describe('documentation syntax highlighting', () => {
    it('highlights SPL keywords, built-ins, modifiers and runtime inputs', () => {
        const html = highlight("let answer = ask(fmt='integer', repairs=1) 'Rate {$args[0]}'\nlog(level=debug)($env.USER)");
        for (const keyword of ['let', 'ask']) expect(html).toContain(`<span class="hljs-keyword">${keyword}</span>`);
        for (const name of ['fmt', 'repairs', 'level']) expect(html).toContain(`<span class="hljs-attr">${name}</span>`);
        for (const name of ['$args', '$env']) expect(html).toContain(`<span class="hljs-variable">${name}</span>`);
        expect(html).toContain('<span class="hljs-built_in">log</span>');
    });

    it('highlights interpolations in every non-raw quote style', () => {
        for (const quote of ["'", '"', "'''", '"""']) {
            const html = highlight(`${quote}Total: {round(total, 2)}${quote}`);
            expect(html).toContain('<span class="hljs-subst">{<span class="hljs-built_in">round</span>');
            expect(html).toContain('<span class="hljs-number">2</span>');
        }
    });

    it('keeps literal braces and escapes inside strings', () => {
        const text = String.raw`let text = 'Use {{name}}, \{name\}, and \n'`;
        const html = highlight(text);
        expect(html).not.toContain('hljs-subst');
        expect(html).toContain('hljs-char escape');
        expect(decode(html)).toBe(text);
    });

    it('does not interpret raw string braces or backslashes', () => {
        for (const quote of ["'", '"', "'''", '"""']) {
            const text = `r${quote}C:\\temp\\{name}${quote}`;
            expect(highlight(text)).toBe(`<span class="hljs-string">${text.replace(/"/g, '&quot;').replace(/'/g, '&#x27;')}</span>`);
        }
        const text = String.raw`let raw = r'ends in \'
success True`;
        expect(highlight(text)).toContain('<span class="hljs-keyword">success</span>');
    });

    it('handles nested dicts and quoted keys within interpolation', () => {
        const text = `fail 'Fix {vulnerabilities["high"][0]} and {len({"high": [1]})}'`;
        const html = highlight(text);
        expect(html.match(/hljs-subst/g)).toHaveLength(2);
        expect(html).toContain('<span class="hljs-string">&quot;high&quot;</span>');
        expect(html).toContain('<span class="hljs-built_in">len</span>');
        expect(decode(html)).toBe(text);
    });

    it('does not inherit Python-only syntax', () => {
        const html = highlight('class import lambda\n# ask {ignored}\ndef run(value) {\n    return 1e-3 // 2\n}');
        for (const keyword of ['class', 'import', 'lambda']) expect(html).not.toContain(`>${keyword}</span>`);
        expect(html).toContain('<span class="hljs-title function_">run</span>');
        expect(html).toContain('<span class="hljs-number">1e-3</span>');
        expect(html).toContain('<span class="hljs-operator">//</span>');
        expect(html).not.toContain('hljs-subst');
    });

    it('highlights references and agent markers only in blockquotes', () => {
        const text = 'Email user@example.com and mention @outside.\n\n> @FORBID guessing @facts; @validate[Schema] save to @result';
        const html = highlight(text, 'markdown');
        expect(html).toContain('<span class="hljs-keyword">@FORBID</span>');
        expect(html).toContain('<span class="hljs-keyword">@validate</span>');
        for (const name of ['@facts', '@result']) expect(html).toContain(`<span class="hljs-variable">${name}</span>`);
        for (const name of ['@example', '@outside']) expect(html).not.toContain(`>${name}</span>`);
        expect(decode(html)).toBe(text);
    });

    it('highlights embedded SPL in all supported Markdown fence styles', () => {
        for (const fence of ['```', '````', '~~~', '~~~~']) {
            for (const indent of ['', '   ']) {
                for (const newline of ['\n', '\r\n']) {
                    const text = `${indent}${fence}spl${newline}success "{len($args)}"${newline}${indent}${fence}${fence[0]}  ${newline}`;
                    const html = highlight(text, 'markdown');
                    expect(html).toContain('<span class="hljs-keyword">success</span>');
                    expect(html).toContain('<span class="hljs-variable">$args</span>');
                    expect(decode(html)).toBe(text);
                }
            }
        }
    });

    it('does not close a fence on a shorter or different delimiter', () => {
        const text = '````spl\n# comment\n```\n~~~\nsuccess True\n````\n\n> Save to @result';
        const html = highlight(text, 'markdown');
        expect(html).toContain('<span class="hljs-keyword">success</span>');
        expect(html).toContain('<span class="hljs-variable">@result</span>');
        expect(decode(html)).toBe(text);
    });

    it('does not highlight apparent SPL fences inside another code block', () => {
        const text = '````text\n```spl\nsuccess True\n```\n````';
        expect(highlight(text, 'markdown')).not.toContain('hljs-keyword');
    });

    it('preserves every example document and its source text', () => {
        const directory = new URL('../examples/', import.meta.url);
        for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.md'))) {
            const text = fs.readFileSync(new URL(file, directory), 'utf8');
            const html = highlight(text, 'markdown');
            expect(decode(html), file).toBe(text);
            if (/^```spl\r?$/m.test(text)) expect(html, file).toContain('class="language-spl"');
        }
    });

    it('escapes HTML without changing copied code', () => {
        const text = `let html = '<script>alert("x")</script> & text'`;
        const html = highlight(text);
        expect(html).not.toContain('<script>');
        expect(decode(html)).toBe(text);
    });
});
