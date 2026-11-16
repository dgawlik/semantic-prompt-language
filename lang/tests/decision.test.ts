import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiBackend } from '../src/ai.js';
import { PROVIDER_ENV, PROVIDERS } from '../src/auth.js';
import type { DecisionRequest, DecisionResponse, LlmBackend, LlmRequest } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import { Trace } from '../src/trace.js';
import { run } from '../src/workflow.js';
import { cleanTemp, collecting, exec, scripted, silent, tempDir, text, value } from './helpers.js';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    cleanTemp();
});

/** A backend with a decision endpoint: answers decisions in order, and model calls with `replies`. */
function deciding(answers: (DecisionResponse | null)[], ...replies: string[]): LlmBackend & { decisions: DecisionRequest[]; calls: LlmRequest[] } {
    const model = scripted(...replies);
    const decisions: DecisionRequest[] = [];
    return {
        ...model, decisions, calls: model.calls,
        async decide(request) {
            decisions.push(request);
            const answer = answers[decisions.length - 1];
            if (answer === undefined) throw new Error('unexpected decision');
            return answer;
        },
    };
}

describe('decision() simulated with a model call', () => {
    it.each([
        [0.9, 0.85, true],
        [0.85, 0.85, false],
        [0.3, undefined, false],
        [0.6, undefined, true],
    ])('P(yes)=%s with cutoff %s is %s', async (probability, cutoff, expected) => {
        const model = scripted(JSON.stringify({ probability }));
        const options = cutoff === undefined ? '' : `, cutoff: ${cutoff}`;
        const source = `const color = 'crimson';
success(await decision({ evidence: ['The color red is #ff0000'], question: \`Is \${color} a shade of red?\`${options} }));`;
        expect(await value(source, { backend: model })).toBe(expected);
        expect(model.calls).toHaveLength(1);
        expect(model.calls[0]).toMatchObject({ kind: 'ask' });
        expect(model.calls[0].prompt).toContain('Question: Is crimson a shade of red?');
        expect(model.calls[0].prompt).toContain('1. The color red is #ff0000');
        expect(model.calls[0].prompt).toContain('"probability"');
    });

    it('chooses the most probable label and returns what it stands for', async () => {
        const model = scripted(JSON.stringify({ probabilities: { red: 0.2, pink: 0.5, orange: 0.3 } }));
        const source = `success(await decision({ evidence: 'It is #ff8080', question: 'Which color?', labels: { red: true, pink: true, orange: false } }));`;
        expect(await value(source, { backend: model })).toBe(true);
        expect(model.calls[0].prompt).toContain('Labels: "red", "pink", "orange"');
    });

    it('repairs an answer once when it does not satisfy the schema', async () => {
        const model = scripted('{"probability": 7}', '{"probability": 0.1}');
        expect(await value(`success(await decision({ question: 'Is it raining?' }));`, { backend: model })).toBe(false);
        expect(model.calls).toHaveLength(2);
        expect(model.calls[0].prompt).toContain('No evidence was given.');
    });

    it('shows objects in the evidence as JSON and applies enforce/forbid guidance', async () => {
        const model = scripted('{"probability": 1}');
        const source = `success(await enforce('Be strict', () => decision({ evidence: [{ total: 49 }, 3], question: 'Is it paid?' })));`;
        expect(await value(source, { backend: model })).toBe(true);
        expect(model.calls[0].prompt).toContain('1. {"total":49}\n2. 3');
        expect(model.calls[0].prompt).toContain('- Follow: Be strict');
    });

    it('logs the decision', async () => {
        const { logger, events } = collecting();
        const result = await exec(`success(await decision({ question: 'Is it raining?', cutoff: 0.25 }));`, { backend: scripted('{"probability": 0.5}'), logger });
        expect(result).toMatchObject({ status: 'success', value: true });
        expect(events.map(text)).toContain('decision: P(yes)=0.5 > cutoff 0.25 -> true');
    });
});

