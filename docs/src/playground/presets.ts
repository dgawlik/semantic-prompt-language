export interface PlaygroundPreset {
  id: string;
  label: string;
  filename: string;
  runnableInBrowser: boolean;
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
    id: "structured-ask",
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
    label: "04 // Reified Generics (reified fn<T>)",
    filename: "reified.splx",
    runnableInBrowser: true,
    code: `pub enum Priority { Low, Normal, Urgent }

pub type Task = struct {
    id: Int            '' Unique numeric task ID
    title: Str         '' Short task summary
    priority: Priority '' Task urgency level
    assignee: Str?     '' Optional owner handle
}

/// Preserves compile-time schema & decoder across any generic T
pub reified fn validate_json<T>(raw: Str) -> Result<T, Str> {
    let parsed = json_parse(raw)?
    match decode<T>(parsed) {
        Ok(val) => Ok(val)
        Err(e) => Err("Invalid payload at '\${e.path}': \${e.message}")
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
    id: "collections",
    label: "05 // std/collections (HashMap & TreeSet)",
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
    label: "06 // Colorless Async (std/clock)",
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
    id: "tool-agent",
    label: "07 // std/llm Tool Agent (Type-Check & Completion)",
    filename: "agent.splx",
    runnableInBrowser: false,
    code: `// Demonstrates std/llm type-checking, named-arg completion, and StreamDelta exhaustiveness.
// Try typing \`llm.\` or adding arguments inside \`llm.agent(\`!
import llm from "std/llm"
import fs from "std/fs"

type FilePath = Str '' Path to a source file

let read_file = llm.tool<FilePath, Str>(
    name: "read_file",
    description: "Reads the UTF-8 contents of a file"
) { path ->
    fs.read(path)
}

fn format_delta(delta: llm.StreamDelta) -> Str {
    match delta {
        llm.TextDelta(text) => text
        llm.ThinkingDelta(t) => "[think] " + t
        llm.SummaryDelta(s) => "[summary] " + s
        llm.ToolCallDelta(name, _, _) => "[tool:" + name + "]"
        llm.DoneDelta => "\n[done]"
    }
}

print("Tool schema: " + json_stringify(type_schema<FilePath>()))
print(format_delta(llm.ToolCallDelta("read_file", "call_1", "{}")))
print(format_delta(llm.TextDelta("Analysis complete.")))`,
  },
];

export const PRESET_ALIASES: Record<string, string> = {
  "dynamic-codegen": "reified-generics",
};

export function findPreset(id: string | null | undefined): PlaygroundPreset {
  if (!id) return PLAYGROUND_PRESETS[0];
  const resolved = PRESET_ALIASES[id] ?? id;
  return PLAYGROUND_PRESETS.find((p) => p.id === resolved) ?? PLAYGROUND_PRESETS[0];
}
