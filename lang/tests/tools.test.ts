import { describe, expect, it } from 'vitest';
import { extractSubstitutions, parseSearchResults, splitChainedCommands } from '../src/tools.js';

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

    it('extracts command substitutions', () => {
        expect(extractSubstitutions('echo $(git rev-parse HEAD)')).toEqual(['git rev-parse HEAD']);
        expect(extractSubstitutions('echo `cat file.txt`')).toEqual(['cat file.txt']);
        expect(extractSubstitutions('echo "literal $(not_in_single)"')).toEqual(['not_in_single']);
        expect(extractSubstitutions("echo '$(ignored)'")).toEqual([]);
    });
});
