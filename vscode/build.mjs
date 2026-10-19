import { build } from 'esbuild';
import { chmod, copyFile } from 'node:fs/promises';

await build({
    entryPoints: {
        extension: 'src/extension.ts',
        server: 'src/server.ts',
        ...(process.argv.includes('--test') ? { 'test/language-server.test': 'test/language-server.test.ts' } : {}),
    },
    outdir: 'out',
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    sourcemap: true,
    logLevel: 'info',
});

await copyFile('node_modules/vscode-languageclient/lib/node/terminateProcess.sh', 'out/terminateProcess.sh');
await chmod('out/terminateProcess.sh', 0o755);
