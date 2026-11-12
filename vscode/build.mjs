import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const testing = process.argv.includes('--test');

await build({
    entryPoints: {
        extension: 'src/extension.ts',
        server: 'src/server.ts',
        notebookWorker: 'src/notebookWorker.ts',
        ...(testing ? {
            'test/language-server.test': 'test/language-server.test.ts',
            'test/notebook.test': 'test/notebook.test.ts',
        } : {}),
    },
    outdir: 'out',
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    define: { 'import.meta.dirname': '__dirname' },
    target: 'node18',
    external: ['vscode', '@ai-sdk/mcp', '@ai-sdk/mcp/*', 'openai', '@anthropic-ai/sdk', '@google/genai'],
    sourcemap: true,
    logLevel: 'info',
    logOverride: { 'empty-import-meta': 'silent' },
});

await copyFile('node_modules/vscode-languageclient/lib/node/terminateProcess.sh', 'out/terminateProcess.sh');
await chmod('out/terminateProcess.sh', 0o755);

// Declarations the language server gives to TypeScript: the workflow library as fence globals,
// TypeScript's standard library, and Node.js typings for workspaces that have none installed.
await rm('out/spl-types', { recursive: true, force: true });
execFileSync(process.execPath, [
    require.resolve('typescript/bin/tsc'), '-p', '../lang/tsconfig.json',
    '--declaration', '--emitDeclarationOnly', '--outDir', 'out/spl-types/dist',
], { stdio: 'inherit' });
await copyFile('../lang/globals.d.ts', 'out/spl-types/globals.d.ts');
await writeFile('out/spl-types/package.json', '{ "type": "module" }\n');

const libraries = path.dirname(require.resolve('typescript/lib/lib.d.ts'));
await rm('out/ts-lib', { recursive: true, force: true });
await mkdir('out/ts-lib', { recursive: true });
for (const file of await readdir(libraries)) {
    if (/^lib\..*\.d\.ts$|^lib\.d\.ts$/.test(file)) await copyFile(path.join(libraries, file), path.join('out/ts-lib', file));
}

await rm('out/types', { recursive: true, force: true });
const declarations = source => !/\.(?:md|json|map)$/.test(source) || source.endsWith('package.json');
await cp(path.dirname(require.resolve('@types/node/package.json')), 'out/types/node', { recursive: true, filter: declarations });
await cp(path.dirname(require.resolve('undici-types/package.json')), 'out/types/node_modules/undici-types', { recursive: true, filter: declarations });

if (testing) {
    await build({
        entryPoints: ['test/notebook-ui.test.ts'],
        outdir: 'out/test',
        outExtension: { '.js': '.cjs' },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        define: { 'import.meta.dirname': '__dirname' },
        alias: { vscode: './test/vscodeMock.ts' },
        logLevel: 'info',
        logOverride: { 'empty-import-meta': 'silent' },
    });
}
