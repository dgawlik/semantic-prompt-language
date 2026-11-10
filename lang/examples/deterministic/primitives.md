---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

```spl 

let name = 'Ada'
let greeting = "Hello, {name.upper()}!"     # {expr} interpolates in every quote style
let literal = 'Use {{name}} as a placeholder' # doubled braces are literal
let raw = r'C:\temp\{not interpolated}'     # raw strings: no escapes or interpolation
let block = '''
Triple-quoted strings span lines.
'''

let split1 = 'hello world'
assert split1.split() == ['hello', 'world']
assert split1.split('e') == ['h', 'llo world']

let fruits = ['apple', 'orange', 'grape']
assert ','.join(fruits) == 'apple,orange,grape'

let speech = '''Hello!

Today is a new day. 

My recent work shows... 

What I would like to propose'''

assert speech.splitlines() == ["Hello!","","Today is a new day. ","",
  "My recent work shows... ","", "What I would like to propose"]

let hello = "Hello world"
assert hello.replace('world', "WORLD!!!") == 'Hello WORLD!!!'
assert hello.find('world') == 6
assert len(hello) == 11

let word = 'Word'
assert word.lower() == 'word'
assert word.upper() == 'WORD'

let totrim = '  word '
assert totrim.strip() == 'word'


assert int(1.0) == 1
assert str(float(1)) == '1.0'
assert bool(1) == True 
assert bool(0.0) == False

assert any([0, 0.0, '', [], object()]) == False
assert all([1, 1.0, 'hello', [1], object:
    'x': 1
]) == True

let lst = []
for i in range(0, 10, 2):
    lst.append(i)
assert lst == [0, 2, 4, 6, 8]
```