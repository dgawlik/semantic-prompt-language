---
extension: 'semantic-prompt-language'
version: 1
---

# Typed data without a model

Annotations opt into persistent contracts. This workflow uses no model calls or credentials:

    spl examples/typed-data.md

It covers primitives, transparent aliases, enums, exact structs, nullable fields,
unions, callable signatures, validation, persistent list contracts and deep projections.
For schema decoding, `schema=Person` hydrates only an opted-in class, whereas
`schema=struct(Person)` returns structural data, never a nominal instance.
Field and alias metadata are model advice; use assertions for business rules.

```spl
enum Color = 'red' | 'green' | 'blue'
type Palette = list[Color]
type Money = int [minimum=0, desc='Amount in cents']
type MaybeMoney = Money | None

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
let initial: char = 'A'
let enabled: bool = True
let colors: Palette = ['blue']
let alias = colors
alias.append('green')
assert len(colors) == 2 'untyped aliases share the same guarded list'

let subtotal: Money = 1250
let total: Money = subtotal * count
let discount: MaybeMoney = None
assert total >= 0 'amounts must not be negative'
let typed_length: int = int(len(colors))
let scaled: float = float(count) * ratio
assert typed_length == count and scaled == float(count) 'convert dynamic or mixed numbers explicitly'
assert json_stringify([count, ratio]) == '[2,1.0]' 'typed numeric JSON preserves representations'

let raw_address = json_parse(r'{"city":"London","postalCode":null}')
let address: Address = validate(raw_address, Address)
let person = Person('Ada', colors[0], address)
let handler: Handler = object:
    'callback': repeat
let choice: int | str = count
if isinstance(choice, int):
    assert choice == count 'the union currently contains an integer'
choice = 'blue'
if isinstance(choice, str):
    assert choice.upper() == 'BLUE' 'narrow unions before string operations'
assert initial == 'A' and enabled and discount == None 'primitive and nullable values'
assert handler.callback('Hi ', count) == 'Hi Hi ' 'callable fields check arguments and results'

let snapshot = object(person)
snapshot.address.city = 'Paris'
assert person.address.city == 'London' 'deep projections must not mutate the source'
log(person.greeting(), handler.callback('Hi ', count))
success object(person)
```
