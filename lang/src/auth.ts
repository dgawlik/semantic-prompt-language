import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export const PROVIDERS = ['openai', 'anthropic', 'google'] as const;
export type Provider = typeof PROVIDERS[number];

export const PROVIDER_ENV: Record<Provider, readonly string[]> = {
    openai: ['OPENAI_API_KEY'],
    anthropic: ['ANTHROPIC_API_KEY'],
    google: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'],
};

export const DEFAULT_MODELS: Record<Provider, string> = {
    openai: 'gpt-4.1',
    anthropic: 'claude-sonnet-4-5',
    google: 'gemini-2.5-flash',
};

export class AuthError extends Error {}

export function parseProvider(value: string): Provider {
    if (value === 'openai' || value === 'anthropic' || value === 'google') return value;
    throw new AuthError(`unknown provider '${value}'; expected ${PROVIDERS.join(', ')}`);
}

export function credentialsPath(): string {
    return path.join(process.env.SPL_HOME ?? path.join(os.homedir(), '.spl'), 'credentials.json');
}

interface Credentials {
    provider?: Provider;
    keys: Partial<Record<Provider, string>>;
}

const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

function readCredentials(): Credentials {
    let source: string;
    try {
        source = fs.readFileSync(credentialsPath(), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { keys: {} };
        throw new AuthError(`cannot read saved credentials: ${(error as Error).message}`);
    }
    let data: unknown;
    try { data = JSON.parse(source); }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new AuthError('cannot read saved credentials: invalid JSON; run spl logout to remove them');
    }
    if (!object(data)) throw new AuthError('invalid saved credentials; run spl logout to remove them');
    // Old GitHub tokens are deliberately not reused as provider API keys.
    if (data.token !== undefined && data.keys === undefined) return { keys: {} };
    if (!object(data.keys)) throw new AuthError('invalid saved credentials; run spl logout to remove them');
    const keys: Credentials['keys'] = {};
    for (const provider of PROVIDERS) {
        const key = data.keys[provider];
        if (key !== undefined) {
            if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) {
                throw new AuthError(`invalid saved ${provider} credentials; run spl logout ${provider}`);
            }
            keys[provider] = key;
        }
    }
    if (data.provider !== undefined && typeof data.provider !== 'string') throw new AuthError('invalid saved default provider');
    return { keys, provider: data.provider === undefined ? undefined : parseProvider(data.provider) };
}

function saveCredentials(credentials: Credentials): void {
    const file = credentialsPath();
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(temporary, JSON.stringify(credentials), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
    } catch (error) {
        try { fs.rmSync(temporary, { force: true }); }
        catch (cleanup) {
            throw new AuthError(`cannot save credentials: ${(error as Error).message}; cannot remove temporary credentials file: ${(cleanup as Error).message}`);
        }
        throw new AuthError(`cannot save credentials: ${(error as Error).message}`);
    }
}

function environmentKey(provider: Provider): { key: string; source: string } | undefined {
    for (const name of PROVIDER_ENV[provider]) {
        const key = process.env[name]?.trim();
        if (!key) continue;
        if (/[\r\n]/.test(key)) throw new AuthError(`${name} must be a single-line API key`);
        return { key, source: name };
    }
    return undefined;
}

export function resolveProvider(model?: string, explicit?: Provider): { provider: Provider; model: string; apiKey: string } {
    const credentials = readCredentials();
    let modelProvider: Provider | undefined;
    if (model !== undefined) {
        if (!model.trim()) throw new AuthError('model must not be empty');
        const slash = model.indexOf('/');
        if (slash !== -1) {
            modelProvider = parseProvider(model.slice(0, slash));
            model = model.slice(slash + 1);
            if (!model.trim()) throw new AuthError('model must not be empty');
        } else if (model.startsWith('claude-')) modelProvider = 'anthropic';
        else if (model.startsWith('gemini-')) modelProvider = 'google';
        else if (/^(?:gpt-|chatgpt-|o[134](?:-|$))/.test(model)) modelProvider = 'openai';
    }
    if (explicit && modelProvider && explicit !== modelProvider) {
        throw new AuthError(`model belongs to ${modelProvider}, not the selected provider ${explicit}`);
    }
    let provider = explicit ?? modelProvider
        ?? (process.env.SPL_PROVIDER ? parseProvider(process.env.SPL_PROVIDER) : undefined)
        ?? credentials.provider;
    if (!provider) {
        const configured = PROVIDERS.filter(name => environmentKey(name) || credentials.keys[name]);
        if (configured.length > 1) throw new AuthError('multiple providers configured; use --provider, a provider/model ID, SPL_PROVIDER, or spl login <provider>');
        provider = configured[0];
    }
    if (!provider) throw new AuthError('no provider configured; set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY, or run spl login <provider>');
    const apiKey = environmentKey(provider)?.key ?? credentials.keys[provider];
    if (!apiKey) throw new AuthError(`no API key for ${provider}; set ${PROVIDER_ENV[provider][0]} or run spl login ${provider}`);
    return { provider, model: model ?? DEFAULT_MODELS[provider], apiKey };
}

export interface AuthStatus {
    isAuthenticated: boolean;
    provider: Provider;
    source?: string;
}

/** Reports credential configuration, without making a billable model request. */
export async function authStatus(provider: Provider): Promise<AuthStatus> {
    const environment = environmentKey(provider);
    if (environment) return { isAuthenticated: true, provider, source: environment.source };
    const key = readCredentials().keys[provider];
    return { isAuthenticated: Boolean(key), provider, ...(key ? { source: 'saved credentials' } : {}) };
}

export async function login(provider: Provider, readKey: () => Promise<string>): Promise<AuthStatus> {
    const credentials = readCredentials();
    const environment = environmentKey(provider);
    if (!environment) {
        const key = (await readKey()).trim();
        if (!key || /[\r\n]/.test(key)) throw new AuthError('API key must be a non-empty single line');
        credentials.keys[provider] = key;
    }
    credentials.provider = provider;
    saveCredentials(credentials);
    return { isAuthenticated: true, provider, source: environment?.source ?? 'saved credentials' };
}

/** With no provider, removes the entire credential file, including legacy tokens. */
export function logout(provider?: Provider): boolean {
    if (provider) {
        const credentials = readCredentials();
        const existed = credentials.keys[provider] !== undefined || credentials.provider === provider;
        delete credentials.keys[provider];
        if (credentials.provider === provider) delete credentials.provider;
        if (existed) saveCredentials(credentials);
        return existed;
    }
    try {
        fs.rmSync(credentialsPath());
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw new AuthError(`cannot remove '${credentialsPath()}': ${(error as Error).message}`);
    }
}