describe('decision() with a decision endpoint', () => {
    it('uses the endpoint, passing evidence, labels, guidance and the selecting model', async () => {
        const model = deciding([{ label: 'later', probabilities: { now: 0.1, later: 0.9 }, effective: {} }]);
        const source = `---
model: openai/gpt-5.6-sol
---
success(await forbid('Guessing', () => decision({ evidence: ['ticket', { id: 7 }], question: 'When?', labels: { now: true, later: false } })));`;
        expect(await value(source, { backend: model })).toBe(false);
        expect(model.calls).toHaveLength(0);
        expect(model.decisions).toEqual([{
            evidence: ['ticket', '{"id":7}'], question: 'When?\n\nGuidance:\n- Avoid: Guessing', labels: ['now', 'later'], model: 'openai/gpt-5.6-sol',
        }]);
    });

    it('compares the endpoint probability with the cutoff', async () => {
        const model = deciding([{ probability: 0.95, effective: {} }, { probability: 0.95, effective: {} }]);
        expect(await value(`success([await decision({ question: 'A?', cutoff: 0.9 }), await decision({ question: 'B?', cutoff: 0.99 })]);`, { backend: model }))
            .toEqual([true, false]);
        expect(model.decisions.map(request => request.labels)).toEqual([undefined, undefined]);
    });

    it('simulates the decision when the provider has no endpoint', async () => {
        const model = deciding([null], '{"probability": 0.7}');
        expect(await value(`success(await decision({ question: 'Is it raining?', model: 'claude-sonnet-4-5' }));`, { backend: model })).toBe(true);
        expect(model.decisions).toHaveLength(1);
        expect(model.calls).toHaveLength(1);
        expect(model.calls[0].model).toBe('claude-sonnet-4-5');
    });

    it('fails with llm_error on an unknown label or a missing probability', async () => {
        const unknown = await exec(`await decision({ question: 'Q?', labels: { a: true, b: false } });`, { backend: deciding([{ label: 'c', effective: {} }]) });
        expect(unknown).toMatchObject({ status: 'failure', failure: { status_code: 'llm_error', line: 1 } });
        const missing = await exec(`await decision({ question: 'Q?' });`, { backend: deciding([{ effective: {} }]) });
        expect(missing).toMatchObject({ status: 'failure', failure: { status_code: 'llm_error' } });
    });
});

describe('decision() options', () => {
    it.each([
        ['decision()', /requires an object/],
        ["decision('Is it?')", /requires an object/],
        ['decision({})', /requires a question/],
        ["decision({ question: '  ' })", /requires a question/],
        ["decision({ question: 'Q?', evidence: 3 })", /evidence must be a string or a list/],
        ["decision({ question: 'Q?', cutoff: 1.5 })", /cutoff must be a number from 0 to 1/],
        ["decision({ question: 'Q?', cutoff: NaN })", /cutoff must be a number from 0 to 1/],
        ["decision({ question: 'Q?', cutoff: 0.5, labels: { a: true, b: false } })", /either cutoff or labels/],
        ["decision({ question: 'Q?', labels: ['a', 'b'] })", /labels must be an object/],
        ["decision({ question: 'Q?', labels: { a: true } })", /between 2 and 255 labels/],
        ["decision({ question: 'Q?', labels: { a: true, b: 'no' } })", /label 'b' must map to true or false/],
        ["decision({ question: 'Q?', labels: { ' a': true, b: false } })", /must be non-empty, without surrounding spaces/],
        ["decision({ question: 'Q?', labels: { a: true, b: true } })", /one label for true and one for false/],
        ["decision({ question: 'Q?', model: '' })", /model must be a non-empty string/],
        ["decision({ question: 'Q?', schema: Bool })", /unknown decision\(\) option 'schema'/],
    ])('%s fails with runtime_error', async (call, reason) => {
        const result = await exec(`// @ts-nocheck\nawait ${call};`);
        expect(result).toMatchObject({ status: 'failure', failure: { status_code: 'runtime_error', line: 2 } });
        expect(result.status === 'failure' && result.failure.reason).toMatch(reason);
    });
});

describe('decision() in a trace', () => {
    it('records endpoint decisions and replays them without calling the provider', async () => {
        const cwd = tempDir('spl-decision-');
        const file = path.join(cwd, 'run.jsonl');
        const source = `success([await decision({ question: 'A?' }), await decision({ question: 'B?', model: 'claude-sonnet-4-5' })]);`;
        const traced = async (backend: LlmBackend) => {
            const trace = Trace.open(file, { source, runtime: 'test-runtime', cwd });
            try {
                const result = await run(source, { backend, logger: silent, cwd, trace });
                trace.finish(result);
                return result;
            } finally { trace.close(); }
        };
        const live = deciding([{ probability: 0.8, effective: {} }, null], '{"probability": 0.1}');
        expect(await traced(live)).toMatchObject({ status: 'success', value: [true, false] });
        const kinds = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
            .filter(row => row.type === 'intent').map(row => JSON.parse(row.request).kind);
        expect(kinds).toEqual(['decision', 'decision', 'llm']);
        const replay = deciding([]);
        expect(await traced(replay)).toMatchObject({ status: 'success', value: [true, false] });
        expect(replay.decisions).toHaveLength(0);
        expect(replay.calls).toHaveLength(0);
    });
});

