import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const testing = process.argv.includes('--test');

await rm('out', { recursive: true, force: true });
await build({
    entryPoints: {
        extension: 'src/extension.ts',
        server: 'src/server.ts',
        ...(testing ? {
            'test/language-server.test': 'test/language-server.test.ts',
            'test/grammar.test': 'test/grammar.test.ts',
            'test/command-line.test': 'test/command-line.test.ts',
        } : {}),
    },
    outdir: 'out',
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode', 'vscode-textmate', 'vscode-oniguruma'],
    sourcemap: true,
    logLevel: 'info',
});

await copyFile('node_modules/vscode-languageclient/lib/node/terminateProcess.sh', 'out/terminateProcess.sh');
await chmod('out/terminateProcess.sh', 0o755);

// Declarations the language server gives to TypeScript: the workflow library as globals of every
// `.spl` file, TypeScript's standard library, and Node.js typings for workspaces that have none installed.
execFileSync(process.execPath, [
    require.resolve('typescript/bin/tsc'), '-p', '../lang/tsconfig.json',
    '--declaration', '--emitDeclarationOnly', '--outDir', 'out/spl-types/dist',
], { stdio: 'inherit' });
await copyFile('../lang/globals.d.ts', 'out/spl-types/globals.d.ts');
await writeFile('out/spl-types/package.json', '{ "type": "module" }\n');

const libraries = path.dirname(require.resolve('typescript/lib/lib.d.ts'));
await mkdir('out/ts-lib', { recursive: true });
for (const file of await readdir(libraries)) {
    if (/^lib\..*\.d\.ts$|^lib\.d\.ts$/.test(file)) await copyFile(path.join(libraries, file), path.join('out/ts-lib', file));
}

const declarations = source => !/\.(?:md|json|map)$/.test(source) || source.endsWith('package.json');
await cp(path.dirname(require.resolve('@types/node/package.json')), 'out/types/node', { recursive: true, filter: declarations });
await cp(path.dirname(require.resolve('undici-types/package.json')), 'out/types/node_modules/undici-types', { recursive: true, filter: declarations });
