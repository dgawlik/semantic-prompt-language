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
        loadGrammar: async (scope) => {
            const filename = scope === 'source.spl' ? 'spl.tmLanguage.json'
                : scope === 'spl.markdown.injection' ? 'markdown.tmLanguage.json' : undefined;
            return filename ? vsctm.parseRawGrammar(fs.readFileSync(path.join(root, 'syntaxes', filename), 'utf8'), filename) : null;
        },
    });
    return registry.loadGrammar(scopeName);
}
