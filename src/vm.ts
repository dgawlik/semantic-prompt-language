import { callBuiltin } from "./builtins.js";
import { SignatureCatalog, computeCatalogSha256 } from "./catalog.js";
import {
  INT64_MIN,
  SplErrorValue,
  SplObject,
  SplRecoverableError,
  SplTrapCode,
  SplTrapError,
  SplValue,
  canonicalJsonStringify,
  checkInt64,
  codePointAtIndex,
  codePointLength,
  compareCodePoints,
  deepCloneSpl,
  deepEqualSpl,
  formatValueForTemplate,
  logicalSizeBytes,
  makeSplObject,
  normalizeFloat,
  sha256Hex,
  structuralWorkUnits,
} from "./canonical.js";
import { BytecodeFunction, BytecodeProgram, parseBytecode, serializeBytecode } from "./compiler.js";
import {
  JsonSchema,
  T_BOOL,
  T_ERROR,
  T_FS_STAT,
  T_NULL,
  T_SHELL_RESULT,
  T_STRING,
  T_WEB_FETCH_RESPONSE,
  T_WEB_SEARCH_RESULT,
  makeList,
  validateRuntimeValue,
  validateValueAgainstJsonSchema,
} from "./types.js";

export type EffectKind =
  | "model.ask"
  | "model.decide"
  | "web.search"
  | "web.fetch"
  | "fs"
  | "shell"
  | "js_tool"
  | "mcp_tool";

export interface VmLimits {
  max_steps: number;
  max_call_depth: number;
  max_operand_stack: number;
  max_memory_bytes: number;
  max_state_bytes: number;
  max_effects_total: number;
  max_effects_by_kind: Record<EffectKind, number>;
}

export const DEFAULT_VM_LIMITS: VmLimits = {
  max_steps: 100_000,
  max_call_depth: 64,
  max_operand_stack: 1024,
  max_memory_bytes: 16_777_216,
  max_state_bytes: 1_048_576,
  max_effects_total: 64,
  max_effects_by_kind: {
    "model.ask": 16,
    "model.decide": 32,
    "web.search": 8,
    "web.fetch": 16,
    fs: 32,
    shell: 8,
    js_tool: 32,
    mcp_tool: 32,
  },
};

export type EffectOutcome =
  | {
      status: "ok";
      value: SplValue;
      decision_scores?: Record<string, number>;
      confidence?: number;
    }
  | {
      status: "error";
      error: SplErrorValue;
    };

export interface EffectRecord {
  seq: number;
  kind: EffectKind;
  target: string;
  args: SplObject;
  outcome: EffectOutcome;
  non_normative_meta?: Record<string, unknown>;
}

export interface VmMetrics {
  steps: number;
  peak_call_depth: number;
  peak_operand_stack: number;
  peak_memory_bytes: number;
  effects_count: number;
}

export type VmResult =
  | {
      status: "ok";
      value: SplValue;
      final_state: SplObject;
      metrics: VmMetrics;
    }
  | {
      status: "trap";
      trap_code: SplTrapCode;
      trap_message: string;
      trap_pc: number;
      trap_fn: string;
      final_state: null;
      metrics: VmMetrics;
    };

export interface NormativeTrace {
  spec_version: "5";
  bytecode_sha256: string;
  catalog_sha256: string;
  inputs: SplObject;
  initial_state: SplObject;
  limits: VmLimits;
  effects: EffectRecord[];
  result: VmResult;
}

export interface EffectRequest {
  seq: number;
  kind: EffectKind;
  target: string;
  args: SplObject;
  schema?: JsonSchema;
  decideOptions?: string[];
}

export interface EffectDispatchResult {
  outcome: EffectOutcome;
  non_normative_meta?: Record<string, unknown>;
}

export interface EffectDispatcher {
  dispatch(req: EffectRequest): Promise<EffectDispatchResult>;
}

export interface RunVmOptions {
  bytecode: BytecodeProgram | string;
  inputs?: Record<string, unknown>;
  initialState?: Record<string, unknown>;
  limits?: Partial<VmLimits>;
  catalog?: SignatureCatalog;
  authorizedCapabilities?: string[];
  dispatcher?: EffectDispatcher;
  replayLog?: EffectRecord[];
  replayMode?: "live" | "recovery" | "strict_replay";
  onEffectRecorded?: (record: EffectRecord) => void | Promise<void>;
  onCommitState?: (finalState: SplObject) => void | Promise<void>;
}

interface CallFrame {
  fn: BytecodeFunction;
  pc: number;
  locals: SplValue[];
  stackBase: number;
}

interface TryHandler {
  frameIndex: number;
  catchPc: number;
  stackDepth: number;
}

export function stripNonNormativeMeta(trace: NormativeTrace): NormativeTrace {
  return {
    ...trace,
    effects: trace.effects.map((e) => {
      const copy: EffectRecord = {
        seq: e.seq,
        kind: e.kind,
        target: e.target,
        args: deepCloneSpl(e.args) as SplObject,
        outcome:
          e.outcome.status === "ok"
            ? {
                status: "ok",
                value: deepCloneSpl(e.outcome.value),
                ...(e.outcome.decision_scores ? { decision_scores: { ...e.outcome.decision_scores } } : {}),
                ...(e.outcome.confidence !== undefined ? { confidence: e.outcome.confidence } : {}),
              }
            : {
                status: "error",
                error: deepCloneSpl(e.outcome.error as unknown as SplValue) as unknown as SplErrorValue,
              },
      };
      return copy;
    }),
  };
}

export function canonicalTraceJson(trace: NormativeTrace): string {
  return canonicalJsonStringify(stripNonNormativeMeta(trace));
}

