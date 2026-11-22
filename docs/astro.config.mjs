import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const splxGrammar = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../editors/vscode/syntaxes/splx.tmLanguage.json"), "utf8")
);
splxGrammar.name = "splx";
splxGrammar.aliases = ["spl"];

export default defineConfig({
  integrations: [
    starlight({
      title: "SPL",
      description:
        "Semantic Prompt Language (.splx) — Strongly-typed, agent-first functional language compiled to ES Module JavaScript.",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/custom.css"],
      expressiveCode: {
        shiki: {
          langs: [splxGrammar],
        },
      },
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Installation & CLI", slug: "getting-started/installation" },
            { label: "Quick Tour", slug: "getting-started/quick-tour" },
          ],
        },
        {
          label: "Language Guide",
          items: [
            { label: "Basics, Operators & Casts", slug: "language/basics" },
            { label: "Functions, Mutability & TCO", slug: "language/functions-and-tco" },
            { label: "Records & Row Polymorphism", slug: "language/records-and-rows" },
            { label: "Enums, Matching & Errors", slug: "language/enums-and-errors" },
            { label: "Traits, Extensions & Modules", slug: "language/traits-and-modules" },
            { label: "Prompts, Schemas & Reified Types", slug: "language/prompts-and-reification" },
            { label: "Colorless Async & Concurrency", slug: "language/async" },
          ],
        },
        {
          label: "Standard Library",
          items: [
            { label: "LLM & Agents (std/llm & std/traces)", slug: "stdlib/llm-and-agents" },
            { label: "Dynamic Codegen (std/codegen)", slug: "stdlib/codegen" },
            { label: "Collections & Iterators (std/collections)", slug: "stdlib/collections" },
            { label: "Files, Shell & Host I/O", slug: "stdlib/files-and-shell" },
          ],
        },
        {
          label: "Tooling & Examples",
          items: [
            { label: "CLI & LSP / VS Code", slug: "tooling/cli-and-lsp" },
            { label: "Runnable Examples", slug: "tooling/examples" },
          ],
        },
      ],
    }),
  ],
});
