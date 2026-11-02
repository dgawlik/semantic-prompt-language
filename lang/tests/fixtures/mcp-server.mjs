import { createInterface } from 'node:readline';

export function reply(request) {
    if (request.id === undefined) return undefined;
    const response = { jsonrpc: '2.0', id: request.id };
    if (request.method === 'initialize') return { ...response, result: {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'spl-test', version: '1' },
    } };
    if (request.method === 'tools/list') return { ...response, result: { tools: [{
        name: 'echo', description: 'Echo a message',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    }] } };
    if (request.method === 'tools/call') return { ...response, result: {
        content: [{ type: 'text', text: request.params.arguments.message }],
    } };
    return { ...response, error: { code: -32601, message: 'Method not found' } };
}

if (process.argv[2] === 'stdio') {
    for await (const line of createInterface({ input: process.stdin })) {
        const response = reply(JSON.parse(line));
        if (response) process.stdout.write(JSON.stringify(response) + '\n');
    }
}