export async function runVm(options: RunVmOptions): Promise<NormativeTrace> {
  const prog: BytecodeProgram =
    typeof options.bytecode === "string" ? parseBytecode(options.bytecode) : options.bytecode;
  const canonicalText = typeof options.bytecode === "string" ? options.bytecode : serializeBytecode(prog);
  const bytecodeSha = sha256Hex(canonicalText);

  // §5.3 Verify catalog digest & authorized capabilities at load time
  if (options.catalog) {
    const catSha = computeCatalogSha256(options.catalog);
    if (catSha !== prog.catalogSha256) {
      throw new Error(
        `Catalog SHA-256 mismatch: bytecode expects ${prog.catalogSha256}, host catalog is ${catSha}`
      );
    }
  }
  if (options.authorizedCapabilities) {
    const auth = new Set(options.authorizedCapabilities);
    for (const cap of prog.capabilities) {
      if (!auth.has(cap)) {
        throw new Error(`Capability '${cap}' required by bytecode is not authorized by host`);
      }
    }
  }

  const limits: VmLimits = {
    max_steps: options.limits?.max_steps ?? DEFAULT_VM_LIMITS.max_steps,
    max_call_depth: options.limits?.max_call_depth ?? DEFAULT_VM_LIMITS.max_call_depth,
    max_operand_stack: options.limits?.max_operand_stack ?? DEFAULT_VM_LIMITS.max_operand_stack,
    max_memory_bytes: options.limits?.max_memory_bytes ?? DEFAULT_VM_LIMITS.max_memory_bytes,
    max_state_bytes: options.limits?.max_state_bytes ?? DEFAULT_VM_LIMITS.max_state_bytes,
    max_effects_total: options.limits?.max_effects_total ?? DEFAULT_VM_LIMITS.max_effects_total,
    max_effects_by_kind: {
      ...DEFAULT_VM_LIMITS.max_effects_by_kind,
      ...(options.limits?.max_effects_by_kind ?? {}),
    },
  };

  const vm = new StackVm(prog, bytecodeSha, limits, options);
  return vm.execute();
}

class StackVm {
  private fnMap = new Map<string, BytecodeFunction>();
  private stack: SplValue[] = [];
  private frames: CallFrame[] = [];
  private tryHandlers: TryHandler[] = [];

  private inputVals: SplValue[] = [];
  private stagedState: SplValue[] = [];
  private effects: EffectRecord[] = [];
  private effectsByKind: Record<EffectKind, number> = {
    "model.ask": 0,
    "model.decide": 0,
    "web.search": 0,
    "web.fetch": 0,
    fs: 0,
    shell: 0,
    js_tool: 0,
    mcp_tool: 0,
  };

  private steps = 0;
  private peakCallDepth = 0;
  private peakOperandStack = 0;
  private peakMemoryBytes = 0;

  private replayMode: "live" | "recovery" | "strict_replay";
  private replayLog: EffectRecord[];

  constructor(
    private readonly prog: BytecodeProgram,
    private readonly bytecodeSha: string,
    private readonly limits: VmLimits,
    private readonly options: RunVmOptions
  ) {
    for (const fn of prog.functions) {
      this.fnMap.set(fn.name, fn);
    }
    this.replayLog = options.replayLog ?? [];
    this.replayMode = options.replayMode ?? (options.replayLog ? "recovery" : "live");
  }

  private resolveConst(ref: string): SplValue {
    const idx = Number(ref.slice(1));
    const entry = this.prog.consts[idx];
    if (!entry) throw new SplTrapError("VM_INVARIANT_VIOLATION", `Invalid constant ref ${ref}`);
    return deepCloneSpl(entry.value);
  }

  private resolveSchema(ref: string): JsonSchema {
    const idx = Number(ref.slice(1));
    const schema = this.prog.schemas[idx];
    if (!schema) throw new SplTrapError("VM_INVARIANT_VIOLATION", `Invalid schema ref ${ref}`);
    return schema;
  }

  private chargeSteps(amount: number): void {
    this.steps += amount;
    if (this.steps > this.limits.max_steps) {
      throw new SplTrapError("LIMIT_EXCEEDED", `Step budget exceeded (${this.steps} > ${this.limits.max_steps})`);
    }
  }

  private push(v: SplValue): void {
    this.stack.push(v);
    if (this.stack.length > this.peakOperandStack) {
      this.peakOperandStack = this.stack.length;
    }
    if (this.stack.length > this.limits.max_operand_stack) {
      throw new SplTrapError(
        "LIMIT_EXCEEDED",
        `Operand stack depth exceeded (${this.stack.length} > ${this.limits.max_operand_stack})`
      );
    }
  }

  private pop(): SplValue {
    if (this.stack.length === 0) {
      throw new SplTrapError("VM_INVARIANT_VIOLATION", "Operand stack underflow");
    }
    return this.stack.pop()!;
  }

  private checkMemory(): void {
    let total = 0;
    for (const v of this.stack) total += logicalSizeBytes(v);
    for (const f of this.frames) {
      for (const l of f.locals) total += logicalSizeBytes(l);
    }
    for (const inp of this.inputVals) total += logicalSizeBytes(inp);
    let stateBytes = 0;
    for (const st of this.stagedState) stateBytes += logicalSizeBytes(st);
    total += stateBytes;

    if (total > this.peakMemoryBytes) this.peakMemoryBytes = total;
    if (stateBytes > this.limits.max_state_bytes) {
      throw new SplTrapError(
        "LIMIT_EXCEEDED",
        `Durable state size exceeded (${stateBytes} > ${this.limits.max_state_bytes})`
      );
    }
    if (total > this.limits.max_memory_bytes) {
      throw new SplTrapError(
        "LIMIT_EXCEEDED",
        `Memory budget exceeded (${total} > ${this.limits.max_memory_bytes})`
      );
    }
  }

  private snapshotInputsObj(): SplObject {
    const entries: Array<[string, SplValue]> = [];
    for (let i = 0; i < this.prog.inputs.length; i++) {
      entries.push([this.prog.inputs[i].name, deepCloneSpl(this.inputVals[i])]);
    }
    return makeSplObject(entries);
  }

  private snapshotStateObj(): SplObject {
    const entries: Array<[string, SplValue]> = [];
    for (let i = 0; i < this.prog.states.length; i++) {
      entries.push([this.prog.states[i].name, deepCloneSpl(this.stagedState[i])]);
    }
    return makeSplObject(entries);
  }

