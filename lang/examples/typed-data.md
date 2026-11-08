---
extension: 'semantic-prompt-language'
version: 1
---

# Typed data without a model

Annotations opt into persistent contracts. This workflow uses no model calls.
For schema decoding, `schema=Person` hydrates only an opted-in class, whereas
`schema=struct(Person)` returns structural data, never a nominal instance.

```spl
enum Color = 'red' | 'green' | 'blue'

struct Address:
    city: str
    postalCode: str | None

hydratable class Person:
    name: str
    favorite: Color
    address: Address

    def Person(name: str, favorite: Color, address: Address):
        self.name = name
        self.favorite = favorite
        self.address = address

    def greeting() -> str:
        return 'Hello {self.name}'

def repeat(text: str, count: int) -> str:
    return text * count

struct Handler:
    callback: fn(str, int) -> str

let count: int = 2
let ratio: float = 1.0
let colors: list[Color] = ['blue']
let address: Address = object:
    'city': 'London'
    'postalCode': None
let person = Person('Ada', colors[0], address)
let handler: Handler = object:
    'callback': repeat
let choice: int | str = count
log(person.greeting(), handler.callback('Hi ', count))
success object(person)
```
