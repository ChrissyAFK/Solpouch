import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Solpouch",
  description: "Budget pouches your AI shops from, and can't refill.",
};

const navCls = "inline-flex min-h-12 items-center rounded-lg px-4 text-lg font-bold text-white hover:bg-slate-700 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-400";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="bg-slate-900">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-3">
            <Link href="/" className="text-2xl font-extrabold text-white">Solpouch</Link>
            <nav aria-label="Main" className="flex gap-2">
              <Link href="/" className={navCls}>Pouches</Link>
              <Link href="/order" className={navCls}>New order</Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
