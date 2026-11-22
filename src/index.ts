export { lex, type Token, type TokenKind } from "./lexer.js";
export { parse } from "./parser.js";
export { checkProgram, type CheckedProgram, type ModuleExports } from "./typechecker.js";
export { generateJs, type CodegenOptions } from "./codegen.js";
export { compileSnippet, compileFile, extractTypeSchema } from "./compiler.js";
export { generateJsonSchema, generateDecodeCodec } from "./schema.js";
export { SplError, type Span } from "./errors.js";
export { SplLanguageService, SplLanguageServiceCore, type SplLanguageHost } from "./lsp-service.js";
export { startLspServer } from "./lsp.js";
