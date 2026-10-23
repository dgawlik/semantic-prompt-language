# Failures & errors

Failures stop execution unless caught. Format, validation, transport, tool, and capability failures have distinct categories so recovery does not accidentally repeat external actions.

## Failure payload

```json
{
  "status": "failure",
  "reason": "lines[2].quantity: must be number",
  "command": "let result = ask(schema=Contract) prompt",
  "line": 12,
  "status_code": "validation_failed"
}
```

`line` is 1-based and `command` contains the innermost failing statement's source line. Backend lifecycle checks outside a statement may use line zero and an empty command. Caught payloads are ordinary dict values.

## Status codes

| Code | Cause |
| --- | --- |
| `invalid_format` | Malformed strict JSON, or a value that does not match the selected `fmt` type. |
| `validation_failed` | JSON parsed, but did not satisfy the schema. Reason includes field paths. |
| `runtime_error` | Invalid modifiers/schema, undeclared local assignment, undefined name, type/arity/index/arithmetic error. |
| `assertion_failed` | A business-rule assertion was false. |
| `explicit_failure` | The script executed fail. |
| `restriction_violation` | Blocked tool action, forbidden generation permission request, or record/replay capability violation. |
| `llm_error` | Authentication, timeout, transport, model, trace/recording I/O, or replay matching/completion failure. |
| `tool_error` | Missing file, HTTP failure, invalid tool input, or nonzero shell exit. |

## try / except

```spl
try {
    let data = read_file('optional.txt')
} except err {
    log("{err.status_code} on line {err.line}: {err.reason}")
    let data = ''
}
success data
```

The handler's name and variables declared in either branch belong to the same function/script scope. Guidance and restriction contexts unwind before the handler runs. Syntax errors occur before execution and cannot be caught. Runtime failures do not roll back prior writes or variable changes.

## assert, fail, success

### Assertions

`assert condition ['message']` checks a business rule independently of schema repair.

```spl
let subtotal = 10
let total = 12
assert total >= subtotal 'total is smaller than subtotal'
success total
```

### Explicit failure

`fail reason` stops with `explicit_failure`, unless caught.

### Successful termination

`success [value]` immediately ends the whole script, including from a function. `return` exits the current function, or the script when used at top level.

## Bounded generation repair

```spl
let Contract = {
    'type': 'object',
    'properties': {'label': {'type': 'string', 'enum': ['bug', 'feature']}},
    'required': ['label'],
    'additionalProperties': False,
}
success ask(schema=Contract, repairs=2) 'Classify: application crashes on startup'
```

This permits one initial call plus two corrections. Only invalid JSON and schema mismatches use that budget. Each correction receives the previous answer and validation errors. Prompt/modifier expressions run once, and generation exposes no tools. Transport/model errors are not retried; external assertions are not repaired. Agents reject nonzero repair budgets.

**Do not retry entire side-effecting blocks blindly**

A raw write can finish before a later model call fails. Keep I/O outside repair, and design any manual action retry with idempotency and explicit error filtering. Neither try/except nor a variable store provides transactionality.

## Uncaught failures and CLI errors

An uncaught script failure prints its payload to stdout and exits with code 1. Syntax/usage errors go to stderr with code 2; internal errors use 70. Invalid recording files are usage errors. Replay mismatch/exhaustion is catchable, while unused entries are checked at backend close and still make the CLI fail before printing a success value.

Opt-in variable stores save even after a script failure, including during workflow trace replay. Only legacy generation replay forbids stores and external writes. Workflow traces capture backend failures too, preserving their categories and reasons on replay. Logs, traces, and recordings can contain sensitive data.
