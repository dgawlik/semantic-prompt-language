
## Maintain stack of scopes

You should maintain stack of scopes during execution. If variables is accessed in some scope
you should pop the stack until variable is found or the stack is empty. 

If parent scope has variable let statment with same variable shadows it.

It is an error to access from parent scope a variable declared in child scope.


## If statements/blocks are expressions if last line is expression

```
let result = if ? 'Today is friday? True/False' {
    ? 'Haiku on variance'
} else {
    ? 'Sentence on passing time'
}
```

If is expression if last line is expression not statement, the last expression is returned.

## The log should take level modifier

The `log{level=debug}(expression)` statements go to are only visible in debug log level.



