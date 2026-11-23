export interface PlaygroundPreset {
  id: string;
  label: string;
  filename: string;
  runnableInBrowser: boolean;
  autoRun?: boolean;
  code: string;
}

export const PLAYGROUND_PRESETS: PlaygroundPreset[] = [
  {
    id: "row-polymorphism",
    label: "01 // Row Polymorphism & Records",
    filename: "rows.splx",
    runnableInBrowser: true,
    code: `// Try typing \`human.\` or \`fish.\` to test type-aware code completion!
type Human = {
    name: Str
    height: Int
    weight: Int
}

type Fish = {
    species: Str
    height: Int
    weight: Int
}

// Open record (\`..\`) accepts any record with height & weight
type LivingThing = {
    height: Int
    weight: Int
    ..
}

fn feed(mut thing: LivingThing, delta: Int = 1) {
    thing.weight = thing.weight + delta
}

let fish = Fish { species: "Tuna", height: 10, weight: 5 }
feed(fish)

let human = Human { name: "Ada", height: 180, weight: 75 }
feed(human, delta: 2)

print("Human: \${human.name}, weight = \${human.weight}")
print("Fish:  \${fish.species}, weight = \${fish.weight}")`,
  },
  {
    id: "adts-matching",
    label: "02 // ADTs, Match & Result",
    filename: "adts.splx",
    runnableInBrowser: true,
    code: `enum AgentStep {
    Think(Str)
    ToolCall(Str, Int)
    Finish(Str)
    Abort
}

fn describe_step(step: AgentStep) -> Str {
    match step {
        Think(note) => "thinking: " + note
        ToolCall(name, n) if n > 2 => "tool '" + name + "' (high retries: " + to_str(n) + ")"
        ToolCall(name, n) => "tool '" + name + "' (attempt " + to_str(n) + ")"
        Finish(out) => "finished: " + out
        Abort => "aborted"
    }
}

fn route_event(ev: { kind: Str, name: Str, .. }) -> Str {
    match ev {
        { kind: "call", name, ..rest } => "dispatch " + name + " " + json_stringify(rest)
        { kind: "done", name, .. } => "completed " + name
        { kind, .. } => "ignored " + kind
    }
}

let steps = [
    Think("inspecting repo"),
    ToolCall("read_file", 1),
    ToolCall("fetch", 4),
    Finish("all checks passed"),
]

for step in steps {
    print(describe_step(step))
}

print(route_event({ kind: "call", name: "read_file", path: "README.md" }))`,
  },
  {
    id: "prompts-and-schemas",
    label: "03 // Prompts, '' Hints & JSON Schema",
    filename: "schema.splx",
    runnableInBrowser: true,
    code: `// Hover over \`type_schema<Finding>()\` or open the "Schemas" tab!
'' Security finding returned by an automated code reviewer.
type Finding = struct {
    file: Str      '' Relative path to the affected file
    severity: Str  '' Low, Medium, or High
    line: Int      '' 1-based line number
    summary: Str   '' Concise explanation of the issue
}

let target = "src/auth.splx"

// First-class auto-dedented prompt block with \${expr} interpolation
let prompt = @{
    Inspect \${target} for authentication bypasses.
    Respond strictly as JSON matching the Finding schema.
}

print("--- Prompt ---")
print(prompt)

print("\n--- Compile-Time JSON Schema ---")
let schema = type_schema<Finding>()
print(json_stringify(schema))

// Runtime validation via compile-time generated decode<T>()
let sample = "{\\"file\\":\\"src/auth.splx\\",\\"severity\\":\\"High\\",\\"line\\":42,\\"summary\\":\\"Missing token expiry check\\"}"
let parsed = json_parse(sample)?
match decode<Finding>(parsed) {
    Ok(f) => print("\nDecoded: [\${f.severity}] \${f.file}:\${f.line} — \${f.summary}")
    Err(e) => print("Decode error at \${e.path}: \${e.message}")
}`,
  },
  {
    id: "reified-generics",
    label: "04 // Reified Generics & Schemas",
    filename: "reified.splx",
    runnableInBrowser: true,
    code: `pub enum Priority { Low, Normal, Urgent }

pub type Task = struct {
    id: Int            '' Unique numeric task ID
    title: Str         '' Short task summary
    priority: Priority '' Task urgency level
    assignee: Str?     '' Optional owner handle
}

/// All generic functions auto-reify — no \`reified\` keyword required!
pub fn validate_json<T>(raw: Str) -> Result<T, Str> {
    let parsed = json_parse(raw)?
    match decode<T>(parsed) {
        Ok(val) => Ok(val)
        Err(e) => Err("Invalid \${typeof<T>().name} at '\${e.path}': \${e.message}")
    }
}

let good = "{\\"id\\":7,\\"title\\":\\"Ship SPL Playground\\",\\"priority\\":\\"Urgent\\",\\"assignee\\":\\"ada\\"}"
let bad  = "{\\"id\\":\\"oops\\",\\"title\\":\\"Bad ID\\",\\"priority\\":\\"Low\\"}"

match validate_json<Task>(good) {
    Ok(t) => {
        let owner = t.assignee ?? "unassigned"
        print("Valid Task #\${t.id}: \${t.title} [\${to_str(t.priority)}] -> \${owner}")
    }
    Err(e) => print(e)
}

match validate_json<Task>(bad) {
    Ok(t) => print("Unexpected: \${t.title}")
    Err(e) => print("Caught error: " + e)
}`,
  },
  {
    id: "typeof-newtype",
    label: "05 // typeof, newtype & Universal Reification",
    filename: "typeof_newtype.splx",
    runnableInBrowser: true,
    code: `// Try typing \`typeof(uid).\`, \`uid.\`, or \`pt.\` for live LSP completions!
pub newtype UserId = Int
pub newtype OrderId = Int

'' Validated customer email address
pub newtype Email = Str

pub newtype Point = struct {
    x: Int '' Horizontal coordinate
    y: Int '' Vertical coordinate
}

pub newtype Box<T> = struct {
    item: T
}

impl Show for UserId {
    fn show(self) -> Str { "User#" + to_str(self.value) }
}

impl Show for OrderId {
    fn show(self) -> Str { "Order#" + to_str(self.value) }
}

fn UserId.is_admin(self) -> Bool { self.value == 0 }

// Type-level \`typeof\` derives static types from existing bindings
let default_cfg = { host: "localhost", port: 8080, strict: true }
type Config = typeof default_cfg

// Plain generic functions automatically reify — works for \`typeof\`, \`type_schema\`, and \`decode\`!
fn describe<T>(val: T) -> Str {
    let info = typeof(val)
    "\${info.name} [\${info.kind}] = \${to_str(val)}"
}

fn inspect_kind(x) -> Str {
    let info = typeof(x)
    match info.underlying {
        Some(u) => "\${info.name} (newtype over \${u})"
        None => "\${info.name} (\${info.kind})"
    }
}

let uid = UserId(42)
let oid = OrderId(42)
let UserId(raw_id) = uid

let mut pt = Point { x: 10, y: 20 }
pt.x = pt.x + 5

let prod_cfg: Config = { host: "api.spl.dev", port: 443, strict: true }

print("show:         " + uid.show() + " vs " + oid.show() + " (raw=" + to_str(raw_id) + ")")
print("struct:       Point(\${pt.x}, \${pt.y})")
print("typeof type:  \${prod_cfg.host}:\${prod_cfg.port}")
print("describe:     " + describe(uid) + " | " + describe(oid))
print("nominal eq:   UserId==OrderId=" + to_str(typeof(uid) == typeof(oid)) + ", UserId==Int=" + to_str(typeof(uid) == typeof(42)))
print("inspect_kind: " + inspect_kind(uid) + " | " + inspect_kind([1, 2, 3]))
print("higher-order: " + to_str([1, 2].map(describe)))
print("Point fields: " + to_str(typeof<Point>().fields.map { f -> f.name + ":" + f.type_name }))
print("Email schema: " + json_stringify(typeof<Email>().schema))`,
  },
  {
    id: "collections",
    label: "06 // std/collections (HashMap & TreeSet)",
    filename: "collections.splx",
    runnableInBrowser: true,
    code: `// Try typing \`col.\` or \`scores.\` or \`nums.\` for stdlib + extension completions!
import col from "std/collections"

let scores = col.map_new()
    .put("ada", 98)
    .put("grace", 100)
    .put("alan", 95)

let boosted = scores
    .map_values { v -> v + 2 }
    .filter { _, v -> v >= 98 }

print("Map len: " + to_str(scores.len()))
print("Grace's score: " + to_str(scores.get("grace") ?? 0))
print("Boosted keys: " + to_str(boosted.keys()))
print("Boosted total: " + to_str(boosted.fold(0, { acc, _, v -> acc + v })))

let nums = col.set_from_array([42, 7, 19, 7, 3, 25])
print("Sorted AVL TreeSet: " + to_str(nums.to_array()))
print("Min / Max: " + to_str(nums.min() ?? -1) + " / " + to_str(nums.max() ?? -1))`,
  },
  {
    id: "async-clock",
    label: "07 // Colorless Async (std/clock)",
    filename: "async.splx",
    runnableInBrowser: true,
    code: `// No async/await keywords required — SPL infers suspension automatically!
import clock from "std/clock"

fn timed_task(name: Str, delay_ms: Int) -> Str {
    clock.sleep(delay_ms)
    "\${name} done (\${delay_ms}ms)"
}

let t0 = clock.now_ms()

// Opt-in concurrent execution with par_map
let jobs = [
    { name: "alpha", delay_ms: 60 },
    { name: "beta",  delay_ms: 40 },
    { name: "gamma", delay_ms: 50 },
]
let results = jobs.par_map { job -> timed_task(job.name, job.delay_ms) }

let elapsed = clock.now_ms() - t0
for line in results {
    print(line)
}
print("Total parallel wall time: ~\${elapsed}ms")`,
  },
  {
    id: "live-llm-ask",
    label: "08 // Live LLM: Prompt.ask<T> (OpenAI)",
    filename: "ask.splx",
    runnableInBrowser: true,
    autoRun: false,
    code: `// Click Run (Ctrl+Enter) to call OpenAI live through the server-side /api/llm proxy!
// Defaults: provider = "openai_responses", model = "gpt-6-luna", api_key from \`spl login\` / server env.
import llm from "std/llm"

'' Historical figure profile returned by the model.
type Person = struct {
    firstName: Str  '' Given name, e.g. Ada
    lastName: Str   '' Family name, e.g. Lovelace
    age: Int        '' Age in years
    profession: Str '' Primary occupation
}

let ada = @{
    Generate a concise profile for Ada Lovelace.
}.ask<Person>()?

print("\${ada.firstName} \${ada.lastName} (\${ada.age}) — \${ada.profession}")`,
  },
  {
    id: "tool-agent",
    label: "09 // Live LLM: Tool Agent & Streaming",
    filename: "agent.splx",
    runnableInBrowser: true,
    autoRun: false,
    code: `// Click Run (Ctrl+Enter) to run a live multi-turn streaming agent with a typed tool!
// Try typing \`llm.\` or \`@{ Hello }.\` or adding arguments inside \`@{ ... }.agent(\`!
import llm from "std/llm"

type CalcArgs = struct {
    a: Int '' First integer operand
    b: Int '' Second integer operand
}

type CalcOut = struct {
    product: Int '' Exact product of a and b
}

let multiply = llm.tool<CalcArgs, CalcOut>(
    name: "multiply",
    description: "Multiplies two integers accurately"
) { args ->
    Ok({ product: args.a * args.b })
}

let (answer, trace) = @{
    Use the multiply tool to compute 17 * 23 and explain the result in one sentence.
}.agent<Str>(
    tools: [multiply.any()],
    on_delta: Some({ delta ->
        match delta {
            llm.TextDelta(text) => print_inline(text)
            llm.ToolCallDelta(name, _, _) => print_inline("[tool:" + name + "] ")
            _ => ()
        }
    })
)?

print("\n\nTurns: \${trace.turns}, events: \${trace.events.len()}")`,
  },
  {
    id: "live-llm-fn",
    label: "10 // Live LLM: Prompt.llm_fn<In, Out>",
    filename: "codegen.splx",
    runnableInBrowser: true,
    autoRun: false,
    code: `// Click Run (Ctrl+Enter) to synthesize and execute a typed JS function via OpenAI!
import llm from "std/llm"

let sieve = @{
  Create sieve of Eratosthenes function sieve(n: Int) -> Array<Int>
}.llm_fn<Int, Array<Int>>()?

print(sieve(1000))`,
  },
];

export const PRESET_ALIASES: Record<string, string> = {
  "dynamic-codegen": "live-llm-fn",
  "structured-ask": "live-llm-ask",
};

export function findPreset(id: string | null | undefined): PlaygroundPreset {
  if (!id) return PLAYGROUND_PRESETS[0];
  const resolved = PRESET_ALIASES[id] ?? id;
  return PLAYGROUND_PRESETS.find((p) => p.id === resolved) ?? PLAYGROUND_PRESETS[0];
}
