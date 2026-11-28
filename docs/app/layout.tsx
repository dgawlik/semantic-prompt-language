import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Navbar } from "@/components/Navbar";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "SPL v5 — Semantic Prompt Language",
  description:
    "Compile natural-language instructions via OpenAI Lark CFG into statically typed, canonical SPLB 5 bytecode and execute on a deterministic stack VM.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} dark`}>
      <body className="min-h-screen antialiased selection:bg-cyan-500/30 selection:text-cyan-100">
        <Navbar />
        <main>{children}</main>
        <footer className="border-t border-white/10 bg-zinc-950/90 py-10 text-sm text-zinc-500">
          <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-6 sm:flex-row">
            <div className="flex items-center gap-2.5">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-cyan-400 to-violet-500 font-mono text-xs font-bold text-zinc-950">
                S5
              </span>
              <span className="font-medium text-zinc-300">Semantic Prompt Language v5</span>
              <span className="text-zinc-600">·</span>
              <span>SPLB 5 Deterministic Stack VM</span>
            </div>
            <div className="flex items-center gap-5 text-xs text-zinc-400">
              <a href="/docs" className="transition hover:text-white">
                Documentation
              </a>
              <a href="/docs#translator" className="transition hover:text-white">
                Interactive Translator
              </a>
              <a href="/docs#bytecode" className="transition hover:text-white">
                Bytecode Spec
              </a>
              <a href="/docs#cli" className="transition hover:text-white">
                CLI
              </a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
