---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

```spl 

# Create object
let test = object:
    'a': 1
    'b': 2
log('Test object {test}')

# Assign values to keys
test['c'] = 3
test.d = 4
log('Addition: {test}')


# Remove by key
test.pop('c')
test.pop('d')
log('Removal: {test}')

# Iterate by values
for v in test.values():
    log("Test value: {v}")

# Iterate by keys
for k in test.keys():
    log('Test key: {k}')

# Iterate by key, value pairs
for k, v in test.items():
    log('Test -> k = {k}, v = {v}')


# Copy and clear
let cpy = test.copy()
cpy.clear()
log('Cleared: {cpy}')


```