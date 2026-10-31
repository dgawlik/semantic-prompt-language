import type { RuntimeAction, RuntimeTool } from './llm.js';
import { TOOL_SPECS } from './tools.js';
import { compileSchema } from './schema.js';
import { isReservedName } from './parser.js';
import { fromJson, isDict, isFunction, runtimeError, type Value } from './values.js';

const name = { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' };
const text = { type: 'string', minLength: 1 };
const tool = (name: string, description: string, properties: Record<string, unknown>, required = Object.keys(properties)): RuntimeTool => ({
    name, description, parameters: { type: 'object', properties, required, additionalProperties: false },
});

export const AGENT_TOOLS: readonly RuntimeTool[] = [
    tool('load_variable', 'Read a shared variable, or read-only $args.', { name: text }),
    tool('save_variable', 'Create or update a shared variable with a JSON value, optionally validating a JSON Schema before saving.', {
        name, value: {}, schema: { anyOf: [{ type: 'object' }, { type: 'boolean' }] },
    }, ['name', 'value']),
    tool('call_function', 'Invoke an existing SPL function or builtin with positional arguments.', { name, args: { type: 'array', items: {} } }),
    tool('get_env', 'Read one environment variable. Missing variables return null.', { name: text }),
    tool('ask_human', 'Ask a human a question and return their answer.', { question: text }),
    tool('success', 'End the whole document successfully with a JSON value.', { value: {} }),
    tool('fail', 'End the whole document with an explicit failure.', { reason: text }),
    tool('restrict', 'Narrow restrictions for the rest of this blockquote, including function and MCP calls.', {
        kind: { enum: ['fs', 'exec', 'net', 'mcp'] },
        value: { anyOf: [text, { type: 'array', items: text }] },
    }),
    tool('set_guidance', 'Add enforce/forbid prompt guidance for the rest of this blockquote, including function calls.', {
        kind: { enum: ['enforce', 'forbid'] }, text,
    }),
    ...Object.values(TOOL_SPECS).map(spec => tool(spec.name, spec.description, spec.properties, spec.required)),
];

const validators = new Map(AGENT_TOOLS.map(spec => [spec.name, compileSchema(fromJson(spec.parameters))]));

export function isRuntimeAction(value: unknown): value is RuntimeAction {
    return typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string'
        && 'arguments' in value && typeof value.arguments === 'object' && value.arguments !== null && !Array.isArray(value.arguments);
}

export function actionArguments(action: RuntimeAction): Record<string, Value> {
    const validate = validators.get(action.name);
    if (!validate) throw runtimeError(`unknown blockquote tool '${action.name}'`);
    const value = fromJson(action.arguments);
    validate(value);
    const check = (v: Value): void => {
        if (isFunction(v)) throw runtimeError('runtime tool arguments must not contain function values');
        if (typeof v === 'number' && !Number.isFinite(v)) throw runtimeError('runtime tool arguments must contain finite JSON numbers');
        if (v && typeof v === 'object') for (const child of Object.values(v)) check(child);
    };
    check(value);
    if (!isDict(value)) throw runtimeError('runtime tool arguments must be an object');
    if ((action.name === 'save_variable' || action.name === 'call_function') && typeof value.name === 'string' && isReservedName(value.name)) {
        throw runtimeError(`'${value.name}' is a reserved word and cannot be used as a binding`);
    }
    return value;
}
