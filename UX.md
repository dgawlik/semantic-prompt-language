

# Terminal experience rewrite

## Migrate to ink 

All existing rendering should be rewritten to ink. Give it a copilot cli like look. 

## Add stepper

Add flag to cli `--debug`. When present it stops workflow on the start. Then single js or agent 
block is executed when pressed `n` (Next). It is possible to print global variables with `v` (Variables).
When pressed `c` (Continue) application continues execution until completion with all rendering. `e` (Exit) 
abrupty closes the workflow.

The options are printed at the bottom so that the user knows what to choose.

## Tool usage 

Tool usage should be logged in collapsed mode. When space is pressed (Expand) it should expand the tool usage. 
For read/write file, search_network, fetch_network and codegen the output should be pretty printed as it is visible in file. It should be collapsed by default.

## preamble

Preambles and should be collapsed, differentiate them from the input coming from the workflow.

## Exit 

On exit nothing should be printed to console. The logs are printed to std err and closing the app returns only 
success/failure logged on std-out. By default on completion the app waits for exit signal `e` (Exit).

