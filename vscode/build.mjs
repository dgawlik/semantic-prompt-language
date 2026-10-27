import { build } from 'esbuild';
import { chmod, copyFile } from 'node:fs/promises';

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
    target: 'node18',
    external: ['vscode', '@github/copilot-sdk'],
    sourcemap: true,
    logLevel: 'info',
});

await copyFile('node_modules/vscode-languageclient/lib/node/terminateProcess.sh', 'out/terminateProcess.sh');
await chmod('out/terminateProcess.sh', 0o755);

if (process.argv.includes('--test')) {
    await build({
        entryPoints: ['test/notebook-ui.test.ts'],
        outdir: 'out/test',
        outExtension: { '.js': '.cjs' },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        alias: { vscode: './test/vscodeMock.ts' },
        logLevel: 'info',
    });
}
