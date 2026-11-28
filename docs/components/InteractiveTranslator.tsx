"use client";

import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  Cpu,
  KeyRound,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";
import { DEFAULT_CATALOG, WORKFLOW_PRESETS, WorkflowPreset } from "@/lib/presets";
import { CodeBlock } from "./CodeBlock";

interface DiagnosticItem {
  code: string;
  message: string;
  span?: { line: number; col: number };
}

interface TranslateResponse {
  mode: "live" | "demo";
  source: string;
  bytecode: string;
  sha256: string;
  catalog_sha256: string;
  capabilities: string[];
  inputs: Array<{ name: string; type: string; required: boolean }>;
  states: Array<{ name: string; type: string; init: string }>;
  functions: Array<{ name: string; params: string[]; return_type: string; locals: number; instructions: number }>;
  consts_count: number;
  schemas_count: number;
  attempts: number;
  diagnosticsHistory: DiagnosticItem[][];
  error?: string;
}

interface RunResponse {
  trace: {
    bytecode_sha256: string;
    effects: Array<{
      seq: number;
      kind: string;
      target: string;
      args: Record<string, unknown>;
      outcome: {
        status: "ok" | "error";
        value?: unknown;
        decision_scores?: Record<string, number>;
        confidence?: number;
        error?: { code: string; message: string; retryable: boolean };
      };
    }>;
    result: {
      status: "ok" | "trap";
      value?: unknown;
      final_state?: Record<string, unknown> | null;
      trap_code?: string;
      trap_message?: string;
      metrics: {
        steps: number;
        peak_call_depth: number;
        peak_operand_stack: number;
        peak_memory_bytes: number;
        effects_count: number;
      };
    };
  };
  replayVerified: boolean;
  normativeTraceSha256: string;
  error?: string;
}

type OutputTab = "spl" | "bytecode" | "run" | "catalog";

