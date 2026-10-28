import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Checkpoint, CheckpointError, type CheckpointContext } from '../src/checkpoint.js';
import { run, type RunResult } from '../src/interpreter.js';
import { LlmError, type LlmBackend } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import { parse, usesHuman } from '../src/parser.js';
import { ToolHost } from '../src/tools.js';

vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>() }));

let dir: string;
let file: string;
const unusedBackend: LlmBackend = {
    async call() { throw new Error('unexpected live model call'); },
    async close() {},
};
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-checkpoint-'));
    file = path.join(dir, 'run.jsonl');
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
});

const context = (source: string): CheckpointContext => ({ source, runtime: 'test-runtime', cwd: dir });
function waiting(result: RunResult) {
    if (result.status !== 'waiting_for_input') throw new Error(`expected waiting, got ${JSON.stringify(result)}`);
    return result.request;
}
async function execute(source: string, checkpoint: Checkpoint, backend = unusedBackend, logger = new Logger('silent')) {
    try {
        const result = await run(parse(source), { backend, logger, cwd: dir, checkpoint });
        if (result.status !== 'waiting_for_input') checkpoint.finish(result.status);
        return result;
    } finally {
        checkpoint.close();
    }
}
async function resume(source: string, answer: string, backend = unusedBackend, logger = new Logger('silent')) {
    const checkpoint = Checkpoint.resume(file, context(source));
    checkpoint.answer(checkpoint.request!.request_id, answer);
    return execute(source, checkpoint, backend, logger);
}

describe('human syntax and suspension', () => {
    it('parses questions, rejects modifiers/reserved bindings, and preflights unused human expressions', async () => {
        expect(usesHuman(parse(`success 'human'`))).toBe(false);
        expect(usesHuman(parse(`def later():
    return human ('one' + 'two')`))).toBe(true);
        expect(() => parse(`human(fmt='text') 'question'`)).toThrow(/does not accept modifiers/);
        expect(() => parse(`let human = 1`)).toThrow(/reserved/);
        expect(() => parse(`human`)).toThrow(/requires a prompt/);
        const result = await run(parse(`write_file('should-not-exist', 'x')
def later():
    return human 'question'`), {
            cwd: dir, backend: unusedBackend, logger: new Logger('silent'),
        });
        expect(result).toMatchObject({ status: 'failure', failure: { reason: expect.stringContaining('requires a checkpoint') } });
        expect(fs.existsSync(path.join(dir, 'should-not-exist'))).toBe(false);
    });

    it('reconstructs functions, loops, aliases and expression evaluation across multiple pauses', async () => {
        const source = `
let answers = []
let alias = answers
def collect(i):
    restrict '.':
        try:
            alias.append(human 'Question {i}')
        except err:
            fail 'suspension must not be caught'
for i in range(2):
    collect(i)
let skipped = False and human 'unreachable'
success [answers, alias == answers, skipped]`;
        const first = waiting(await execute(source, Checkpoint.create(file, context(source))));
        expect(first).toMatchObject({ question: 'Question 0', checkpoint: file });
        const second = waiting(await resume(source, ''));
        expect(second.question).toBe('Question 1');
        expect(second.request_id).not.toBe(first.request_id);
        expect(second.run_id).toBe(first.run_id);
        const answer = '  quoted "answer"\nsecond line\n';
        expect(await resume(source, answer)).toMatchObject({ status: 'success', value: [['', answer], true, false] });
        expect(() => Checkpoint.resume(file, context(source))).toThrow(/terminal/);
    });

    it('requires a string question without calling a backend', async () => {
        const source = `success human 42`;
        expect(await execute(source, Checkpoint.create(file, context(source)))).toMatchObject({
            status: 'failure', failure: { reason: 'human question must be a string' },
        });
    });

    it('suppresses historical logs but emits suffix logs exactly once', async () => {
        const source = `log('before')\nlet answer = human 'question'\nlog(level=debug)('after')\nsuccess answer`;
        const lines: string[] = [];
        const logger = new Logger('debug', (line) => lines.push(line));
        await execute(source, Checkpoint.create(file, context(source)), unusedBackend, logger);
        await resume(source, 'done', unusedBackend, logger);
        expect(lines.filter((line) => line === '[info] log: before')).toHaveLength(1);
        expect(lines.filter((line) => line === '[debug] log: after')).toHaveLength(1);
    });
});

