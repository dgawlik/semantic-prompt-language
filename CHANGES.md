
# Decision API

As now in Google and OpenAI decision Api is present add decision builtin to the language 


## Decision 

The SPL language should use official endpoints (for OpenAI decision endpoint) and for Anthropic
simulate it with existing API. 

Example:

```ts

if (decision(evidence: ['The color red is #ff0000'], 
             question: 'Is this color shade of red? {color}', cutoff: 0.85)) {
  success('Color is red')
} else (
  failure('Color is not red')
)
```

There are 2 overloads:

* first one selects from labels converted to True/False
* second one uses probability cutoff to return true if the prop is > cutoff

