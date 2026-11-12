import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { compileCell, type CompiledCell } from './cell.js';
import { Failure, SplSyntaxError } from './errors.js';

export const codegenSignature = (description: string): string =>
    createHash('sha256').update(description).digest('hex');
export const codegenHeader = (signature: string): string => `// @CODEGEN sha256:${signature}`;

/** Models often wrap code in a fence despite instructions; one enclosing fence is unwrapped. */
export function unwrapCode(text: string): string {
    const fenced = /^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/.exec(text);
    return (fenced ? fenced[2] : text).trim();
}

/** Generated code may only declare functions: nothing runs until the workflow calls them. */
export function compileCodegen(text: string): CompiledCell {
    let cell: CompiledCell;
    try {
        cell = compileCell(text);
    } catch (error) {
        if (!(error instanceof SplSyntaxError)) throw error;
        throw new Failure('invalid_format', `@CODEGEN returned invalid JavaScript: ${error.message} (line ${error.line})`);
    }
    if (!cell.statements.length || cell.statements.some(type => type !== 'FunctionDeclaration')) {
        throw new Failure('invalid_format', '@CODEGEN requires only JavaScript function declarations, without imports, exports or top-level statements');
    }
    return cell;
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
            if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.js')) continue;
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
        const friendly = path.join(directory, `${prefix}${name}.js`);
        const file = fs.existsSync(friendly) ? path.join(directory, `${prefix}${name}.${signature}.js`) : friendly;
        fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
        return file;
    } catch (error) {
        if (!(error instanceof Error)) throw error;
        throw new Failure('runtime_error', `cannot save @CODEGEN cache for '${source}': ${error.message}`);
    }
}
