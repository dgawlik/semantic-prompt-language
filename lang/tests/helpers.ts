import type { LlmBackend, LlmResponse } from '../src/llm.js';

/** Backend for tests that must not reach an LLM: any call is a test failure. */
export class NoLlm implements LlmBackend {
    async call(): Promise<LlmResponse> {
        throw new Error('unexpected LLM call');
    }
    async close(): Promise<void> {}
}