describe('journaled effects', () => {
    it('executes all raw tools, repair attempts and agent actions only once across resumes', async () => {
        const tools = vi.spyOn(ToolHost.prototype, 'invoke').mockResolvedValue('raw result');
        const call = vi.fn<LlmBackend['call']>()
            .mockResolvedValueOnce({ text: '"wrong type"', effective: {} })
            .mockResolvedValueOnce({ text: '42', effective: {} })
            .mockResolvedValueOnce({ text: 'agent result', effective: {} });
        const backend = { call, async close() {} };
        const source = `
let content = read_file('input.txt')
write_file('output.txt', content)
shell('command')
web_fetch('https://example.com')
web_search('query')
let number = ask(fmt='integer', repairs=1) 'number'
let report = agent 'do something'
let a = human 'first'
let b = human 'second'
success [content, number, report, a, b]`;
        await execute(source, Checkpoint.create(file, context(source)), backend);
        await resume(source, 'A', backend);
        expect(await resume(source, 'B', backend)).toMatchObject({
            status: 'success', value: ['raw result', 42, 'agent result', 'A', 'B'],
        });
        expect(tools).toHaveBeenCalledTimes(5);
        expect(call).toHaveBeenCalledTimes(3);
        expect(call.mock.calls.map(([request]) => request.kind)).toEqual(['ask', 'ask', 'agent']);
    });

    it('uses old reads and preserves writes without restoring files; new reads remain live', async () => {
        const input = path.join(dir, 'input.txt');
        fs.writeFileSync(input, 'original');
        const source = `
let old = read_file('input.txt')
write_file('output.txt', old)
let answer = human 'continue'
let current = read_file('input.txt')
success [old, current, answer]`;
        await execute(source, Checkpoint.create(file, context(source)));
        fs.writeFileSync(input, 'changed');
        fs.writeFileSync(path.join(dir, 'output.txt'), 'preserved external edit');
        expect(await resume(source, 'yes')).toMatchObject({ status: 'success', value: ['original', 'changed', 'yes'] });
        expect(fs.readFileSync(path.join(dir, 'output.txt'), 'utf8')).toBe('preserved external edit');
    });

    it('replays caught tool and transport failures without another call', async () => {
        const call = vi.fn<LlmBackend['call']>().mockRejectedValue(new LlmError('offline'));
        const backend = { call, async close() {} };
        const source = `
let reasons = []
try:
    read_file('missing')
except err:
    reasons.append(err.status_code)
try:
    ask 'will fail'
except err:
    reasons.append(err.reason)
let answer = human 'continue'
success reasons`;
        await execute(source, Checkpoint.create(file, context(source)), backend);
        fs.writeFileSync(path.join(dir, 'missing'), 'now exists');
        expect(await resume(source, 'yes', backend)).toMatchObject({ status: 'success', value: ['tool_error', 'offline'] });
        expect(call).toHaveBeenCalledTimes(1);
    });

    it('fails closed on a mismatched effect instead of reaching live execution or except', async () => {
        const source = `try:
    read_file('x')
except err:
    pass
human 'question'`;
        await execute(source, Checkpoint.create(file, context(source)));
        const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
        const event = JSON.parse(lines[1]);
        event.request = 'different request';
        lines[1] = JSON.stringify(event);
        fs.writeFileSync(file, lines.join('\n') + '\n');
        const tools = vi.spyOn(ToolHost.prototype, 'invoke');
        await expect(resume(source, 'yes')).rejects.toThrow(/history mismatch/);
        expect(tools).not.toHaveBeenCalled();
    });
});

