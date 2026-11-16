import { AiBackend } from '../src/ai.js';
import { resolveProvider } from '../src/auth.js';
import type { LlmBackend, LlmRequest, LlmResponse } from '../src/llm.js';
import { Logger } from '../src/logger.js';

/** Real provider backend that also records every request, so tests can assert on the assembled prompts. */
export class RecordingBackend implements LlmBackend {
    readonly calls: LlmRequest[] = [];
    private readonly inner: AiBackend;

    constructor(cwd: string) {
        this.inner = new AiBackend({ logger: new Logger('silent'), cwd, timeoutMs: 120_000 });
    }

    call(req: LlmRequest): Promise<LlmResponse> {
        this.calls.push(req);
        return this.inner.call(req);
    }

    close(): Promise<void> {
        return this.inner.close();
    }
}

/** Live tests require explicit opt-in as well as authentication. */
export const live: boolean = process.env.SPL_LIVE_TESTS === '1';
if (live) resolveProvider();

export const LIVE_TIMEOUT = 180_000;