  private async evalPureInitRef(ref: string): Promise<SplValue> {
    if (ref.startsWith("c")) {
      return this.resolveConst(ref);
    }
    if (ref.startsWith("fn:")) {
      const fnName = ref.slice(3);
      return this.runFunction(fnName, []);
    }
    throw new SplTrapError("VM_INVARIANT_VIOLATION", `Invalid init ref: ${ref}`);
  }

  async execute(): Promise<NormativeTrace> {
    // 1. Validate & populate inputs
    const providedInputs = this.options.inputs ?? {};
    for (const decl of this.prog.inputs) {
      if (Object.prototype.hasOwnProperty.call(providedInputs, decl.name)) {
        const res = validateRuntimeValue(providedInputs[decl.name], decl.type, `input.${decl.name}`);
        if (!res.ok) throw new Error(`Invalid input '${decl.name}': ${res.message}`);
        this.inputVals.push(res.value);
      } else if (decl.defaultRef !== "NONE") {
        const defVal = await this.evalPureInitRef(decl.defaultRef);
        const res = validateRuntimeValue(defVal, decl.type, `input.${decl.name}`);
        if (!res.ok) throw new Error(`Invalid default for input '${decl.name}': ${res.message}`);
        this.inputVals.push(res.value);
      } else {
        throw new Error(`Missing required input '${decl.name}'`);
      }
    }

    // 2. Load & validate initial durable state snapshot (§7.1)
    const providedState = this.options.initialState ?? {};
    for (const decl of this.prog.states) {
      if (Object.prototype.hasOwnProperty.call(providedState, decl.name)) {
        const res = validateRuntimeValue(providedState[decl.name], decl.type, `state.${decl.name}`);
        if (!res.ok) throw new Error(`Invalid initial state '${decl.name}': ${res.message}`);
        this.stagedState.push(res.value);
      } else {
        const initVal = await this.evalPureInitRef(decl.initRef);
        const res = validateRuntimeValue(initVal, decl.type, `state.${decl.name}`);
        if (!res.ok) throw new Error(`Invalid init expression for state '${decl.name}': ${res.message}`);
        this.stagedState.push(res.value);
      }
    }

    const inputsSnapshot = this.snapshotInputsObj();
    const initialStateSnapshot = this.snapshotStateObj();

    // Reset metrics after init loading (only main execution counts toward logical metrics? Or include init? Resetting keeps init clean, and checkMemory enforces initial state limit immediately)
    this.steps = 0;
    this.peakCallDepth = 0;
    this.peakOperandStack = 0;
    this.peakMemoryBytes = 0;

    try {
      this.checkMemory();
      const retVal = await this.runFunction("main", []);
      const finalState = this.snapshotStateObj();

      // §7.1 Transactional commit ONLY on normal completion
      if (this.options.onCommitState) {
        await this.options.onCommitState(deepCloneSpl(finalState) as SplObject);
      }

      return {
        spec_version: "5",
        bytecode_sha256: this.bytecodeSha,
        catalog_sha256: this.prog.catalogSha256,
        inputs: inputsSnapshot,
        initial_state: initialStateSnapshot,
        limits: this.limits,
        effects: this.effects,
        result: {
          status: "ok",
          value: retVal,
          final_state: finalState,
          metrics: this.getMetrics(),
        },
      };
    } catch (err) {
      const curFrame = this.frames[this.frames.length - 1];
      const trapFn = curFrame ? curFrame.fn.name : "main";
      const trapPc = curFrame ? Math.max(0, curFrame.pc - 1) : 0;

      let trapCode: SplTrapCode = "VM_INVARIANT_VIOLATION";
      let trapMessage = err instanceof Error ? err.message : String(err);

      if (err instanceof SplTrapError) {
        trapCode = err.trapCode;
        trapMessage = err.message;
      } else if (err instanceof SplRecoverableError) {
        trapCode = "UNHANDLED_ERROR";
        trapMessage = `${err.errObj.code}: ${err.errObj.message}`;
      }

      return {
        spec_version: "5",
        bytecode_sha256: this.bytecodeSha,
        catalog_sha256: this.prog.catalogSha256,
        inputs: inputsSnapshot,
        initial_state: initialStateSnapshot,
        limits: this.limits,
        effects: this.effects,
        result: {
          status: "trap",
          trap_code: trapCode,
          trap_message: trapMessage,
          trap_pc: trapPc,
          trap_fn: trapFn,
          final_state: null, // rolled back!
          metrics: this.getMetrics(),
        },
      };
    }
  }

  private getMetrics(): VmMetrics {
    return {
      steps: this.steps,
      peak_call_depth: this.peakCallDepth,
      peak_operand_stack: this.peakOperandStack,
      peak_memory_bytes: this.peakMemoryBytes,
      effects_count: this.effects.length,
    };
  }

  private pushFrame(fnName: string, args: SplValue[]): void {
    const fn = this.fnMap.get(fnName);
    if (!fn) throw new SplTrapError("VM_INVARIANT_VIOLATION", `Function '${fnName}' not found`);
    const locals: SplValue[] = new Array(fn.locals).fill(null);
    for (let i = 0; i < args.length; i++) {
      locals[i] = deepCloneSpl(args[i]);
    }
    this.frames.push({ fn, pc: 0, locals, stackBase: this.stack.length });
    if (this.frames.length > this.peakCallDepth) {
      this.peakCallDepth = this.frames.length;
    }
    if (this.frames.length > this.limits.max_call_depth) {
      throw new SplTrapError(
        "LIMIT_EXCEEDED",
        `Call depth exceeded (${this.frames.length} > ${this.limits.max_call_depth})`
      );
    }
  }

