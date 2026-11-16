// The workflow library as ambient globals, exactly as every `.spl` file sees it.
// Editors and type checkers can opt in from a jsconfig.json or tsconfig.json:
//     { "compilerOptions": { "types": ["spl-lang/globals"] } }
import type * as spl from './dist/library.js';

declare global {
    /** Asks the model for a value; no tools. `fmt` and `schema` parse and check the answer. */
    const ask: typeof spl.ask;
    /** Lets the model act with built-in and MCP tools, within active restrictions. */
    const agent: typeof spl.agent;
    /** Asks a person and resolves to their answer. */
    const human: typeof spl.human;
    /** Answers a question about evidence with a boolean: a probability `cutoff`, or `labels` mapped to true/false. */
    const decision: typeof spl.decision;
    /** Adds an instruction to every model call made inside the callback. */
    const enforce: typeof spl.enforce;
    /** Tells every model call inside the callback what to avoid. */
    const forbid: typeof spl.forbid;
    /** Limits files, hosts, executables and MCP tools inside the callback. */
    const restrict: typeof spl.restrict;
    /** Ends the workflow with a result. */
    const success: typeof spl.success;
    /** Ends the workflow with an `explicit_failure`, unless caught. */
    const fail: typeof spl.fail;
    /** Raises `assertion_failed` when the condition is falsy. */
    const assert: typeof spl.assert;
    /** Writes to the run log; `log.error` and `log.debug` select other levels. */
    const log: typeof spl.log;
    /** Generates a JavaScript function from a description. */
    const codegen: typeof spl.codegen;
    /** Reads a UTF-8 text file, subject to `restrict`. */
    const readFile: typeof spl.readFile;
    /** Creates or overwrites a UTF-8 text file, subject to `restrict`. */
    const writeFile: typeof spl.writeFile;
    /** Fetches an http(s) URL, subject to `restrict`. */
    const webFetch: typeof spl.webFetch;
    /** Searches the web and resolves to the top results as text. */
    const webSearch: typeof spl.webSearch;
    /** Runs a shell command and resolves to its combined output, subject to `restrict`. */
    const shell: typeof spl.shell;
    /** Script arguments (`--arg` in the CLI). */
    const args: readonly string[];
    /** Read-only environment variables. */
    const env: Readonly<Record<string, string | undefined>>;
    /** Parses a value with a type, or checks it against raw JSON Schema. */
    const validate: typeof spl.validate;
    /** Markdown builder: `markdown.document().heading('Report')`. */
    const markdown: typeof spl.markdown;
    /** A workflow failure: `error instanceof Failure`, `error.statusCode`, `error.reason`. */
    const Failure: typeof spl.Failure;
    type Failure = spl.Failure;
    /** The TypeScript type a type builder stands for: `type Invoice = Infer<typeof Invoice>`. */
    type Infer<T> = import('./dist/types.js').Infer<T>;

    /** The type builders under one name: `t.Str`, `t.List(t.Int)`. */
    const t: typeof spl.t;
    const Str: typeof spl.Str;
    const Int: typeof spl.Int;
    const Float: typeof spl.Float;
    const Bool: typeof spl.Bool;
    /** Exactly one Unicode character. */
    const Char: typeof spl.Char;
    const Nil: typeof spl.Nil;
    /** Any JSON value. */
    const Any: typeof spl.Any;
    /** Any JSON object, without a declared shape. */
    const Dict: typeof spl.Dict;
    /** A callable; cannot be decoded from JSON. */
    const Fn: typeof spl.Fn;
    const List: typeof spl.List;
    const Union: typeof spl.Union;
    const Nullable: typeof spl.Nullable;
    /** One of the given strings. */
    const Enum: typeof spl.Enum;
    /** An exact record: every field is required and extra fields are rejected. */
    const Struct: typeof spl.Struct;
    /** Names a type and attaches annotations. */
    const Typedef: typeof spl.Typedef;
    /** Wraps raw JSON Schema as a type. */
    const JsonSchema: typeof spl.JsonSchema;

    /** What `---` blocks compile to. Generated code only. */
    const __spl: typeof import('./dist/blocks.js');
}

export {};
