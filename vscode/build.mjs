import { build } from 'esbuild';
import { chmod, copyFile, cp } from 'node:fs/promises';

await build({
    entryPoints: {
        extension: 'src/extension.ts',
        server: 'src/server.ts',
        notebookWorker: 'src/notebookWorker.ts',
        ...(process.argv.includes('--test') ? {
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
});

await copyFile('node_modules/vscode-languageclient/lib/node/terminateProcess.sh', 'out/terminateProcess.sh');
await chmod('out/terminateProcess.sh', 0o755);
await cp('../lang/src/stdlib', 'out/stdlib', { recursive: true });

if (process.argv.includes('--test')) {
    await cp('../lang/src/stdlib', 'out/test/stdlib', { recursive: true });
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
    });
}