  private handleRecoverableError(err: SplRecoverableError): void {
    if (this.tryHandlers.length === 0) {
      throw err; // bubbles up as UNHANDLED_ERROR trap
    }
    const handler = this.tryHandlers.pop()!;
    // Unwind frames above handler.frameIndex
    while (this.frames.length - 1 > handler.frameIndex) {
      this.frames.pop();
    }
    // Unwind operand stack to saved depth
    this.stack.length = handler.stackDepth;
    // Push typed Error record and jump to catchPc
    this.push(deepCloneSpl(err.errObj as unknown as SplValue));
    this.frames[handler.frameIndex].pc = handler.catchPc;
  }

  private async invokeEffect(
    kind: EffectKind,
    target: string,
    args: SplObject,
    validateOk: (rawVal: unknown) => { ok: true; value: SplValue } | { ok: false; message: string },
    schemaErrorCode: string,
    extra: { schema?: JsonSchema; decideOptions?: string[] } = {}
  ): Promise<SplValue> {
    if (this.effects.length >= this.limits.max_effects_total) {
      throw new SplTrapError(
        "LIMIT_EXCEEDED",
        `Total effects limit exceeded (${this.limits.max_effects_total})`
      );
    }
    const kindLimit = this.limits.max_effects_by_kind[kind];
    if (this.effectsByKind[kind] >= kindLimit) {
      throw new SplTrapError("LIMIT_EXCEEDED", `Effect limit for '${kind}' exceeded (${kindLimit})`);
    }

    const seq = this.effects.length;
    const canonArgs = deepCloneSpl(args) as SplObject;

    // §7.2 Replay check
    if (seq < this.replayLog.length) {
      const recorded = this.replayLog[seq];
      const expectedSig = canonicalJsonStringify({ seq, kind, target, args: canonArgs });
      const recordedSig = canonicalJsonStringify({
        seq: recorded.seq,
        kind: recorded.kind,
        target: recorded.target,
        args: recorded.args,
      });
      if (expectedSig !== recordedSig) {
        throw new SplTrapError(
          "REPLAY_DIVERGENCE",
          `Replay divergence at effect #${seq}: emitted ${expectedSig}, log has ${recordedSig}`
        );
      }

      this.effectsByKind[kind]++;
      if (recorded.outcome.status === "ok") {
        const vRes = validateOk(recorded.outcome.value);
        if (!vRes.ok) {
          throw new SplTrapError("REPLAY_DIVERGENCE", `Recorded effect #${seq} value failed validation: ${vRes.message}`);
        }
        const normalizedRec: EffectRecord = {
          seq,
          kind,
          target,
          args: canonArgs,
          outcome: {
            status: "ok",
            value: vRes.value,
            ...(recorded.outcome.decision_scores
              ? { decision_scores: { ...recorded.outcome.decision_scores } }
              : {}),
            ...(recorded.outcome.confidence !== undefined
              ? { confidence: normalizeFloat(recorded.outcome.confidence) }
              : {}),
          },
          ...(recorded.non_normative_meta ? { non_normative_meta: recorded.non_normative_meta } : {}),
        };
        this.effects.push(normalizedRec);
        return vRes.value;
      } else {
        const errCheck = validateRuntimeValue(recorded.outcome.error, T_ERROR, "effect.error");
        if (!errCheck.ok) {
          throw new SplTrapError("REPLAY_DIVERGENCE", `Recorded effect #${seq} error invalid: ${errCheck.message}`);
        }
        const errVal = errCheck.value as unknown as SplErrorValue;
        this.effects.push({
          seq,
          kind,
          target,
          args: canonArgs,
          outcome: { status: "error", error: errVal },
          ...(recorded.non_normative_meta ? { non_normative_meta: recorded.non_normative_meta } : {}),
        });
        throw new SplRecoverableError(errVal.code, errVal.message, errVal.retryable, errVal.details);
      }
    }

    if (this.replayMode === "strict_replay") {
      throw new SplTrapError(
        "REPLAY_DIVERGENCE",
        `Strict replay log exhausted before effect #${seq} (${kind}:${target})`
      );
    }

    if (!this.options.dispatcher) {
      throw new SplTrapError("VM_INVARIANT_VIOLATION", `No EffectDispatcher configured for live effect '${kind}:${target}'`);
    }

    this.effectsByKind[kind]++;
    const dispatched = await this.options.dispatcher.dispatch({
      seq,
      kind,
      target,
      args: canonArgs,
      schema: extra.schema,
      decideOptions: extra.decideOptions,
    });

    if (dispatched.outcome.status === "ok") {
      const vRes = validateOk(dispatched.outcome.value);
      if (!vRes.ok) {
        const recErr = new SplRecoverableError(schemaErrorCode, vRes.message, kind === "model.ask");
        const rec: EffectRecord = {
          seq,
          kind,
          target,
          args: canonArgs,
          outcome: { status: "error", error: recErr.errObj },
          ...(dispatched.non_normative_meta ? { non_normative_meta: dispatched.non_normative_meta } : {}),
        };
        this.effects.push(rec);
        if (this.options.onEffectRecorded) await this.options.onEffectRecorded(rec);
        throw recErr;
      }

      const normScores = dispatched.outcome.decision_scores
        ? Object.fromEntries(
            Object.entries(dispatched.outcome.decision_scores)
              .sort((a, b) => compareCodePoints(a[0], b[0]))
              .map(([k, v]) => [k, normalizeFloat(v)])
          )
        : undefined;

      const rec: EffectRecord = {
        seq,
        kind,
        target,
        args: canonArgs,
        outcome: {
          status: "ok",
          value: vRes.value,
          ...(normScores ? { decision_scores: normScores } : {}),
          ...(dispatched.outcome.confidence !== undefined
            ? { confidence: normalizeFloat(dispatched.outcome.confidence) }
            : {}),
        },
        ...(dispatched.non_normative_meta ? { non_normative_meta: dispatched.non_normative_meta } : {}),
      };
      this.effects.push(rec);
      if (this.options.onEffectRecorded) await this.options.onEffectRecorded(rec);
      return vRes.value;
    } else {
      const errObj = dispatched.outcome.error;
      const recErr = new SplRecoverableError(
        errObj.code,
        errObj.message,
        Boolean(errObj.retryable),
        errObj.details ?? null
      );
      const rec: EffectRecord = {
        seq,
        kind,
        target,
        args: canonArgs,
        outcome: { status: "error", error: recErr.errObj },
        ...(dispatched.non_normative_meta ? { non_normative_meta: dispatched.non_normative_meta } : {}),
      };
      this.effects.push(rec);
      if (this.options.onEffectRecorded) await this.options.onEffectRecorded(rec);
      throw recErr;
    }
  }

