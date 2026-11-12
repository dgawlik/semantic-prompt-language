


## Make changes to Semantic Prompt Language 


# Migrate to library

Move away from built in syntax for enforce, forbid, restrict, ask, think, agent, success, failure and human. Instead i want the runtime to be library on node.js. Retain existing functionality as much as possible.

Rewrite structs, classes to special builder in javascript that is easy and readable and allows to add arbitrary annotations on fields for llm to read. Allow creating type defs as library constructs with annotations as well. Make parsing seamless to javascript objects with optional Typescript checking. 

# Markdowns

They should as before but now the default language instead of SPL is native javascript resolved against current working directory. Imports should work as usual and whole node.js standard library should be importable. Custom .js files should be importable. Reuse existing LSP lanugage servers for custom coloring and code completions, but the library itself should be already imported in every code fence. 

The blockqoutes work as usual as agentic runs. The variables, function calling, env and args support, validation, success and failure should be available with @markers. 

# Codegen

It should be possible to generate js function on the fly and use it later steps. 

# Tracing 

Existing recording of flight should be unchanged. 

# Pretty printing

Works as before