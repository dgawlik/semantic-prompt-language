"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight, Sparkles, Terminal } from "lucide-react";

export function Navbar() {
  const pathname = usePathname();

  const navLinks = [
    { href: "/", label: "Overview" },
    { href: "/docs", label: "Docs" },
    { href: "/docs#translator", label: "Translator" },
    { href: "/docs#bytecode", label: "SPLB 5" },
    { href: "/docs#cli", label: "CLI" },
  ];

  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.08] bg-zinc-950/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <Link href="/" className="group flex items-center gap-3">
          <div className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-400 via-sky-400 to-violet-500 p-[1px] shadow-lg shadow-cyan-500/20">
            <div className="flex h-full w-full items-center justify-center rounded-[7px] bg-zinc-950 font-mono text-xs font-bold text-cyan-300 transition group-hover:bg-zinc-900">
              S5
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold tracking-tight text-white">SPL</span>
            <span className="rounded-full border border-cyan-400/25 bg-cyan-400/10 px-2 py-0.5 font-mono text-[10px] font-medium text-cyan-300">
              v5.0
            </span>
          </div>
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {navLinks.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname === "/docs" && item.href === "/docs";
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-md px-3 py-1.5 text-sm transition ${
                  active
                    ? "bg-white/[0.08] font-medium text-white"
                    : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2.5">
          <Link
            href="/docs#cli"
            className="hidden items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-white/20 hover:bg-white/[0.06] hover:text-white sm:inline-flex"
          >
            <Terminal className="h-3.5 w-3.5 text-zinc-400" />
            CLI
          </Link>
          <Link
            href="/docs#translator"
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-400 to-violet-400 px-3.5 py-1.5 text-xs font-semibold text-zinc-950 shadow-lg shadow-cyan-500/20 transition hover:brightness-110"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Translate Prose
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </header>
  );
}
