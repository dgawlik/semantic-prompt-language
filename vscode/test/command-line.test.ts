import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandLine } from '../src/commandLine';

test('Run and Debug build the spl command line with the path quoted for the shell', () => {
    assert.equal(commandLine('spl', 'C:\\My Flows\\hi.spl', false, 'win32'), 'spl run "C:\\My Flows\\hi.spl"');
    assert.equal(commandLine('spl', 'C:\\My Flows\\hi.spl', true, 'win32'), 'spl run "C:\\My Flows\\hi.spl" --debug');
    assert.equal(commandLine('npx spl', '/home/me/my flows/hi.spl', false, 'linux'), "npx spl run '/home/me/my flows/hi.spl'");
    assert.equal(commandLine('  ', "/srv/it's $HOME.spl", true, 'darwin'), "spl run '/srv/it'\\''s $HOME.spl' --debug");
    assert.equal(commandLine('spl', 'C:\\My Flows\\suite.eval.spl', false, 'win32'), 'spl eval "C:\\My Flows\\suite.eval.spl"');
});
