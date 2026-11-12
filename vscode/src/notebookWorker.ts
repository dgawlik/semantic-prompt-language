import { ExecutionSession } from '../../lang/src/workflow.js';
import { Logger } from '../../lang/src/logger.js';
import { SplSyntaxError } from '../../lang/src/errors.js';
import { describeValue } from '../../lang/src/runtime.js';
import type { LlmBackend } from '../../lang/src/llm.js';
import { parseWorkflowCell } from './notebookFormat';
import type { ExecuteCell, WorkerReply } from './notebookProtocol';

const session = new ExecutionSession();
let active: ExecuteCell | undefined;
let backend: LlmBackend | undefined;
const send = (reply: WorkerReply) => process.send?.(reply);
const logger = new Logger('info', text => {
    if (active) send({ id: active.id, kind: 'log', text, output: /^\[(?:info|error|debug)\] log:/.test(text) });
}, {
    streamSink: event => {
        if (active) send({ id: active.id, kind: 'stream', event });
    },
});
const lazyBackend: LlmBackend = {
    async call(request) {
        if (!backend) {
            const { AiBackend } = await import('../../lang/src/ai.js');
            backend = new AiBackend({ logger, cwd: process.cwd(), timeoutMs: 300_000 });
        }
        return backend.call(request);
    },
    async close() { await backend?.close(); },
};

export function formatNotebookValue(value: unknown): string {
    if (typeof value === 'string') return value;
    return JSON.stringify(describeValue(value), null, 2);
}

process.on('message', async (request: ExecuteCell) => {
    if (active) {
        send({ id: request.id, kind: 'error', message: 'another cell is already running', line: 1, column: 1, source: request.source });
        return;
    }
    active = request;
    try {
        const workflow = parseWorkflowCell(request.value, request.language, request.frontmatter);
        const result = await session.run(workflow, {
            logger, backend: lazyBackend, source: request.source, sourceVersion: request.version,
        });
        if (result.status === 'failure') {
            send({
                id: request.id, kind: 'error', message: `${result.failure.status_code}: ${result.failure.reason}`,
                line: result.failure.line, column: 1, source: result.failure.source ?? request.source,
                version: result.failure.source_version ?? request.version,
            });
        } else {
            send({ id: request.id, kind: 'result', ...(result.hasValue ? { text: formatNotebookValue(result.value) } : {}) });
        }
    } catch (error) {
        send({
            id: request.id, kind: 'error', message: error instanceof Error ? error.message : String(error),
            line: error instanceof SplSyntaxError ? error.line : 1,
            column: error instanceof SplSyntaxError ? error.col : 1, source: request.source,
            version: request.version,
        });
    } finally {
        active = undefined;
    }
});

process.on('disconnect', () => {
    void lazyBackend.close().finally(() => process.exit());
});
