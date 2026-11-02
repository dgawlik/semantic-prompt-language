import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authStatus, credentialsPath, DEFAULT_MODELS, login, logout, parseProvider, PROVIDERS, PROVIDER_ENV, resolveProvider } from '../src/auth.js';

let home: string;
beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-auth-'));
    vi.stubEnv('SPL_HOME', home);
    vi.stubEnv('SPL_PROVIDER', undefined);
    for (const names of Object.values(PROVIDER_ENV)) for (const name of names) vi.stubEnv(name, undefined);
});
afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
});

it.each(PROVIDERS)('saves %s keys separately, selects a default and prefers environment credentials', async provider => {
    await login(provider, async () => 'saved-key');
    expect(resolveProvider()).toEqual({ provider, apiKey: 'saved-key', model: DEFAULT_MODELS[provider] });
    expect(await authStatus(provider)).toMatchObject({ isAuthenticated: true, source: 'saved credentials' });
    vi.stubEnv(PROVIDER_ENV[provider][0], 'environment-key');
    expect(resolveProvider().apiKey).toBe('environment-key');
    expect(await authStatus(provider)).toMatchObject({ source: PROVIDER_ENV[provider][0] });
    expect(fs.readFileSync(credentialsPath(), 'utf8')).not.toContain('environment-key');
    if (process.platform !== 'win32') expect(fs.statSync(credentialsPath()).mode & 0o777).toBe(0o600);
});

it.each(PROVIDER_ENV.google)('recognizes Google alias %s', name => {
    vi.stubEnv(name, 'google-key');
    expect(resolveProvider()).toMatchObject({ provider: 'google', apiKey: 'google-key' });
});

it('retains multiple provider keys and supports selective logout', async () => {
    await login('openai', async () => 'openai-key');
    await login('google', async () => 'google-key');
    expect(resolveProvider().provider).toBe('google');
    expect(logout('google')).toBe(true);
    expect(resolveProvider().provider).toBe('openai');
    expect(logout('google')).toBe(false);
    expect(logout()).toBe(true);
    expect(logout()).toBe(false);
});

it('requires a choice when multiple providers are configured without a default', () => {
    vi.stubEnv('OPENAI_API_KEY', 'openai-key');
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key');
    expect(() => resolveProvider()).toThrow('multiple providers');
    expect(resolveProvider('claude-sonnet-4-5').provider).toBe('anthropic');
    expect(resolveProvider('openai/custom-model').provider).toBe('openai');
    expect(resolveProvider(undefined, 'openai').provider).toBe('openai');
    vi.stubEnv('SPL_PROVIDER', 'anthropic');
    expect(resolveProvider().provider).toBe('anthropic');
    expect(resolveProvider('gpt-4.1').provider).toBe('openai');
});

it('does not reuse old GitHub tokens or silently fall back for a missing selected key', () => {
    fs.writeFileSync(credentialsPath(), JSON.stringify({ token: 'legacy-token' }));
    expect(() => resolveProvider()).toThrow('no provider');
    vi.stubEnv('OPENAI_API_KEY', 'key');
    expect(() => resolveProvider('anthropic/claude-sonnet-4-5')).toThrow('no API key for anthropic');
    expect(resolveProvider().apiKey).toBe('key');
});

it('selects an environment provider on login without persisting its key or prompting', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'environment-key');
    const readKey = vi.fn(async () => 'must-not-read');
    await login('openai', readKey);
    expect(readKey).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'))).toEqual({ provider: 'openai', keys: {} });
});

it('fails clearly for corrupt saved credentials and invalid provider/model choices', async () => {
    expect(() => parseProvider('other')).toThrow('unknown provider');
    expect(() => resolveProvider()).toThrow('no provider');
    expect(() => resolveProvider('google/', 'openai')).toThrow('model must not be empty');
    expect(() => resolveProvider('google/gemini-2.5-flash', 'openai')).toThrow('not the selected provider');
    await expect(login('openai', async () => '')).rejects.toThrow('non-empty single line');
    await expect(login('openai', async () => 'a\nb')).rejects.toThrow('non-empty single line');
    fs.writeFileSync(credentialsPath(), '{');
    expect(() => resolveProvider()).toThrow('cannot read saved credentials');
    expect(logout()).toBe(true);
});
