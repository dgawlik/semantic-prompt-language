import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type CredentialProvider = "openai" | "google" | "anthropic";

export const CREDENTIAL_PROVIDERS: readonly CredentialProvider[] = [
  "openai",
  "google",
  "anthropic",
];

export const PROVIDER_ENV_VARS: Record<CredentialProvider, readonly string[]> = {
  openai: ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
};

export type StoredCredentials = Partial<Record<CredentialProvider, string>>;

export function normalizeProviderName(raw: string): CredentialProvider | null {
  const key = raw.trim().toLowerCase().replace(/-/g, "_");
  if (
    key === "openai" ||
    key === "openai_responses" ||
    key === "openai_chat" ||
    key === "openai_decisions"
  ) {
    return "openai";
  }
  if (key === "google" || key === "gemini" || key === "google_decisions") {
    return "google";
  }
  if (key === "anthropic" || key === "claude") {
    return "anthropic";
  }
  return null;
}

export function getCredentialsPath(): string {
  const override = process.env.SPL_CREDENTIALS_FILE?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".spl", "credentials.json");
}

export function readCredentials(filePath = getCredentialsPath()): StoredCredentials {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: StoredCredentials = {};
    for (const p of CREDENTIAL_PROVIDERS) {
      const val = (parsed as Record<string, unknown>)[p];
      if (typeof val === "string" && val.trim() !== "") {
        out[p] = val.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function writeCredentials(
  creds: StoredCredentials,
  filePath = getCredentialsPath()
): string {
  const cleaned: StoredCredentials = {};
  for (const p of CREDENTIAL_PROVIDERS) {
    const val = creds[p];
    if (typeof val === "string" && val.trim() !== "") {
      cleaned[p] = val.trim();
    }
  }
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(cleaned, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Ignore chmod errors on Windows filesystems
  }
  return filePath;
}

export function maskToken(token: string): string {
  const t = token.trim();
  if (t.length <= 8) return "****";
  return `${t.slice(0, 4)}...${t.slice(-4)}`;
}