export function InteractiveTranslator({ compact = false }: { compact?: boolean }) {
  const [selectedPreset, setSelectedPreset] = useState<WorkflowPreset>(WORKFLOW_PRESETS[0]);
  const [prose, setProse] = useState<string>(WORKFLOW_PRESETS[0].prose);
  const [catalogText, setCatalogText] = useState<string>(JSON.stringify(DEFAULT_CATALOG, null, 2));
  const [inputsText, setInputsText] = useState<string>(JSON.stringify(WORKFLOW_PRESETS[0].defaultInputs, null, 2));
  const [stateText, setStateText] = useState<string>(JSON.stringify(WORKFLOW_PRESETS[0].defaultState, null, 2));

  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [model, setModel] = useState<string>("gpt-4.1");
  const [apiKey, setApiKey] = useState<string>("");
  const [showKeyBox, setShowKeyBox] = useState<boolean>(false);

  const [activeTab, setActiveTab] = useState<OutputTab>("spl");
  const [editingSpl, setEditingSpl] = useState<boolean>(false);
  const [splDraft, setSplDraft] = useState<string>("");

  const [translating, setTranslating] = useState<boolean>(false);
  const [compiling, setCompiling] = useState<boolean>(false);
  const [running, setRunning] = useState<boolean>(false);

  const [translated, setTranslated] = useState<TranslateResponse | null>(null);
  const [compileErrors, setCompileErrors] = useState<DiagnosticItem[] | null>(null);
  const [runResult, setRunResult] = useState<RunResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const selectPreset = (p: WorkflowPreset) => {
    setSelectedPreset(p);
    setProse(p.prose);
    setInputsText(JSON.stringify(p.defaultInputs, null, 2));
    setStateText(JSON.stringify(p.defaultState, null, 2));
    setRunResult(null);
    setCompileErrors(null);
    setErrorMsg(null);
    setEditingSpl(false);
    void runTranslate(p.prose, "demo");
  };

  const parseCatalogSafe = () => {
    try {
      return JSON.parse(catalogText);
    } catch {
      throw new Error("Catalog JSON is invalid. Fix syntax in the Catalog tab before compiling.");
    }
  };

  const runTranslate = async (overrideProse?: string, overrideMode?: "demo" | "live") => {
    setTranslating(true);
    setErrorMsg(null);
    setCompileErrors(null);
    setRunResult(null);
    try {
      const cat = parseCatalogSafe();
      const chosenMode = overrideMode ?? mode;
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prose: overrideProse ?? prose,
          catalog: cat,
          model,
          mode: chosenMode,
          apiKey: chosenMode === "live" && apiKey.trim() ? apiKey.trim() : undefined,
          maxAttempts: 3,
        }),
      });
      const data = (await res.json()) as TranslateResponse;
      if (!res.ok || data.error) {
        throw new Error(data.error || `Translation failed (${res.status})`);
      }
      setTranslated(data);
      setSplDraft(data.source);
      setEditingSpl(false);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setTranslating(false);
    }
  };

  const runRecompileSpl = async () => {
    setCompiling(true);
    setErrorMsg(null);
    setCompileErrors(null);
    try {
      const cat = parseCatalogSafe();
      const res = await fetch("/api/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: splDraft, catalog: cat }),
      });
      const data = await res.json();
      if (!data.ok) {
        setCompileErrors(data.diagnostics ?? [{ code: "E_COMPILE", message: data.error ?? "Compilation failed" }]);
        return;
      }
      setTranslated((prev) => ({
        mode: prev?.mode ?? "demo",
        source: splDraft,
        attempts: prev?.attempts ?? 1,
        diagnosticsHistory: prev?.diagnosticsHistory ?? [],
        ...data,
      }));
      setEditingSpl(false);
      setRunResult(null);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setCompiling(false);
    }
  };

  const runVmExecution = async () => {
    if (!translated?.bytecode) return;
    setRunning(true);
    setErrorMsg(null);
    try {
      const cat = parseCatalogSafe();
      const inputs = JSON.parse(inputsText || "{}");
      const initialState = JSON.parse(stateText || "{}");
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bytecode: translated.bytecode,
          inputs,
          initialState,
          catalog: cat,
        }),
      });
      const data = (await res.json()) as RunResponse;
      if (!res.ok || data.error) {
        throw new Error(data.error || `VM execution failed (${res.status})`);
      }
      setRunResult(data);
      setActiveTab("run");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    void runTranslate(WORKFLOW_PRESETS[0].prose, "demo");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/50 shadow-2xl shadow-black/60 backdrop-blur-sm">
      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.08] bg-zinc-950/80 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-1.5">
          {WORKFLOW_PRESETS.map((p) => {
            const active = p.id === selectedPreset.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => selectPreset(p)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  active
                    ? "border border-cyan-400/40 bg-cyan-400/15 text-cyan-200 shadow-sm shadow-cyan-500/10"
                    : "border border-transparent bg-white/[0.03] text-zinc-400 hover:border-white/10 hover:text-zinc-200"
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-white/10 bg-zinc-900 p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setMode("demo")}
              className={`rounded-md px-2.5 py-1 font-medium transition ${
                mode === "demo" ? "bg-zinc-800 text-cyan-300" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Instant Demo
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("live");
                setShowKeyBox(true);
              }}
              className={`rounded-md px-2.5 py-1 font-medium transition ${
                mode === "live" ? "bg-zinc-800 text-violet-300" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Live OpenAI CFG
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowKeyBox((v) => !v)}
            className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition ${
              showKeyBox || apiKey
                ? "border-violet-400/40 bg-violet-500/10 text-violet-200"
                : "border-white/10 bg-white/[0.03] text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <KeyRound className="h-3 w-3" />
            {apiKey ? "Key Set" : "API Key"}
          </button>
        </div>
      </div>

      {/* Collapsible Live OpenAI Key & Model Drawer */}
      {showKeyBox && (
        <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.08] bg-violet-950/20 px-5 py-3 text-xs">
          <div className="flex items-center gap-2">
            <label htmlFor="spl-model" className="font-medium text-zinc-300">
              Model
            </label>
            <select
              id="spl-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="rounded-md border border-white/15 bg-zinc-950 px-2.5 py-1 font-mono text-xs text-zinc-100 outline-none focus:border-cyan-400"
            >
              <option value="gpt-4.1">gpt-4.1</option>
              <option value="gpt-6-luna">gpt-6-luna</option>
              <option value="gpt-5">gpt-5</option>
              <option value="gpt-5-mini">gpt-5-mini</option>
            </select>
          </div>
          <div className="flex flex-1 items-center gap-2 min-w-[240px]">
            <label htmlFor="spl-key" className="font-medium text-zinc-300 whitespace-nowrap">
              OpenAI Key
            </label>
            <input
              id="spl-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-... (optional if server OPENAI_API_KEY is configured)"
              className="w-full rounded-md border border-white/15 bg-zinc-950 px-3 py-1 font-mono text-xs text-zinc-100 placeholder-zinc-600 outline-none focus:border-cyan-400"
            />
          </div>
          <span className="text-[11px] text-zinc-400">Sent only to /api/translate; never stored.</span>
        </div>
      )}

      {/* Main Split Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12">
        {/* Left: Natural-Language Prose Input */}
        <div className="flex flex-col border-b border-white/[0.08] p-5 lg:col-span-5 lg:border-b-0 lg:border-r">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-cyan-500/15 font-mono text-[10px] font-bold text-cyan-300">
                1
              </span>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                Natural-Language Instructions
              </h3>
            </div>
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] text-zinc-400">
              {selectedPreset.badge}
            </span>
          </div>

          <textarea
            value={prose}
            onChange={(e) => setProse(e.target.value)}
            rows={compact ? 11 : 14}
            spellCheck={false}
            placeholder="Describe your workflow in plain English..."
            className="w-full flex-1 resize-none rounded-xl border border-white/10 bg-zinc-950/90 p-3.5 text-sm leading-relaxed text-zinc-100 placeholder-zinc-600 outline-none transition focus:border-cyan-400/60"
          />

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              disabled={translating}
              onClick={() => void runTranslate()}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-400 to-violet-400 px-4 py-2.5 text-xs font-semibold text-zinc-950 shadow-lg shadow-cyan-500/20 transition hover:brightness-110 disabled:opacity-60"
            >
              {translating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {translating ? "Translating via Lark CFG..." : "Translate Prose → SPL + SPLB 5"}
            </button>

            <button
              type="button"
              disabled={running || !translated}
              onClick={() => void runVmExecution()}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-emerald-400/30 bg-emerald-500/15 px-3.5 py-2.5 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/25 disabled:opacity-50"
            >
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Run &amp; Replay
            </button>
          </div>

          <div className="mt-3 rounded-lg border border-white/[0.06] bg-zinc-950/70 px-3 py-2 font-mono text-[11px] text-zinc-400">
            <span className="text-zinc-500">$ </span>
            spl translate workflow.txt -c catalog.json -m {model} -o out.splb
          </div>
        </div>

        {/* Right: Tabbed Compiled Output, Bytecode, VM Run & Replay, Catalog */}
        <div className="flex flex-col p-5 lg:col-span-7">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1 rounded-xl border border-white/10 bg-zinc-950/90 p-1">
              {(
                [
                  { id: "spl", label: "SPL v5 Source", icon: Code2 },
                  { id: "bytecode", label: "SPLB 5 Bytecode", icon: Cpu },
                  { id: "run", label: "VM Run & Replay", icon: Play },
                  { id: "catalog", label: "Catalog", icon: Layers },
                ] as const
              ).map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    activeTab === id
                      ? "bg-white/10 text-white shadow-sm"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>

            {translated && (
              <div className="flex items-center gap-2 text-[11px]">
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-emerald-300">
                  <CheckCircle2 className="h-3 w-3" />
                  {translated.attempts === 1 ? "Compiled (1st try)" : `Repaired in ${translated.attempts} attempts`}
                </span>
              </div>
            )}
          </div>

          {errorMsg && (
            <div className="mb-3 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-xs text-red-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Compile-repair loop trace callout */}
          {translated && translated.diagnosticsHistory.length > 0 && activeTab === "spl" && (
            <div className="mb-3 rounded-xl border border-amber-400/25 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200">
              <div className="flex items-center gap-1.5 font-semibold text-amber-300">
                <Wrench className="h-3.5 w-3.5" />
                Bounded Compile-Repair Loop Activated (Attempt 1 → Attempt 2)
              </div>
              <p className="mt-1 text-[11px] text-amber-200/80">
                Static checker caught{" "}
                {translated.diagnosticsHistory[0].map((d) => `${d.code}`).join(", ")} on attempt 1 and fed structured
                diagnostics back to the Lark CFG translator to produce verified bytecode.
              </p>
            </div>
          )}

          {/* Tab 1: Generated SPL Source (View or Edit + Live Recompile) */}
          {activeTab === "spl" && (
            <div className="flex flex-1 flex-col">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="text-zinc-400">
                  Statically typed SPL v5 · edit to test live type/nullability/capability diagnostics
                </span>
                <div className="flex items-center gap-2">
                  {editingSpl ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setSplDraft(translated?.source ?? "");
                          setEditingSpl(false);
                          setCompileErrors(null);
                        }}
                        className="rounded-md px-2 py-1 text-zinc-400 hover:text-white"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={compiling}
                        onClick={() => void runRecompileSpl()}
                        className="inline-flex items-center gap-1 rounded-md bg-cyan-400 px-2.5 py-1 font-semibold text-zinc-950 hover:brightness-110"
                      >
                        {compiling ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                        Recompile
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setEditingSpl(true)}
                      className="rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1 text-zinc-300 hover:border-white/20 hover:text-white"
                    >
                      Edit SPL
                    </button>
                  )}
                </div>
              </div>

              {compileErrors && (
                <div className="mb-3 space-y-1 rounded-xl border border-red-500/30 bg-red-950/40 p-3 font-mono text-xs text-red-200">
                  {compileErrors.map((d, i) => (
                    <div key={i}>
                      <span className="font-bold text-red-400">{d.code}</span>
                      {d.span ? <span className="text-zinc-400"> ({d.span.line}:{d.span.col})</span> : null}:{" "}
                      {d.message}
                    </div>
                  ))}
                </div>
              )}

              {editingSpl ? (
                <textarea
                  value={splDraft}
                  onChange={(e) => setSplDraft(e.target.value)}
                  rows={15}
                  spellCheck={false}
                  className="w-full flex-1 rounded-xl border border-cyan-400/40 bg-zinc-950 p-4 font-mono text-xs leading-6 text-zinc-100 outline-none"
                />
              ) : (
                <CodeBlock
                  code={translated?.source ?? "// Click Translate Prose to generate SPL v5"}
                  language="spl"
                  title="generated.spl"
                  maxHeight="380px"
                  showLineNumbers
                />
              )}
            </div>
          )}

          {/* Tab 2: Canonical SPLB 5 Bytecode */}
          {activeTab === "bytecode" && translated && (
            <div className="flex flex-1 flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="rounded-md border border-white/10 bg-zinc-950 px-2.5 py-1 font-mono text-zinc-300">
                  SHA-256: <span className="text-cyan-300">{translated.sha256.slice(0, 16)}…</span>
                </span>
                <span className="rounded-md border border-white/10 bg-zinc-950 px-2.5 py-1 font-mono text-zinc-300">
                  Consts: {translated.consts_count} · Schemas: {translated.schemas_count}
                </span>
                {translated.capabilities.map((cap) => (
                  <span
                    key={cap}
                    className="inline-flex items-center gap-1 rounded-md border border-amber-400/25 bg-amber-500/10 px-2 py-1 font-mono text-amber-200"
                  >
                    <ShieldCheck className="h-3 w-3 text-amber-300" />
                    {cap}
                  </span>
                ))}
              </div>
              <CodeBlock code={translated.bytecode} language="splb" title="program.splb (SPLB 5)" maxHeight="350px" />
            </div>
          )}

          {/* Tab 3: VM Execution & Strict Replay */}
          {activeTab === "run" && (
            <div className="flex flex-1 flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-mono text-[11px] text-zinc-400">Inputs JSON</label>
                  <textarea
                    value={inputsText}
                    onChange={(e) => setInputsText(e.target.value)}
                    rows={4}
                    spellCheck={false}
                    className="w-full rounded-xl border border-white/10 bg-zinc-950 p-2.5 font-mono text-xs text-zinc-100 outline-none focus:border-cyan-400/60"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-mono text-[11px] text-zinc-400">Initial Durable State JSON</label>
                  <textarea
                    value={stateText}
                    onChange={(e) => setStateText(e.target.value)}
                    rows={4}
                    spellCheck={false}
                    className="w-full rounded-xl border border-white/10 bg-zinc-950 p-2.5 font-mono text-xs text-zinc-100 outline-none focus:border-cyan-400/60"
                  />
                </div>
              </div>

              {!runResult ? (
                <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-zinc-950/50 p-8 text-center">
                  <Terminal className="mb-2 h-6 w-6 text-zinc-500" />
                  <p className="text-sm text-zinc-300">Execute compiled SPLB 5 bytecode on the deterministic stack VM</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    Runs live sandboxed effects, commits transactional state, and verifies byte-identical strict offline replay.
                  </p>
                  <button
                    type="button"
                    disabled={running || !translated}
                    onClick={() => void runVmExecution()}
                    className="mt-4 inline-flex items-center gap-2 rounded-lg bg-emerald-400 px-4 py-2 text-xs font-semibold text-zinc-950 transition hover:brightness-110"
                  >
                    {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    Execute &amp; Verify Strict Replay
                  </button>
                </div>
              ) : (
                <div className="space-y-3 rounded-xl border border-white/10 bg-zinc-950 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {runResult.trace.result.status === "ok" ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-500/15 px-2.5 py-0.5 font-mono text-xs font-semibold text-emerald-300">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          OK
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full border border-red-400/30 bg-red-500/15 px-2.5 py-0.5 font-mono text-xs font-semibold text-red-300">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          TRAP [{runResult.trace.result.trap_code}]
                        </span>
                      )}
                      {runResult.replayVerified && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-cyan-400/30 bg-cyan-500/10 px-2.5 py-0.5 font-mono text-[11px] text-cyan-200">
                          <ShieldCheck className="h-3 w-3" />
                          Strict Replay Verified
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-[11px] text-zinc-500">
                      steps={runResult.trace.result.metrics.steps} · mem={runResult.trace.result.metrics.peak_memory_bytes}B ·
                      effects={runResult.trace.result.metrics.effects_count}
                    </span>
                  </div>

                  <div>
                    <div className="mb-1 font-mono text-[11px] uppercase tracking-wider text-zinc-500">Return Value</div>
                    <pre className="overflow-auto rounded-lg bg-zinc-900/90 p-3 font-mono text-xs text-emerald-200">
                      {JSON.stringify(runResult.trace.result.value ?? runResult.trace.result.trap_message, null, 2)}
                    </pre>
                  </div>

                  {runResult.trace.result.final_state &&
                    Object.keys(runResult.trace.result.final_state).length > 0 && (
                      <div>
                        <div className="mb-1 font-mono text-[11px] uppercase tracking-wider text-zinc-500">
                          Atomically Committed State
                        </div>
                        <pre className="overflow-auto rounded-lg bg-zinc-900/90 p-2.5 font-mono text-xs text-amber-200">
                          {JSON.stringify(runResult.trace.result.final_state, null, 2)}
                        </pre>
                      </div>
                    )}

                  {runResult.trace.effects.length > 0 && (
                    <div>
                      <div className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-zinc-500">
                        Normalized Effect Log ({runResult.trace.effects.length})
                      </div>
                      <div className="space-y-1.5">
                        {runResult.trace.effects.map((eff) => (
                          <div
                            key={eff.seq}
                            className="rounded-lg border border-white/[0.06] bg-zinc-900/70 px-3 py-2 font-mono text-[11px]"
                          >
                            <div className="flex items-center justify-between">
                              <span>
                                <span className="text-zinc-500">#{eff.seq}</span>{" "}
                                <span className="font-semibold text-cyan-300">{eff.kind}</span>{" "}
                                <span className="text-zinc-400">{eff.target}</span>
                              </span>
                              <span
                                className={
                                  eff.outcome.status === "ok" ? "text-emerald-300" : "text-red-300"
                                }
                              >
                                {eff.outcome.status === "ok" ? "ok" : `err:${eff.outcome.error?.code}`}
                              </span>
                            </div>
                            {eff.outcome.decision_scores && (
                              <div className="mt-1.5 space-y-1">
                                {Object.entries(eff.outcome.decision_scores).map(([label, prob]) => (
                                  <div key={label} className="flex items-center gap-2">
                                    <span className="w-24 truncate text-zinc-300">{label}</span>
                                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
                                      <div
                                        className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-violet-400"
                                        style={{ width: `${Math.round(prob * 100)}%` }}
                                      />
                                    </div>
                                    <span className="w-12 text-right text-zinc-400">
                                      {(prob * 100).toFixed(1)}%
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Tab 4: Editable Signature Catalog */}
          {activeTab === "catalog" && (
            <div className="flex flex-1 flex-col gap-2">
              <p className="text-xs text-zinc-400">
                Edit the host Signature Catalog to test static capability enforcement (e.g., remove a model profile or fs
                permission and recompile).
              </p>
              <textarea
                value={catalogText}
                onChange={(e) => setCatalogText(e.target.value)}
                rows={15}
                spellCheck={false}
                className="w-full flex-1 rounded-xl border border-white/10 bg-zinc-950 p-3.5 font-mono text-xs leading-5 text-zinc-200 outline-none focus:border-cyan-400/60"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
