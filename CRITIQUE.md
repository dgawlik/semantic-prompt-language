## Critique

1. **No customer.** The headline in `Introduction.md` is "Build AI workflows in minutes, not hours". The README's hero example, `generate-presentation.md`, is six strings and one `agent` call, which a plain prompt file already does. This repo's own `.github/skills` folder shows the status quo: Markdown that coding agents already run.
2. **A language tax with no ecosystem.** "Python-like but not Python" means people relearn it and LLMs cannot write it. The VS Code extension already ships a Copilot context provider to stop suggestions coming out as Python. Real work goes through `shell`, which is `cmd.exe` on Windows and `/bin/sh` elsewhere.
3. **The defaults undercut the safety pitch.** `Safety.md` says tools are allowed outside `restrict`. In the triage and invoice examples in `Examples.md`, the agent reads untrusted text with only a `forbid` hint. Per the docs it still holds `shell`, `write_file` and `web_fetch`, which is a prompt-injection path. I inferred this from the docs and did not run an exploit.
4. **Instability.** There have been 37 releases in 25 days, and version 1.17 carries breaking syntax changes. The docs have 28 lines about removed or legacy behaviour, and there is no LICENSE, CHANGELOG or git tag.
5. **The docs contradict themselves on replay.** `Getting-started.md` says tool calls "still run during replay"; `CLI.md` says replay never repeats them.
6. **The first run fails.** The README says `npm install -g spl-lang` then `spl examples/hi.md`, but the published 1.17.0 package contains no examples. The Introduction's notes under `hi.md` also describe `assert`, `restrict` and `success`, none of which appear in it.

## Three fixes

1. **Deny by default.** Agent steps get no shell, write or network access unless granted. `--check` prints each step's effective permissions and flags agents that read external input.
2. **Rebuild the front door around one user and freeze the language.** I would pick engineers adding LLM checks to CI. Lead with the code-review or invoice example, ship `spl init` with bundled examples, add a LICENSE, and move legacy notes into a CHANGELOG.
3. **Add `spl test`.** Replay recorded traces as offline tests, with mocked answers per step and a pass rate over live samples. Jac and Dippin can both tell you whether a prompt edit broke something; SPL cannot.

## Three pivots

1. **Drop the syntax and ship the runtime as a TypeScript library.** The embedding API (`run`, `AiBackend`, `Trace`) is most of it already. The market is crowded, but permission scopes plus replay in a small local-first library is a distinct position.
2. **Become the guardrail layer for Markdown agent files people already write.** Run existing skill and prompt files with permission frontmatter, fenced assertions and a replayable trace. This uses the incumbents' distribution instead of competing with it.
3. **Sell a product: custom LLM checks for CI.** A GitHub Action where teams write rules such as "fail if a migration lacks a rollback", with assertions, approval and stored evidence. SPL becomes the config format. Avoid generic code review, which is saturated.

I would do fixes 1 and 2 now, then test pivot 3, because it is the only option with an obvious buyer.

## Before writing more code

- **Riskiest assumption:** people want a new language, not checked LLM steps in the language they already use. Give five engineers the invoice workflow in SPL and as a short TypeScript script, and count which they keep.
- **Interviews:** talk to ten people who run LLM steps in CI and ask what broke last month.
- **Activation:** measure how many installers complete a run within ten minutes.

I could not determine whether any real users exist, whether you intend to monetize, or the VS Code extension's install count.

`/product-owner-grill` did not resolve through the skill loader, so I applied it from `SKILL.md`. I gave the full report you asked for, not its question-by-question format.