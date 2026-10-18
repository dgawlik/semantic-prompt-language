import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CopilotClient } from '@github/copilot-sdk';

/** OAuth app of the GitHub Copilot CLI; its device flow yields tokens the Copilot runtime accepts. */
const CLIENT_ID = 'Ov23ctDVkRmgkPke0Mmm';
const SCOPE = 'read:user';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

export class AuthError extends Error {}

export function credentialsPath(): string {
    return path.join(process.env.SPL_HOME ?? path.join(os.homedir(), '.spl'), 'credentials.json');
}

/** The token saved by `spl login`, if any. Environment tokens (COPILOT_GITHUB_TOKEN, GH_TOKEN, ...) are handled by the SDK. */
export function loadToken(): string | undefined {
    try {
        const data = JSON.parse(fs.readFileSync(credentialsPath(), 'utf8')) as { token?: unknown };
        return typeof data.token === 'string' && data.token ? data.token : undefined;
    } catch {
        return undefined;
    }
}

function saveToken(token: string): void {
    const file = credentialsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ token }), { mode: 0o600 });
}

/** Removes the saved token; returns whether there was one. */
export function logout(): boolean {
    try {
        fs.rmSync(credentialsPath());
        return true;
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw new AuthError(`cannot remove '${credentialsPath()}': ${(e as Error).message}`);
    }
}

export interface AuthStatus {
    isAuthenticated: boolean;
    login?: string;
    statusMessage?: string;
}

/** Asks the Copilot runtime who it is authenticated as, optionally with an explicit token. */
export async function authStatus(token?: string): Promise<AuthStatus> {
    const client = new CopilotClient(token ? { gitHubToken: token } : {});
    try {
        await client.start();
        return await client.getAuthStatus();
    } catch (e) {
        throw new AuthError(`cannot reach the Copilot runtime: ${(e as Error).message}`);
    } finally {
        await client.stop().catch(() => undefined);
    }
}

interface DeviceCode {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval?: number;
}

async function postForm<T>(url: string, body: Record<string, string>): Promise<T> {
    const res = await fetch(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new AuthError(`GitHub answered HTTP ${res.status} for ${url}`);
    return (await res.json()) as T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** GitHub device flow: the user enters a code in the browser, the token is polled for. */
async function deviceFlow(say: (line: string) => void): Promise<string> {
    const code = await postForm<DeviceCode>(DEVICE_CODE_URL, { client_id: CLIENT_ID, scope: SCOPE });
    say(`Open ${code.verification_uri} and enter the code: ${code.user_code}`);
    say('Waiting for authorization...');
    let interval = (code.interval ?? 5) * 1000;
    const deadline = Date.now() + code.expires_in * 1000;
    while (Date.now() < deadline) {
        await sleep(interval);
        const res = await postForm<{ access_token?: string; error?: string; error_description?: string }>(ACCESS_TOKEN_URL, {
            client_id: CLIENT_ID,
            device_code: code.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
        if (res.access_token) return res.access_token;
        switch (res.error) {
            case 'authorization_pending': break;
            case 'slow_down': interval += 5000; break;
            case 'access_denied': throw new AuthError('authorization was denied');
            case 'expired_token': throw new AuthError('the device code expired; run login again');
            default: throw new AuthError(res.error_description ?? res.error ?? 'unexpected response from GitHub');
        }
    }
    throw new AuthError('the device code expired; run login again');
}

/**
 * Authenticates against GitHub Copilot. Does nothing when the runtime is already authenticated
 * (saved token, environment token or a Copilot CLI / gh login); otherwise runs the device flow and saves the token.
 */
export async function login(say: (line: string) => void): Promise<AuthStatus> {
    const current = await authStatus(loadToken());
    if (current.isAuthenticated) return current;

    const token = await deviceFlow(say);
    const status = await authStatus(token);
    if (!status.isAuthenticated) throw new AuthError(status.statusMessage ?? 'the token was not accepted by the Copilot runtime');
    saveToken(token);
    return status;
}
