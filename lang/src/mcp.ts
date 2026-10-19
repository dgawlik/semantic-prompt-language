import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MCPServerConfig } from '@github/copilot-sdk';
import type { Restrictions } from './restrict.js';

export type McpServers = Record<string, MCPServerConfig>;

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Loads the supported VS Code mcp.json subset; never executes commands or connects to servers. */
export function loadMcpConfig(file: string, cwd: string): McpServers {
    const fail = (message: string): never => { throw new Error(`MCP config '${file}': ${message}`); };
    let config: unknown;
    try {
        config = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return fail(`cannot read JSON: ${(e as Error).message}`);
    }
    if (!object(config) || !object(config.servers)) return fail("expected an object with a 'servers' object");
    if (config.inputs !== undefined) return fail("'inputs' are not supported; use environment variables instead");
    const expand = (value: string): string => value.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
        if (key === 'workspaceFolder') return cwd;
        if (key.startsWith('env:')) {
            const name = key.slice(4);
            const value = process.env[name];
            if (value !== undefined) return value;
            return fail(`environment variable '${name}' is not set`);
        }
        return fail(`unsupported variable '\${${key}}'`);
    });
    const strings = (value: unknown, field: string): Record<string, string> | undefined => {
        if (value === undefined) return undefined;
        if (!object(value)) return fail(`${field} must be an object of strings`);
        const entries = Object.entries(value).map(([key, val]): [string, string] => {
            if (typeof val !== 'string') return fail(`${field}.${key} must be a string`);
            return [key, expand(val)];
        });
        return Object.fromEntries(entries);
    };
    const servers: McpServers = Object.create(null);
    for (const [name, raw] of Object.entries(config.servers)) {
        if (!/^[A-Za-z0-9_.-]+$/.test(name)) return fail(`invalid server name '${name}'`);
        if (!object(raw)) return fail(`server '${name}' must be an object`);
        const type = raw.type ?? 'stdio';
        const local = type === 'stdio';
        if (!local && type !== 'http' && type !== 'sse') return fail(`server '${name}' has unsupported type '${String(type)}'`);
        const fields = local ? ['type', 'command', 'args', 'env', 'cwd', 'tools', 'timeout'] : ['type', 'url', 'headers', 'tools', 'timeout'];
        for (const field of Object.keys(raw)) {
            if (!fields.includes(field)) return fail(`server '${name}' has unsupported field '${field}'`);
        }
        if (raw.tools !== undefined && (!Array.isArray(raw.tools) || raw.tools.some((t) => typeof t !== 'string' || !/^(?:\*|[A-Za-z0-9_.-]+)$/.test(t)))) {
            return fail(`server '${name}': tools must be an array of tool names or '*'`);
        }
        if (raw.timeout !== undefined && (typeof raw.timeout !== 'number' || !Number.isFinite(raw.timeout) || raw.timeout <= 0)) {
            return fail(`server '${name}': timeout must be a positive number of milliseconds`);
        }
        const common = { tools: raw.tools as string[] | undefined, timeout: raw.timeout as number | undefined };
        if (local) {
            if (typeof raw.command !== 'string' || raw.command.trim() === '') return fail(`server '${name}': command must be a non-empty string`);
            if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((v) => typeof v !== 'string'))) {
                return fail(`server '${name}': args must be an array of strings`);
            }
            if (raw.cwd !== undefined && typeof raw.cwd !== 'string') return fail(`server '${name}': cwd must be a string`);
            servers[name] = {
                ...common, type: 'stdio', command: expand(raw.command),
                args: (raw.args as string[] | undefined)?.map(expand),
                env: strings(raw.env, `${name}.env`),
                workingDirectory: raw.cwd === undefined ? cwd : path.resolve(cwd, expand(raw.cwd)),
            };
        } else {
            if (typeof raw.url !== 'string') return fail(`server '${name}': url must be a string`);
            const url = expand(raw.url);
            let parsed: URL;
            try { parsed = new URL(url); } catch { return fail(`server '${name}': invalid URL`); }
            if (!['http:', 'https:'].includes(parsed.protocol)) return fail(`server '${name}': URL must use http or https`);
            servers[name] = { ...common, type, url, headers: strings(raw.headers, `${name}.headers`) };
        }
    }
    return servers;
}

export function filterMcpServers(servers: McpServers, restrictions: Restrictions): McpServers {
    return Object.fromEntries(Object.entries(servers).flatMap(([name, config]) => {
        const tools = restrictions.mcpTools(name, config.tools);
        return tools.length ? [[name, { ...config, tools }]] : [];
    }));
}

export function configuredMcpTool(servers: McpServers, server: string, tool: string): boolean {
    if (!Object.hasOwn(servers, server)) return false;
    const tools = servers[server].tools;
    return tools === undefined || tools.includes('*') || tools.includes(tool);
}
