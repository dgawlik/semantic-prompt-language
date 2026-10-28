---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Repository Agentic Operations

This example highlights some SPL features helpful in automation of day to day workflow

> read the repository you are in and list security vulnerabilities grouped in categories high, medium, low. each category should be an array of issues with each issue json object with name, cwe-id, link to file and describtion. save to @vulnerabilities

```spl
log(vulnerabilities)
```

```spl
if len(vulnerabilities['high']) > 0{
    fail 'High vulnerabilities found. Fix this one first {vulnerabilities["high"][0]}'
} elif len(vulnerabilities['medium']) > 0{
    for vuln in vulnerabilities['medium']{
        log('Medium vulnerability found: {vuln}')
    }
} elif len(vulnerabilities['low']) > 0{
    for vuln in vulnerabilities['low']{
        log('Low vulnerability found: {vuln}')
    }
}

success 'Analyzed'
```


