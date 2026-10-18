import { authStatus } from '../src/auth.js';
import { CopilotBackend } from '../src/copilot.js';
import type { LlmBackend, LlmRequest, LlmResponse } from '../src/llm.js';
import { Logger } from '../src/logger.js';

/** Real GitHub Copilot backend that also records every request, so tests can assert on the assembled prompts. */
export class RecordingCopilot implements LlmBackend {
    readonly calls: LlmRequest[] = [];
    private readonly inner: CopilotBackend;

    constructor(cwd: string) {
        this.inner = new CopilotBackend({ logger: new Logger('silent'), cwd, timeoutMs: 120_000 });
    }

    call(req: LlmRequest): Promise<LlmResponse> {
        this.calls.push(req);
        return this.inner.call(req);
    }

    close(): Promise<void> {
        return this.inner.close();
    }
}

/** True when the Copilot runtime is authenticated (run `spl login` once); live tests are skipped otherwise. */
export const live: boolean = await authStatus()
    .then((s) => s.isAuthenticated)
    .catch(() => false);

export const LIVE_TIMEOUT = 180_000;
