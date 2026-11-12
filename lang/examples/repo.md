---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Repository Agentic Operations

This example highlights some SPL features helpful in automation of day to day workflow

> read the repository you are in and list security vulnerabilities grouped in categories high, medium, low. each category should be an array of issues with each issue json object with name, cwe-id, link to file and describtion. save to @vulnerabilities

```js
log(vulnerabilities);
```

```js
const { high = [], medium = [], low = [] } = vulnerabilities;

if (high.length > 0) fail(`High vulnerabilities found. Fix this one first ${JSON.stringify(high[0])}`);
for (const item of medium) log('Medium vulnerability found:', item);
if (medium.length === 0) for (const item of low) log('Low vulnerability found:', item);
success('Analyzed');
```
