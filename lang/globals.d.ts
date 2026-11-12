// The workflow library as ambient globals, exactly as every `js`/`ts` fence sees it.
// Editors and type checkers can opt in from a jsconfig.json or tsconfig.json:
//     { "compilerOptions": { "types": ["spl-lang/globals"] } }
import type * as spl from './dist/library.js';

declare global {
    /** Asks the model for a value; no tools. `fmt` and `schema` parse and check the answer. */
    const ask: typeof spl.ask;
    /** Like `ask`, with medium reasoning by default. */
    const think: typeof spl.think;
    /** Lets the model act with runtime and MCP tools, within active restrictions. */
    const agent: typeof spl.agent;
    /** Asks a person and resolves to their answer. */
    const human: typeof spl.human;
    /** Adds an instruction to every model call made inside the callback. */
    const enforce: typeof spl.enforce;
    /** Tells every model call inside the callback what to avoid. */
    const forbid: typeof spl.forbid;
    /** Limits files, hosts, executables and MCP tools inside the callback. */
    const restrict: typeof spl.restrict;
    /** Ends the document with a result. */
    const success: typeof spl.success;
    /** Ends the document with an `explicit_failure`, unless caught. */
    const fail: typeof spl.fail;
    /** Raises `assertion_failed` when the condition is falsy. */
    const assert: typeof spl.assert;
    /** Writes to the run log; `log.error` and `log.debug` select other levels. */
    const log: typeof spl.log;
    /** Generates a JavaScript function from a description and defines it in the shared scope. */
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
    /** The JavaScript value a type parses to: `type Invoice = Infer<typeof Invoice>`. */
    type Infer<T> = import('./dist/types.js').Infer<T>;

    /** The type builders under one name: `t.str`, `t.list(t.int)`. */
    const t: typeof spl.t;
    const str: typeof spl.str;
    const int: typeof spl.int;
    const float: typeof spl.float;
    const bool: typeof spl.bool;
    const char: typeof spl.char;
    const nil: typeof spl.nil;
    const any: typeof spl.any;
    const object: typeof spl.object;
    const fn: typeof spl.fn;
    const list: typeof spl.list;
    const union: typeof spl.union;
    const nullable: typeof spl.nullable;
    const enumOf: typeof spl.enumOf;
    const struct: typeof spl.struct;
    const typedef: typeof spl.typedef;
    const jsonSchema: typeof spl.jsonSchema;
}

export {};
