import type { LlmBackend, LlmRequest, LlmResponse } from './llm.js';

export type MockResponder = (req: LlmRequest) => string | Promise<string>;

/** Offline, deterministic backend used for tests and `--backend mock`. */
export class MockBackend implements LlmBackend {
    readonly calls: LlmRequest[] = [];

    constructor(private readonly responder?: MockResponder) {}

    async call(req: LlmRequest): Promise<LlmResponse> {
        this.calls.push(req);
        let text: string;
        if (this.responder) {
            text = await this.responder(req);
        } else {
            const query = req.prompt.split('\n\n').pop() ?? '';
            const short = query.length > 80 ? `${query.slice(0, 80)}...` : query;
            text = req.prompt.includes('valid JSON value') ? JSON.stringify({ response: `mock: ${short}` }) : `mock: ${short}`;
        }
        return {
            text,
            effective: { backend: 'mock', model: req.model ?? 'mock', reasoningEffort: req.reasoningEffort ?? null, ...req.sampling },
        };
    }

    async close(): Promise<void> {}
}
