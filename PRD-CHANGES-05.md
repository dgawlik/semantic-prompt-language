

## Replayable workflows

Everything that touches llm (non deterministic) should be instrumented. If --trace flag is present then
then the llm outputs and inputs are stored in common format.

When you specify --replay flag giving it trace it should replay those llm inputs and outputs without actually
touching llms.

