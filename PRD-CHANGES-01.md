

## Lanugage should implement scoping rules

* restrict and forbid only apply to llms so it should be possible to pass the results to variable

Example:

```spl

let color = None

restrict 'your favorite color is blue {
    let color =  ?{len='word', fmt='text'} 'What is your favorite color?'
}
```

It should be possible to shadow variable inside nested clause

```spl

let color = 'Blue'
{
    let color = 'Red'
    log(color)
}
```

## ? operator is actually prefix fix that in grammar


## Skip temperature and seed as they are not implemented in copilot and they only add noise

## All modifications of variables start with let


## Get rid of mock backend it does not serve any purpose, test directly on Copilot

## Add login functionality to the console that does authentication for Github Copilot SDK credentials

## Return should exit immediately from inside any scope

## All llm commands should have sensible defaults and calling them without {} should invoke them

## Built in tools should have also search tool 



