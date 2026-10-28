import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const vsctm = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function loadGrammar(scopeName = 'source.spl') {
    const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer;
    await oniguruma.loadWASM(wasm);
    const registry = new vsctm.Registry({
        onigLib: Promise.resolve({
            createOnigScanner: (p) => new oniguruma.OnigScanner(p),
            createOnigString: (s) => new oniguruma.OnigString(s),
        }),
        getInjections: (scope) => scope === 'text.html.markdown' ? ['spl.markdown.injection'] : [],
        loadGrammar: async (scope) => {
            if (scope === 'text.html.markdown') {
                return {
                    scopeName: scope,
                    patterns: [
                        { begin: '<!--', end: '-->', name: 'comment.block.html' },
                        {
                            begin: '^ {0,3}(`{3,}|~{3,}).*$',
                            end: '^ {0,3}\\1[`~]*\\s*$',
                            name: 'markup.fenced_code.block.markdown',
                        },
                        { match: '^ {4}.*$', name: 'markup.raw.block.markdown' },
                        { begin: '`', end: '`', name: 'markup.inline.raw.string.markdown' },
                        { begin: '^ {0,3}> ?', end: '$', name: 'markup.quote.markdown' },
                    ],
                };
            }
            const filename = scope === 'source.spl' ? 'spl.tmLanguage.json'
                : scope === 'spl.markdown.injection' ? 'markdown.tmLanguage.json' : undefined;
            return filename ? vsctm.parseRawGrammar(fs.readFileSync(path.join(root, 'syntaxes', filename), 'utf8'), filename) : null;
        },
    });
    return registry.loadGrammar(scopeName);
}