describe('checkpoint integrity and binding', () => {
    const source = `success human 'question'`;

    it('exclusively creates files, locks writers, and binds exact pending IDs without consuming invalid answers', async () => {
        const first = waiting(await execute(source, Checkpoint.create(file, context(source))));
        expect(() => Checkpoint.create(file, context(source))).toThrow(/cannot create/);
        const checkpoint = Checkpoint.resume(file, context(source));
        try {
            expect(checkpoint.request).toEqual(first);
            expect(() => Checkpoint.resume(file, context(source))).toThrow(/cannot lock/);
            const before = fs.readFileSync(file, 'utf8');
            expect(() => checkpoint.answer('stale-id', 'answer')).toThrow(/pending request ID/);
            expect(fs.readFileSync(file, 'utf8')).toBe(before);
            checkpoint.answer(first.request_id, 'answer');
            expect(() => checkpoint.answer(first.request_id, 'answer')).toThrow(/pending request ID/);
            expect(await execute(source, checkpoint)).toMatchObject({ status: 'success', value: 'answer' });
        } finally {
            checkpoint.close();
        }
    });

    it('pins script, runtime, cwd, configuration and arguments before executing', async () => {
        const original = { ...context(source), args: ['initial'], configuration: { model: 'one' } };
        await execute(source, Checkpoint.create(file, original));
        for (const patch of [
            { source: source + '\n' }, { runtime: 'other' }, { cwd: os.tmpdir() },
            { args: ['other'] }, { configuration: { model: 'other' } },
        ]) {
            expect(() => Checkpoint.resume(file, { ...original, ...patch })).toThrow(/mismatch/);
            expect(fs.existsSync(`${file}.lock`)).toBe(false);
        }
        const checkpoint = Checkpoint.resume(file, { ...original, args: undefined });
        expect(checkpoint.args).toEqual(['initial']);
        checkpoint.close();
    });

    it('restores arguments and preserves readonly aliases across replay', async () => {
        const script = `let args = $args\nlet first = args[0]\nlet a = human 'question'\nsuccess [first, args, a]`;
        await execute(script, Checkpoint.create(file, { ...context(script), args: ['saved'] }));
        expect(await resume(script, 'answer')).toMatchObject({ status: 'success', value: ['saved', ['saved'], 'answer'] });
    });

    it('fingerprints observed environments without persisting plaintext secrets', async () => {
        vi.stubEnv('SPL_CHECKPOINT_SECRET', 'private-test-value');
        const script = `let env = $env\nlet a = human 'question'\nsuccess env.SPL_CHECKPOINT_SECRET`;
        await execute(script, Checkpoint.create(file, context(script)));
        expect(fs.readFileSync(file, 'utf8')).not.toContain('private-test-value');
        vi.stubEnv('SPL_CHECKPOINT_SECRET', 'changed');
        expect(() => Checkpoint.resume(file, context(script))).toThrow(/environment mismatch/);
        vi.stubEnv('SPL_CHECKPOINT_SECRET', 'private-test-value');
        expect(await resume(script, 'yes')).toMatchObject({ status: 'success', value: 'private-test-value' });
    });

    it('rejects truncated and interrupted histories and never repeats uncertain effects', async () => {
        const checkpoint = Checkpoint.create(file, context(source));
        let count = 0;
        await expect(checkpoint.effect('external', async () => {
            count++;
            throw new Error('crash after action');
        }, (value): value is string => typeof value === 'string')).rejects.toThrow(/crash/);
        checkpoint.close();
        expect(() => Checkpoint.resume(file, context(source))).toThrow(/unresolved effect/);
        expect(count).toBe(1);
        fs.appendFileSync(file, '{');
        expect(() => Checkpoint.resume(file, context(source))).toThrow(/truncated/);
    });

    it('does not run an effect if its intent cannot be durably saved', async () => {
        const checkpoint = Checkpoint.create(file, context(source));
        const perform = vi.fn(async () => 'done');
        vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('disk unavailable'); });
        await expect(checkpoint.effect('action', perform, (value): value is string => typeof value === 'string'))
            .rejects.toMatchObject({ kind: 'infrastructure', message: expect.stringContaining('durably save') });
        expect(perform).not.toHaveBeenCalled();
        checkpoint.close();
    });

    it('does not return a completed effect or a pending request when outcome/pending writes fail', async () => {
        const checkpoint = Checkpoint.create(file, context(source));
        const sync = fs.fsyncSync;
        vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(sync).mockImplementationOnce(() => { throw new Error('disk full'); });
        const perform = vi.fn(async () => 'completed externally');
        await expect(checkpoint.effect('action', perform, (value): value is string => typeof value === 'string'))
            .rejects.toBeInstanceOf(CheckpointError);
        expect(perform).toHaveBeenCalledTimes(1);
        expect(() => checkpoint.human('question', 1)).toThrow(/unusable/);
        checkpoint.close();
    });

    it('rejects terminal and unsealed sessions rather than silently restarting', () => {
        const checkpoint = Checkpoint.create(file, context(source));
        checkpoint.close();
        expect(() => Checkpoint.resume(file, context(source))).toThrow(/interrupted/);
    });

    it.each(['question', 'answer', 'terminal'])('surfaces failed %s persistence without a success/suspension result', async (phase) => {
        let checkpoint = Checkpoint.create(file, context(source));
        if (phase === 'answer') {
            await execute(source, checkpoint);
            checkpoint = Checkpoint.resume(file, context(source));
        }
        vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('durability failed'); });
        try {
            const action = phase === 'question' ? () => checkpoint.human('question', 1)
                : phase === 'answer' ? () => checkpoint.answer(checkpoint.request!.request_id, 'answer')
                : () => checkpoint.finish('success');
            expect(action).toThrow(/durably save/);
            await expect(checkpoint.effect('must not execute', async () => 'bad', (value): value is string => typeof value === 'string'))
                .rejects.toThrow(/unusable/);
        } finally {
            checkpoint.close();
        }
    });
});
