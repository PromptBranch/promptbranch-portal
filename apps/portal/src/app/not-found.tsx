import { Topbar } from "@/components/topbar";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col">
      <Topbar />
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center px-6 text-center">
        <p className="text-5xl font-semibold text-ink-faint">404</p>
        <h1 className="mt-4 text-xl font-semibold text-ink">Snapshot not found</h1>
        <p className="mt-2 text-ink-dim">
          This link does not point at a shared prompt. Check that you copied the
          whole URL.
        </p>
      </main>
    </div>
  );
}
