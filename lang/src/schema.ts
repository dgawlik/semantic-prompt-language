import { Ajv, type ErrorObject } from 'ajv';
import { Failure } from './errors.js';
import { isDict, runtimeError, toJson, type Value } from './values.js';

const ajv = new Ajv({ allErrors: true, strict: true });

function errorPath(error: ErrorObject): string {
    const parts = error.instancePath.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (error.keyword === 'required') parts.push(String(error.params.missingProperty));
    if (error.keyword === 'additionalProperties') parts.push(String(error.params.additionalProperty));
    return parts.reduce((path, part) => {
        if (/^(0|[1-9]\d*)$/.test(part)) return `${path}[${part}]`;
        return /^[a-zA-Z_]\w*$/.test(part) ? `${path ? `${path}.` : ''}${part}` : `${path}[${JSON.stringify(part)}]`;
    }, '') || '$';
}

export function compileSchema(schema: Value): (value: Value) => void {
    if (typeof schema !== 'boolean' && !isDict(schema)) throw runtimeError('schema must be a JSON Schema object or boolean');
    const json = toJson(schema);
    if (typeof json !== 'boolean' && (typeof json !== 'object' || json === null)) throw runtimeError('invalid schema');
    let validate;
    try {
        validate = ajv.compile(json);
        if ('$async' in validate && validate.$async) throw new Error('asynchronous schemas are not supported');
    } catch (e) {
        if (!(e instanceof Error)) throw e;
        throw runtimeError(`invalid schema: ${e.message}`);
    }
    return (value) => {
        if (!validate(value)) {
            const details = (validate.errors ?? []).map((error) => `${errorPath(error)}: ${error.message}`).join('; ');
            throw new Failure('validation_failed', details);
        }
    };
}