describe('AiBackend.decide', () => {
    let home: string;
    let backend: AiBackend;
    beforeEach(() => {
        home = fs.mkdtempSync(path.join(tempDir('spl-decide-'), 'home-'));
        vi.stubEnv('SPL_HOME', home);
        for (const provider of PROVIDERS) vi.stubEnv(PROVIDER_ENV[provider][0], `test-${provider}`);
        backend = new AiBackend({ cwd: home, timeoutMs: 2000, logger: new Logger('silent') });
    });
    afterEach(() => backend.close());

    const capture = (reply: unknown) => {
        const requests: { url: string; headers: Headers; body: any }[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            const request = url instanceof Request ? url : new Request(url, init);
            requests.push({ url: request.url, headers: request.headers, body: JSON.parse(await request.text()) });
            return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
        }));
        return requests;
    };

    it('calls the OpenAI decisions endpoint with gpt-6-luna, whatever the selecting model', async () => {
        const requests = capture({ model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'decision', probability: 0.75 }], usage: {} });
        const result = await backend.decide({ evidence: ['a', 'b'], question: 'Q?', model: 'gpt-5.6-sol' });
        expect(result).toEqual({ probability: 0.75, effective: { backend: 'native-sdk', provider: 'openai', model: 'gpt-6-luna', endpoint: 'decisions' } });
        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe('https://api.openai.com/v1/decisions');
        expect(requests[0].headers.get('authorization')).toBe('Bearer test-openai');
        expect(requests[0].body).toEqual({
            model: 'gpt-6-luna',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'a' }, { type: 'input_text', text: 'b' }] }],
            questions: [{ type: 'predicate', name: 'decision', instructions: 'Q?' }],
        });
    });

    it('asks OpenAI a choice question for labels, and fails on a refusal', async () => {
        const requests = capture({ model: 'gpt-6-luna', usage: {}, answers: [{
            type: 'choice', name: 'decision', choice: 'no', confidence: 0.6,
            probabilities: [{ value: 'yes', probability: 0.4 }, { value: 'no', probability: 0.6 }],
        }] });
        expect(await backend.decide({ evidence: [], question: 'Q?', labels: ['yes', 'no'], model: 'openai/gpt-6-luna' }))
            .toMatchObject({ label: 'no', probabilities: { yes: 0.4, no: 0.6 } });
        expect(requests[0].body).toMatchObject({
            input: 'No evidence was given.',
            questions: [{ type: 'choice', name: 'decision', instructions: 'Q?', choices: [{ value: 'yes' }, { value: 'no' }] }],
        });
        capture({ model: 'gpt-6-luna', usage: {}, answers: [{ type: 'refusal', name: 'decision' }] });
        await expect(backend.decide({ evidence: [], question: 'Q?', model: 'gpt-6-luna' })).rejects.toThrow(/refused/);
    });

    it('calls the Gemini decisions endpoint with gemini-decision-1', async () => {
        const requests = capture({ answers: { decision: { type: 'noul', noul: 0.99, confidence: 0.99 } } });
        expect(await backend.decide({ evidence: ['cracked mug'], question: 'Damaged?', model: 'gemini-2.5-flash' }))
            .toEqual({ probability: 0.99, effective: { backend: 'native-sdk', provider: 'google', model: 'gemini-decision-1', endpoint: 'decisions' } });
        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/decisions');
        expect(requests[0].headers.get('x-goog-api-key')).toBe('test-google');
        expect(requests[0].body).toEqual({
            model: 'gemini-decision-1',
            input: [{ type: 'text', text: 'cracked mug' }],
            questions: { decision: { type: 'noul', instructions: 'Damaged?' } },
        });
        const choice = capture({ answers: { decision: { type: 'choice', choice: 'b', confidence: 0.7, probabilities: { a: 0.3, b: 0.7 } } } });
        expect(await backend.decide({ evidence: [], question: 'Which?', labels: ['a', 'b'], model: 'google/gemini-3-flash' }))
            .toMatchObject({ label: 'b', probabilities: { a: 0.3, b: 0.7 } });
        expect(choice[0].body.questions).toEqual({ decision: { type: 'choice', instructions: 'Which?', criteria: { a: 'a', b: 'b' } } });
    });

    it('has no endpoint for Anthropic, so the runtime simulates one', async () => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        expect(await backend.decide({ evidence: [], question: 'Q?', model: 'claude-sonnet-4-5' })).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('surfaces endpoint errors without retrying', async () => {
        const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad', code: 400, status: 'INVALID_ARGUMENT' } }),
            { status: 400, headers: { 'content-type': 'application/json' } }));
        vi.stubGlobal('fetch', fetch);
        await expect(backend.decide({ evidence: [], question: 'Q?', model: 'gemini-2.5-flash' })).rejects.toThrow();
        expect(fetch).toHaveBeenCalledOnce();
    });
});