  private async runFunction(entryName: string, entryArgs: SplValue[]): Promise<SplValue> {
    const targetDepth = this.frames.length;
    this.pushFrame(entryName, entryArgs);

    while (this.frames.length > targetDepth) {
      const frame = this.frames[this.frames.length - 1];
      if (frame.pc < 0 || frame.pc >= frame.fn.code.length) {
        throw new SplTrapError("VM_INVARIANT_VIOLATION", `PC ${frame.pc} out of bounds in ${frame.fn.name}`);
      }
      const ins = frame.fn.code[frame.pc++];
      this.chargeSteps(1);

      try {
        await this.execInstruction(frame, ins.op, ins.args);
      } catch (err) {
        if (err instanceof SplRecoverableError) {
          this.handleRecoverableError(err);
        } else {
          throw err;
        }
      }
    }

    return this.pop();
  }

  private async execInstruction(frame: CallFrame, op: string, args: string[]): Promise<void> {
    switch (op) {
      // --- Constants & Stack ---
      case "PUSH_CONST":
        this.push(this.resolveConst(args[0]));
        return;
      case "PUSH_NULL":
        this.push(null);
        return;
      case "PUSH_TRUE":
        this.push(true);
        return;
      case "PUSH_FALSE":
        this.push(false);
        return;
      case "POP":
        this.pop();
        return;
      case "DUP": {
        if (this.stack.length === 0) throw new SplTrapError("VM_INVARIANT_VIOLATION", "DUP on empty stack");
        this.push(deepCloneSpl(this.stack[this.stack.length - 1]));
        return;
      }

      // --- Bindings ---
      case "LOAD_LOCAL":
        this.push(deepCloneSpl(frame.locals[Number(args[0])]));
        return;
      case "STORE_LOCAL":
        frame.locals[Number(args[0])] = this.pop();
        this.checkMemory();
        return;
      case "LOAD_INPUT":
        this.push(deepCloneSpl(this.inputVals[Number(args[0])]));
        return;
      case "LOAD_STATE":
        this.push(deepCloneSpl(this.stagedState[Number(args[0])]));
        return;
      case "STORE_STATE":
        this.stagedState[Number(args[0])] = this.pop();
        this.checkMemory();
        return;

      // --- Int Math (checked i64) ---
      case "IADD": {
        const b = this.pop() as bigint;
        const a = this.pop() as bigint;
        this.push(checkInt64(a + b));
        return;
      }
      case "ISUB": {
        const b = this.pop() as bigint;
        const a = this.pop() as bigint;
        this.push(checkInt64(a - b));
        return;
      }
      case "IMUL": {
        const b = this.pop() as bigint;
        const a = this.pop() as bigint;
        this.push(checkInt64(a * b));
        return;
      }
      case "IDIV": {
        const b = this.pop() as bigint;
        const a = this.pop() as bigint;
        if (b === 0n) throw new SplTrapError("DIV_BY_ZERO", "Integer division by zero");
        if (a === INT64_MIN && b === -1n) throw new SplTrapError("NUM_OVERFLOW", "INT64_MIN / -1 overflow");
        this.push(checkInt64(a / b));
        return;
      }
      case "IMOD": {
        const b = this.pop() as bigint;
        const a = this.pop() as bigint;
        if (b === 0n) throw new SplTrapError("DIV_BY_ZERO", "Integer modulo by zero");
        if (a === INT64_MIN && b === -1n) throw new SplTrapError("NUM_OVERFLOW", "INT64_MIN % -1 overflow");
        this.push(checkInt64(a % b));
        return;
      }
      case "INEG": {
        const a = this.pop() as bigint;
        this.push(checkInt64(-a));
        return;
      }

      // --- Bitwise (i64) ---
      case "BIT_AND": {
        const b = this.pop() as bigint;
        const a = this.pop() as bigint;
        this.push(BigInt.asIntN(64, a & b));
        return;
      }
      case "BIT_OR": {
        const b = this.pop() as bigint;
        const a = this.pop() as bigint;
        this.push(BigInt.asIntN(64, a | b));
        return;
      }
      case "BIT_XOR": {
        const b = this.pop() as bigint;
        const a = this.pop() as bigint;
        this.push(BigInt.asIntN(64, a ^ b));
        return;
      }
      case "BIT_NOT": {
        const a = this.pop() as bigint;
        this.push(BigInt.asIntN(64, ~a));
        return;
      }
      case "SHL": {
        const n = this.pop() as bigint;
        const a = this.pop() as bigint;
        if (n < 0n || n > 63n) throw new SplTrapError("SHIFT_OUT_OF_RANGE", `Shift count ${n} outside [0, 63]`);
        this.push(BigInt.asIntN(64, a << n));
        return;
      }
      case "SHR": {
        const n = this.pop() as bigint;
        const a = this.pop() as bigint;
        if (n < 0n || n > 63n) throw new SplTrapError("SHIFT_OUT_OF_RANGE", `Shift count ${n} outside [0, 63]`);
        this.push(BigInt.asIntN(64, a >> n));
        return;
      }
      case "USHR": {
        const n = this.pop() as bigint;
        const a = this.pop() as bigint;
        if (n < 0n || n > 63n) throw new SplTrapError("SHIFT_OUT_OF_RANGE", `Shift count ${n} outside [0, 63]`);
        this.push(BigInt.asIntN(64, BigInt.asUintN(64, a) >> n));
        return;
      }

      // --- Float Math (finite f64) ---
      case "FADD": {
        const b = this.pop() as number;
        const a = this.pop() as number;
        this.push(normalizeFloat(a + b));
        return;
      }
      case "FSUB": {
        const b = this.pop() as number;
        const a = this.pop() as number;
        this.push(normalizeFloat(a - b));
        return;
      }
      case "FMUL": {
        const b = this.pop() as number;
        const a = this.pop() as number;
        this.push(normalizeFloat(a * b));
        return;
      }
      case "FDIV": {
        const b = this.pop() as number;
        const a = this.pop() as number;
        this.push(normalizeFloat(a / b));
        return;
      }
      case "FNEG": {
        const a = this.pop() as number;
        this.push(normalizeFloat(-a));
        return;
      }

      // --- Compare & Logic ---
      case "EQ": {
        const b = this.pop();
        const a = this.pop();
        const work = structuralWorkUnits(a) + structuralWorkUnits(b);
        if (work >= 64) this.chargeSteps(Math.floor(work / 64));
        this.push(deepEqualSpl(a, b));
        return;
      }
      case "NEQ": {
        const b = this.pop();
        const a = this.pop();
        const work = structuralWorkUnits(a) + structuralWorkUnits(b);
        if (work >= 64) this.chargeSteps(Math.floor(work / 64));
        this.push(!deepEqualSpl(a, b));
        return;
      }
      case "ILT": {
        const b = this.pop() as bigint;
        const a = this.pop() as bigint;
        this.push(a < b);
        return;
      }
      case "ILE": {
        const b = this.pop() as bigint;
        const a = this.pop() as bigint;
        this.push(a <= b);
        return;
      }
      case "IGT": {
        const b = this.pop() as bigint;
        const a = this.pop() as bigint;
        this.push(a > b);
        return;
      }
      case "IGE": {
        const b = this.pop() as bigint;
        const a = this.pop() as bigint;
        this.push(a >= b);
        return;
      }
      case "FLT": {
        const b = this.pop() as number;
        const a = this.pop() as number;
        this.push(a < b);
        return;
      }
      case "FLE": {
        const b = this.pop() as number;
        const a = this.pop() as number;
        this.push(a <= b);
        return;
      }
      case "FGT": {
        const b = this.pop() as number;
        const a = this.pop() as number;
        this.push(a > b);
        return;
      }
      case "FGE": {
        const b = this.pop() as number;
        const a = this.pop() as number;
        this.push(a >= b);
        return;
      }
      case "SLT": {
        const b = this.pop() as string;
        const a = this.pop() as string;
        this.push(compareCodePoints(a, b) < 0);
        return;
      }
      case "SLE": {
        const b = this.pop() as string;
        const a = this.pop() as string;
        this.push(compareCodePoints(a, b) <= 0);
        return;
      }
      case "SGT": {
        const b = this.pop() as string;
        const a = this.pop() as string;
        this.push(compareCodePoints(a, b) > 0);
        return;
      }
      case "SGE": {
        const b = this.pop() as string;
        const a = this.pop() as string;
        this.push(compareCodePoints(a, b) >= 0);
        return;
      }
      case "NOT":
        this.push(!(this.pop() as boolean));
        return;
      case "IS_NULL":
        this.push(this.pop() === null);
        return;

      // --- Casts & Strings ---
      case "CAST_I2F": {
        const a = this.pop() as bigint;
        this.push(normalizeFloat(Number(a)));
        return;
      }
      case "CAST_F2I": {
        const a = normalizeFloat(this.pop() as number);
        const trunc = Math.trunc(a);
        // -2^63 is exact in IEEE-754; +2^63 exceeds INT64_MAX (2^63 - 1)
        if (trunc < -9223372036854775808 || trunc >= 9223372036854775808) {
          throw new SplTrapError("NUM_OVERFLOW", `Float ${a} out of signed 64-bit integer range`);
        }
        this.push(checkInt64(BigInt(trunc)));
        return;
      }
      case "CAST_JSON": {
        const schema = this.resolveSchema(args[0]);
        const val = this.pop();
        const res = validateValueAgainstJsonSchema(val, schema, "$");
        if (!res.ok) {
          throw new SplRecoverableError("CAST_ERROR", res.message, false);
        }
        this.push(res.value);
        return;
      }
      case "STR_CONCAT": {
        const n = Number(args[0]);
        const parts: string[] = new Array(n);
        for (let i = n - 1; i >= 0; i--) {
          parts[i] = this.pop() as string;
        }
        const joined = parts.join("");
        const work = codePointLength(joined);
        if (work >= 64) this.chargeSteps(Math.floor(work / 64));
        this.push(joined);
        this.checkMemory();
        return;
      }
      case "FMT_VAL": {
        this.push(formatValueForTemplate(this.pop()));
        return;
      }

      // --- Containers ---
      case "MAKE_LIST": {
        const n = Number(args[0]);
        const items: SplValue[] = new Array(n);
        for (let i = n - 1; i >= 0; i--) items[i] = this.pop();
        if (n >= 64) this.chargeSteps(Math.floor(n / 64));
        this.push(items);
        this.checkMemory();
        return;
      }
      case "MAKE_REC":
      case "MAKE_MAP": {
        const n = Number(args[0]);
        const entries: Array<[string, SplValue]> = new Array(n);
        for (let i = n - 1; i >= 0; i--) {
          const val = this.pop();
          const key = this.pop() as string;
          entries[i] = [key, val];
        }
        if (n >= 64) this.chargeSteps(Math.floor(n / 64));
        this.push(makeSplObject(entries));
        this.checkMemory();
        return;
      }
      case "GET_FIELD": {
        const key = this.resolveConst(args[0]) as string;
        const rec = this.pop() as SplObject;
        if (rec === null || typeof rec !== "object") {
          throw new SplTrapError("VM_INVARIANT_VIOLATION", `GET_FIELD on non-record`);
        }
        this.push(deepCloneSpl(rec[key]));
        return;
      }
      case "GET_FIELD_OPT": {
        const key = this.resolveConst(args[0]) as string;
        const rec = this.pop();
        if (rec === null) {
          this.push(null);
          return;
        }
        this.push(deepCloneSpl((rec as SplObject)[key]));
        return;
      }
      case "SET_FIELD": {
        const key = this.resolveConst(args[0]) as string;
        const val = this.pop();
        const rec = this.pop() as SplObject;
        const entries: Array<[string, SplValue]> = [];
        let found = false;
        for (const k of Object.keys(rec)) {
          if (k === key) {
            entries.push([k, deepCloneSpl(val)]);
            found = true;
          } else {
            entries.push([k, deepCloneSpl(rec[k])]);
          }
        }
        if (!found) entries.push([key, deepCloneSpl(val)]);
        this.push(makeSplObject(entries));
        this.checkMemory();
        return;
      }
      case "GET_INDEX":
      case "GET_INDEX_OPT": {
        const idx = this.pop();
        const col = this.pop();
        if (op === "GET_INDEX_OPT" && col === null) {
          this.push(null);
          return;
        }
        if (Array.isArray(col)) {
          const i = Number(idx as bigint);
          if (i < 0 || i >= col.length) {
            throw new SplTrapError("INDEX_OUT_OF_BOUNDS", `List index ${i} out of bounds (len ${col.length})`);
          }
          this.push(deepCloneSpl(col[i]));
          return;
        }
        if (typeof col === "string") {
          const i = Number(idx as bigint);
          this.push(codePointAtIndex(col, i));
          return;
        }
        if (col !== null && typeof col === "object") {
          const key = idx as string;
          if (!Object.prototype.hasOwnProperty.call(col, key)) {
            if (op === "GET_INDEX_OPT") {
              this.push(null);
              return;
            }
            throw new SplRecoverableError("KEY_NOT_FOUND", `Map key '${key}' not found`, false);
          }
          this.push(deepCloneSpl(col[key]));
          return;
        }
        throw new SplTrapError("VM_INVARIANT_VIOLATION", `Index on unsupported value`);
      }
      case "SET_INDEX": {
        const val = this.pop();
        const idx = this.pop();
        const col = this.pop();
        if (Array.isArray(col)) {
          const i = Number(idx as bigint);
          if (i < 0 || i >= col.length) {
            throw new SplTrapError("INDEX_OUT_OF_BOUNDS", `List index ${i} out of bounds (len ${col.length})`);
          }
          const next = col.map(deepCloneSpl);
          next[i] = deepCloneSpl(val);
          this.push(next);
          this.checkMemory();
          return;
        }
        if (col !== null && typeof col === "object") {
          const key = idx as string;
          const entries: Array<[string, SplValue]> = [];
          let found = false;
          for (const k of Object.keys(col)) {
            if (k === key) {
              entries.push([k, deepCloneSpl(val)]);
              found = true;
            } else {
              entries.push([k, deepCloneSpl(col[k])]);
            }
          }
          if (!found) entries.push([key, deepCloneSpl(val)]);
          this.push(makeSplObject(entries));
          this.checkMemory();
          return;
        }
        throw new SplTrapError("VM_INVARIANT_VIOLATION", `SET_INDEX on unsupported value`);
      }
      case "LIST_LEN": {
        const col = this.pop() as SplValue[];
        this.push(BigInt(col.length));
        return;
      }

      // --- Control Flow & Calls ---
      case "JMP":
        frame.pc = Number(args[0]);
        return;
      case "JMP_IF_FALSE": {
        const cond = this.pop() as boolean;
        if (!cond) frame.pc = Number(args[0]);
        return;
      }
      case "JMP_IF_TRUE": {
        const cond = this.pop() as boolean;
        if (cond) frame.pc = Number(args[0]);
        return;
      }
      case "JMP_IF_NULL": {
        const top = this.stack[this.stack.length - 1];
        if (top === null) frame.pc = Number(args[0]);
        return;
      }
      case "JMP_IF_NOT_NULL": {
        const top = this.stack[this.stack.length - 1];
        if (top !== null) frame.pc = Number(args[0]);
        return;
      }
      case "CALL_FN": {
        const fnName = args[0];
        const arity = Number(args[1]);
        const callArgs: SplValue[] = new Array(arity);
        for (let i = arity - 1; i >= 0; i--) callArgs[i] = this.pop();
        this.pushFrame(fnName, callArgs);
        return;
      }
      case "CALL_BUILTIN": {
        const id = args[0];
        const arity = Number(args[1]);
        const callArgs: SplValue[] = new Array(arity);
        for (let i = arity - 1; i >= 0; i--) callArgs[i] = this.pop();
        const res = callBuiltin(id, callArgs);
        if (res.workUnits >= 64) this.chargeSteps(Math.floor(res.workUnits / 64));
        this.push(res.value);
        this.checkMemory();
        return;
      }
      case "RET": {
        const retVal = this.pop();
        const returningIndex = this.frames.length - 1;
        // Auto-pop any try handlers belonging to the returning frame
        while (
          this.tryHandlers.length > 0 &&
          this.tryHandlers[this.tryHandlers.length - 1].frameIndex === returningIndex
        ) {
          this.tryHandlers.pop();
        }
        const popped = this.frames.pop()!;
        this.stack.length = popped.stackBase;
        this.push(retVal);
        return;
      }

      // --- Exceptions ---
      case "TRY_PUSH":
        this.tryHandlers.push({
          frameIndex: this.frames.length - 1,
          catchPc: Number(args[0]),
          stackDepth: this.stack.length,
        });
        return;
      case "TRY_POP":
        if (this.tryHandlers.length === 0) {
          throw new SplTrapError("VM_INVARIANT_VIOLATION", "TRY_POP with no active handler");
        }
        this.tryHandlers.pop();
        return;

      // --- Effects ---
      case "EFF_ASK": {
        const profile = this.resolveConst(args[0]) as string;
        const schema = this.resolveSchema(args[1]);
        const hasOpts = args[2] === "1";
        const opts = hasOpts ? (this.pop() as SplObject) : {};
        const prompt = this.pop() as string;
        const effArgs = makeSplObject([
          ["prompt", prompt],
          ...Object.entries(opts),
        ]);
        const res = await this.invokeEffect(
          "model.ask",
          profile,
          effArgs,
          (v) => validateValueAgainstJsonSchema(v as SplValue, schema, "$"),
          "MODEL_SCHEMA_ERROR",
          { schema }
        );
        this.push(res);
        this.checkMemory();
        return;
      }

      case "EFF_DECIDE": {
        const profile = this.resolveConst(args[0]) as string;
        const optionsList = this.resolveConst(args[1]) as string[];
        const hasCfg = args[2] === "1";
        const cfg = hasCfg ? (this.pop() as SplObject) : {};
        const prompt = this.pop() as string;

        const hasMinConf = Object.prototype.hasOwnProperty.call(cfg, "min_confidence");
        if (hasMinConf) {
          const mc = cfg.min_confidence as number;
          if (typeof mc !== "number" || !Number.isFinite(mc) || mc < 0 || mc > 1) {
            throw new SplRecoverableError(
              "INVALID_ARGUMENT",
              `min_confidence must be in [0.0, 1.0], got ${String(mc)}`,
              false
            );
          }
        }

        const effArgs = makeSplObject([
          ["options", optionsList],
          ["prompt", prompt],
          ...Object.entries(cfg),
        ]);
        const res = await this.invokeEffect(
          "model.decide",
          profile,
          effArgs,
          (v) => {
            if (v === null) {
              if (hasMinConf) return { ok: true, value: null };
              return { ok: false, message: "Decision API returned null without min_confidence" };
            }
            if (typeof v !== "string" || !optionsList.includes(v)) {
              return { ok: false, message: `Decision choice '${String(v)}' not in allowed options` };
            }
            return { ok: true, value: v };
          },
          "MODEL_SCHEMA_ERROR",
          { decideOptions: optionsList }
        );
        this.push(res);
        this.checkMemory();
        return;
      }

      case "EFF_WEB_SEARCH": {
        const hasOpts = args[0] === "1";
        const opts = hasOpts ? (this.pop() as SplObject) : {};
        const query = this.pop() as string;
        const effArgs = makeSplObject([["query", query], ...Object.entries(opts)]);
        const res = await this.invokeEffect(
          "web.search",
          "search",
          effArgs,
          (v) => validateRuntimeValue(v, makeList(T_WEB_SEARCH_RESULT), "$"),
          "TOOL_SCHEMA_ERROR"
        );
        this.push(res);
        this.checkMemory();
        return;
      }

      case "EFF_WEB_FETCH": {
        const hasOpts = args[0] === "1";
        const opts = hasOpts ? (this.pop() as SplObject) : {};
        const url = this.pop() as string;
        const effArgs = makeSplObject([["url", url], ...Object.entries(opts)]);
        const res = await this.invokeEffect(
          "web.fetch",
          "fetch",
          effArgs,
          (v) => validateRuntimeValue(v, T_WEB_FETCH_RESPONSE, "$"),
          "TOOL_SCHEMA_ERROR"
        );
        this.push(res);
        this.checkMemory();
        return;
      }

      case "EFF_FS": {
        const fsOp = args[0];
        const root = this.resolveConst(args[1]) as string;
        const needsContent = fsOp === "write" || fsOp === "append";
        const content = needsContent ? (this.pop() as string) : undefined;
        const pathStr = this.pop() as string;
        const entries: Array<[string, SplValue]> = [
          ["op", fsOp],
          ["path", pathStr],
          ["root", root],
        ];
        if (content !== undefined) entries.push(["content", content]);
        const effArgs = makeSplObject(entries);

        const validator = (v: unknown) => {
          if (fsOp === "read") return validateRuntimeValue(v, T_STRING, "$");
          if (fsOp === "write" || fsOp === "append") return validateRuntimeValue(v, T_NULL, "$");
          if (fsOp === "exists") return validateRuntimeValue(v, T_BOOL, "$");
          if (fsOp === "list") return validateRuntimeValue(v, makeList(T_STRING), "$");
          return validateRuntimeValue(v, T_FS_STAT, "$");
        };

        const res = await this.invokeEffect("fs", `${root}:${fsOp}`, effArgs, validator, "FS_ERROR");
        this.push(res);
        this.checkMemory();
        return;
      }

      case "EFF_SHELL": {
        const profile = this.resolveConst(args[0]) as string;
        const argRec = this.pop() as SplObject;
        const res = await this.invokeEffect(
          "shell",
          profile,
          argRec,
          (v) => validateRuntimeValue(v, T_SHELL_RESULT, "$"),
          "SHELL_ERROR"
        );
        this.push(res);
        this.checkMemory();
        return;
      }

      case "EFF_JS_TOOL": {
        const toolName = this.resolveConst(args[0]) as string;
        const schema = this.resolveSchema(args[1]);
        const argRec = this.pop() as SplObject;
        const res = await this.invokeEffect(
          "js_tool",
          toolName,
          argRec,
          (v) => validateValueAgainstJsonSchema(v as SplValue, schema, "$"),
          "TOOL_SCHEMA_ERROR",
          { schema }
        );
        this.push(res);
        this.checkMemory();
        return;
      }

      case "EFF_MCP_TOOL": {
        const server = this.resolveConst(args[0]) as string;
        const tool = this.resolveConst(args[1]) as string;
        const schema = this.resolveSchema(args[2]);
        const argRec = this.pop() as SplObject;
        const res = await this.invokeEffect(
          "mcp_tool",
          `${server}.${tool}`,
          argRec,
          (v) => validateValueAgainstJsonSchema(v as SplValue, schema, "$"),
          "TOOL_SCHEMA_ERROR",
          { schema }
        );
        this.push(res);
        this.checkMemory();
        return;
      }

      default:
        throw new SplTrapError("VM_INVARIANT_VIOLATION", `Unknown opcode '${op}'`);
    }
  }
}
