import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Restrictions, makeRestriction } from '../src/restrict.js';
import { ToolHost, extractSubstitutions, parseSearchResults, splitChainedCommands } from '../src/tools.js';

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

describe('web_search result parsing', () => {
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
            await expect(host.invoke('read_file', { path: '/s' })).rejects.toMatchObject({
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
