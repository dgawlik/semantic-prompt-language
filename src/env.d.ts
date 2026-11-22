declare var console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare var Buffer: {
  from(data: string | Uint8Array, encoding?: string): Uint8Array & {
    indexOf(value: string, byteOffset?: number): number;
    subarray(start?: number, end?: number): Uint8Array;
    toString(encoding?: string, start?: number, end?: number): string;
  };
  concat(list: Uint8Array[]): Uint8Array & {
    indexOf(value: string, byteOffset?: number): number;
    subarray(start?: number, end?: number): Uint8Array;
    toString(encoding?: string, start?: number, end?: number): string;
  };
  byteLength(str: string, encoding?: string): number;
};

declare var process: {
  argv: string[];
  cwd(): string;
  exit(code?: number): never;
  env: Record<string, string | undefined>;
  platform: string;
  stdin: {
    on(event: "data", cb: (chunk: Uint8Array) => void): void;
    on(event: "end", cb: () => void): void;
    resume(): void;
  };
  stdout: {
    write(chunk: string | Uint8Array): boolean;
  };
};

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string, encoding?: "utf8"): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function statSync(path: string): { isDirectory(): boolean; isFile(): boolean };
}

declare module "node:path" {
  export function resolve(...paths: string[]): string;
  export function dirname(p: string): string;
  export function basename(p: string, ext?: string): string;
  export function extname(p: string): string;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function isAbsolute(p: string): string | boolean;
  export const sep: string;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
  export function pathToFileURL(path: string): { href: string; toString(): string };
}

declare module "node:os" {
  export function tmpdir(): string;
}
