import * as acorn from 'acorn';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';
import { stripTypes } from './compile.js';
import { Failure, SplSyntaxError } from './errors.js';
import { buildPromptParts, type ReasoningLevel } from './llm.js';
import { library } from './library.js';
import { sources } from './loader.js';
import { CODEGEN_PREAMBLE } from './preamble.js';
import { describeValue, unwrapFence, type Context } from './runtime.js';
import { ToolHost } from './tools.js';
import { isType } from './types.js';

export interface CodegenRequest {
    /** The description, including any `-> @name(params): Type` lines. */
    text: string;
    line: number;
    /** Functions the code must declare. Without any, the first declared function is the result. */
    names: readonly string[];
    /** Values the generated code may use by name, besides the workflow library. */
    inputs: ReadonlyMap<string, unknown>;
    model?: string;
    reasoning?: ReasoningLevel;
    hide?: boolean;
    tokens?: number;
}

interface CodegenSource {
    text: string;
    file?: string;
}

const header = (signature: string): string => `// @CODEGEN sha256:${signature}`;
const isSource = (value: unknown): value is CodegenSource =>
    typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string'
    && (!('file' in value) || typeof value.file === 'string');

/** Generated code may only declare functions: nothing runs until the workflow calls them. */
function declaredFunctions(text: string): string[] {
    let program: { body: { type: string; id?: { name: string } }[] };
    try {
        program = acorn.parse(stripTypes(text), { ecmaVersion: 'latest', sourceType: 'script' }) as unknown as typeof program;
    } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof SplSyntaxError)) throw error;
        throw new Failure('invalid_format', `codegen returned invalid JavaScript: ${error.message}`);
    }
    if (!program.body.length || program.body.some(node => node.type !== 'FunctionDeclaration')) {
        throw new Failure('invalid_format', 'codegen requires only JavaScript function declarations, without imports, exports or top-level statements');
    }
    return program.body.map(node => node.id!.name);
}

/** Generated code is kept beside the workflow that asked for it, as `<workflow>.<function>.js`. */
function cacheLocation(url: string | undefined): { directory: string; prefix: string } | undefined {
    if (!url?.startsWith('file:')) return undefined;
    const file = fileURLToPath(url);
    return fs.existsSync(file) ? { directory: path.dirname(file), prefix: `${path.basename(file, path.extname(file))}.` } : undefined;
}

function readCache(url: string | undefined, signature: string): CodegenSource | undefined {
    const location = cacheLocation(url);
    if (!location) return undefined;
    try {
        for (const entry of fs.readdirSync(location.directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (!entry.isFile() || !entry.name.startsWith(location.prefix) || !entry.name.endsWith('.js')) continue;
            const file = path.join(location.directory, entry.name);
            const text = fs.readFileSync(file, 'utf8');
            if (text.replace(/\r\n/g, '\n').split('\n', 1)[0] === header(signature)) return { text, file };
        }
    } catch (error) {
        throw new Failure('runtime_error', `cannot read codegen cache: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
}

function saveCache(url: string | undefined, signature: string, name: string, text: string): string | undefined {
    const location = cacheLocation(url);
    if (!location) return undefined;
    try {
        const friendly = path.join(location.directory, `${location.prefix}${name}.js`);
        const file = fs.existsSync(friendly) ? path.join(location.directory, `${location.prefix}${name}.${signature.slice(0, 12)}.js`) : friendly;
        fs.writeFileSync(file, text, { mode: 0o600 });
        return file;
    } catch (error) {
        throw new Failure('runtime_error', `cannot save codegen cache: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Generates JavaScript functions from a description in one model call, checks that the answer only
 * declares functions and returns them by name. The code is cached beside the workflow, keyed by the
 * description and its signatures, so later runs reuse it without a model.
 */
export async function generateFunctions(request: CodegenRequest, context: Context): Promise<Record<string, (...args: any[]) => unknown>> {
    const { runtime } = context;
    const { text, line, names } = request;
    if (typeof text !== 'string' || !text.trim()) throw new Failure('runtime_error', 'codegen requires a non-empty description');
    const signature = createHash('sha256').update(text).digest('hex');
    const check = (code: string): string[] => {
        const declared = declaredFunctions(code);
        const missing = names.find(name => !declared.includes(name));
        if (missing) throw new Failure('invalid_format', `codegen did not declare the function '${missing}'`);
        return declared;
    };
    const perform = async (): Promise<CodegenSource> => {
        const cached = readCache(context.url, signature);
        if (cached) {
            check(cached.text);
            runtime.logger.info(`codegen reusing ${cached.file}`);
            runtime.logger.modelOutput({ requestId: randomUUID(), kind: 'codegen', role: 'response' }, cached.text);
            return cached;
        }
        const inputs = Object.fromEntries([...request.inputs].map(([name, value]) => [name, isType(value) ? value.schema() : describeValue(value)]));
        const guide = `${CODEGEN_PREAMBLE}\n\nInputs in scope:\n${JSON.stringify(inputs)}`;
        const built = buildPromptParts({
            prompt: `${guide}\n\nFunction description:\n${text}`,
            constraints: context.constraints, restrictions: context.restrictions,
        });
        const response = await runtime.callModel({
            kind: 'ask', prompt: built.prompt,
            model: runtime.resolveModel(request.model, context),
            reasoningEffort: request.reasoning ?? context.defaults.reasoning,
            showReasoning: !(request.hide ?? context.defaults.hide ?? false),
            ...(request.tokens ?? context.defaults.tokens ? { tokens: request.tokens ?? context.defaults.tokens } : {}),
            restrictions: context.restrictions, tools: new ToolHost(context.restrictions, runtime.cwd),
        }, { requestId: randomUUID(), kind: 'codegen' }, [built.preface, guide].filter(Boolean).join('\n\n'), false);
        const source: CodegenSource = { text: `${header(signature)}\n${unwrapFence(response.text)}\n` };
        const [first] = check(source.text);
        source.file = saveCache(context.url, signature, names[0] ?? first, source.text);
        if (source.file) runtime.logger.info(`codegen saved ${source.file}`);
        else delete source.file;
        return source;
    };
    const source = await runtime.effect({ kind: 'codegen', text, line }, perform, isSource);
    const declared = check(source.text);
    const file = source.file ?? `${context.url ?? 'workflow'}#codegen-${signature.slice(0, 12)}.js`;
    sources.set(file, { lines: source.text.replace(/\r\n/g, '\n').split('\n') });
    // Inputs and the library are parameters of the generated code; its own functions shadow both.
    const scope = { ...library(), ...Object.fromEntries([...request.inputs].filter(([name]) => /^[A-Za-z_$][\w$]*$/.test(name))) };
    for (const name of declared) delete scope[name];
    const build = vm.compileFunction(`"use strict"; ${stripTypes(source.text)}\nreturn { ${declared.join(', ')} };`, Object.keys(scope), {
        filename: file, importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    }) as (...values: unknown[]) => Record<string, (...args: any[]) => unknown>;
    return build(...Object.values(scope));
}
