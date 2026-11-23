import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import vercel from "@astrojs/vercel";

export default defineConfig({
  adapter: vercel(),
  vite: {
    server: {
      fs: {
        allow: [".."],
      },
    },
  },
  integrations: [
    starlight({
      title: "SPL",
      description:
        "Semantic Prompt Language (.splx) — Strongly-typed, agent-first functional language compiled to ES Module JavaScript.",
      favicon: "/favicon.svg",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/dgawlik/semantic-prompt-language",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/dgawlik/semantic-prompt-language/edit/main/docs/",
      },
      head: [
        {
          tag: "link",
          attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" },
        },
        {
          tag: "link",
          attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: true },
        },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,400..800;1,400..700&family=Share+Tech+Mono&display=swap",
          },
        },
      ],
      customCss: ["./src/styles/custom.css"],
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
            { label: "Interactive Playground", slug: "playground" },
            { label: "CLI & LSP / VS Code", slug: "tooling/cli-and-lsp" },
            { label: "Runnable Examples", slug: "tooling/examples" },
          ],
        },
      ],
    }),
  ],
});
