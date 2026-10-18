import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const vsctm = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function loadGrammar() {
    const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer;
    await oniguruma.loadWASM(wasm);
    const registry = new vsctm.Registry({
        onigLib: Promise.resolve({
            createOnigScanner: (p) => new oniguruma.OnigScanner(p),
            createOnigString: (s) => new oniguruma.OnigString(s),
        }),
        loadGrammar: async (scope) =>
            scope === 'source.spl'
                ? vsctm.parseRawGrammar(fs.readFileSync(path.join(root, 'syntaxes', 'spl.tmLanguage.json'), 'utf8'), 'spl.tmLanguage.json')
                : null,
    });
    return registry.loadGrammar('source.spl');
}
