import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Program } from './ast.js';
import { Failure, SplSyntaxError } from './errors.js';
import { parse } from './parser.js';

export const codegenSignature = (description: string): string =>
    createHash('sha256').update(description).digest('hex');
export const codegenHeader = (signature: string): string => `# @CODEGEN sha256:${signature}`;

export function parseCodegen(text: string): Program {
    let program: Program;
    try {
        program = parse(text);
    } catch (error) {
        if (!(error instanceof SplSyntaxError)) throw error;
        throw new Failure('invalid_format', `@CODEGEN returned invalid SPL: ${error.message}`);
    }
    if (program.directives.model !== undefined || !program.body.length || program.body.some(stmt => stmt.t !== 'def')) {
        throw new Failure('invalid_format', '@CODEGEN requires only SPL function definitions, without imports, directives or top-level actions');
    }
    return program;
}

export interface CodegenSource {
    text: string;
    file?: string;
}

export function isCodegenSource(value: unknown): value is CodegenSource {
    return typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string'
        && (!('file' in value) || typeof value.file === 'string');
}

function cacheLocation(source: string, cwd: string): { directory: string; prefix: string } {
    const resolved = source.startsWith('file:') ? fileURLToPath(source) : path.resolve(cwd, source);
    return { directory: path.dirname(resolved), prefix: path.basename(resolved, path.extname(resolved)) + '.' };
}

export function readCodegenCache(source: string, signature: string, cwd: string): CodegenSource | undefined {
    try {
        const { directory, prefix } = cacheLocation(source, cwd);
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.spl')) continue;
            const file = path.join(directory, entry.name);
            const text = fs.readFileSync(file, 'utf8');
            if (text.replace(/\r\n/g, '\n').split('\n', 1)[0] === codegenHeader(signature)) return { text, file };
        }
    } catch (error) {
        if (!(error instanceof Error)) throw error;
        throw new Failure('runtime_error', `cannot read @CODEGEN cache: ${error.message}`);
    }
    return undefined;
}

export function saveCodegenCache(source: string, signature: string, name: string, text: string, cwd: string): string {
    try {
        const { directory, prefix } = cacheLocation(source, cwd);
        const friendly = path.join(directory, `${prefix}${name}.spl`);
        const file = fs.existsSync(friendly) ? path.join(directory, `${prefix}${name}.${signature}.spl`) : friendly;
        fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
        return file;
    } catch (error) {
        if (!(error instanceof Error)) throw error;
        throw new Failure('runtime_error', `cannot save @CODEGEN cache for '${source}': ${error.message}`);
    }
}
