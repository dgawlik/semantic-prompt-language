# Grammar

The complete syntax of SPL documents and the code inside `spl` fences, in EBNF. Modifier names are
checked while parsing; modifier values and schemas are checked at runtime.

## Notation

`{ x }` repeats, `[ x ]` is optional, `|` separates alternatives. Statements end at a newline, `;`,
a closing `}` or the end of input. Newlines inside `()` and `[]` are ignored, and a trailing `\`
continues a line. Opening braces must be on the same line as their keyword. `#` starts a comment.

## Complete grammar

```ebnf
(* Documents *)
document       = frontmatter , { markdown_block } ;
frontmatter    = "---" , NL , yaml_mapping , ( "---" | "..." ) , NL ;
                 (* extension: semantic-prompt-language and version: 1 are required;
                    model and preamble are optional; other keys are errors *)
markdown_block = spl_fence | blockquote | commentary ;
spl_fence      = fence , "spl" , NL , program , fence ;
fence          = 3 * "`" , { "`" } | 3 * "~" , { "~" } ;
                 (* each fence is a complete program without directives *)
blockquote     = ">" , text , { NL , ">" , text } ;
                 (* natural language; the model submits one program for it *)
commentary     = ? any other Markdown ? ;

(* Programs *)
program        = { directive , separator } , { statement , separator } ;
separator      = NL | ";" | end_of_block | EOF ;
directive      = "@" , "(" , "model" , "=" , plain_string , [ "," ] , ")" ;
                 (* raw parse API only; documents use frontmatter model *)
block          = "{" , { statement , separator } , "}" ;

statement      = declaration | assignment | if_stmt | for_stmt | while_stmt
               | def_stmt | try_stmt | guidance_stmt | restrict_stmt | block
               | "return" , [ expr ] | "success" , [ expr ]
               | "assert" , expr , [ expr ] | "fail" , expr
               | "break" | "continue" | "pass" | expr ;
declaration    = "let" , NAME , "=" , expr ;
assignment     = target , ( "=" | "+=" | "-=" | "*=" | "/=" | "//=" | "%=" ) , expr ;
target         = NAME | postfix , "." , NAME | postfix , "[" , expr , "]" ;
if_stmt        = "if" , expr , block , { NL* , "elif" , expr , block } , [ NL* , "else" , block ] ;
for_stmt       = "for" , NAME , { "," , NAME } , "in" , expr , block ;
while_stmt     = "while" , expr , block ;
def_stmt       = "def" , NAME , "(" , [ NAME , { "," , NAME } , [ "," ] ] , ")" , block ;
try_stmt       = "try" , block , NL* , "except" , NAME , block ;
guidance_stmt  = ( "enforce" | "forbid" ) , expr , block ;
restrict_stmt  = "restrict" , restrict_clause , { "," , restrict_clause } , block ;
restrict_clause = [ "fs" | "net" | "exec" | "mcp" ] , expr ;

(* Every block is a lexical child scope; let declares locally, assignment updates the
   nearest declaration. Blocks and if yield their final expression, otherwise None.
   {} is an empty dict; { pass } is an empty block. Functions need an explicit return. *)

expr           = or_expr , [ "if" , or_expr , "else" , expr ] ;
or_expr        = and_expr , { "or" , and_expr } ;
and_expr       = not_expr , { "and" , not_expr } ;
not_expr       = "not" , not_expr | comparison ;
comparison     = sum , { ( "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "not" , "in" ) , sum } ;
sum            = term , { ( "+" | "-" ) , term } ;
term           = unary , { ( "*" | "/" | "//" | "%" ) , unary } ;
unary          = ( "-" | "+" ) , unary | "ask" , [ modifiers ] , postfix
               | human_expr | power ;
power          = postfix , [ "**" , unary ] ;
postfix        = primary , { call | index | slice | member } ;
call           = "(" , [ expr , { "," , expr } , [ "," ] ] , ")" ;
index          = "[" , expr , "]" ;
slice          = "[" , [ expr ] , ":" , [ expr ] , "]" ;
member         = "." , NAME ;
primary        = NUMBER | string | "True" | "False" | "None" | NAME | special_var
               | "(" , expr , ")" | list | dict | block | if_stmt | log_expr | human_expr
               | ( "think" | "agent" ) , [ modifiers ] , postfix ;
special_var    = "$env" | "$args" ;
list           = "[" , [ expr , { "," , expr } , [ "," ] ] , "]" ;
dict           = "{" , [ expr , ":" , expr , { "," , expr , ":" , expr } , [ "," ] ] , "}" ;
modifiers      = "(" , [ modifier , { "," , modifier } , [ "," ] ] , ")" ;
modifier       = ( "len" | "fmt" | "reasoning" | "show" | "schema" | "repairs" | "model" ) , "=" , expr ;
log_expr       = "log" , "(" , [ "level" , "=" , log_level , [ "," ] ] , ")" , call ;
log_level      = "error" | "info" | "debug" | expr ;
human_expr     = "human" , postfix ;

(* Unknown or duplicate modifiers are syntax errors. human takes no modifiers and
   requires a checkpoint run. Tools are ordinary functions: read_file, write_file,
   web_fetch, web_search, shell. *)

string         = [ "r" ] , quote , { char | escape | interpolation } , closing_quote ;
quote          = "'" | '"' | "'''" | '"""' ;
plain_string   = string_without_interpolation ;
escape         = "\" , ( "n" | "t" | "r" | "0" | "\" | "'" | '"' | "{" | "}" ) ;
interpolation  = "{" , expr , "}" ;
NUMBER         = digit+ , [ "." , digit+ ] , [ ( "e" | "E" ) , [ "+" | "-" ] , digit+ ] ;
NAME           = ( letter | "_" ) , { letter | digit | "_" } ;
NL             = newline ;

(* "{{" and "}}" are literal braces; raw strings have no escapes or interpolation.
   $env and $args are read-only; other $-names are syntax errors.
   Reserved words: let if elif else for in while def return try except assert fail success
   enforce forbid restrict ask think agent human break continue pass and or not True False None. *)
```

## Maintaining the grammar

This page is the only copy of the grammar. When the syntax changes, update it together with the
VS Code TextMate grammar, then run `npm run docs:build` from the repository root. The documentation
tests check that the rendered grammar and the example listings stay in sync.
