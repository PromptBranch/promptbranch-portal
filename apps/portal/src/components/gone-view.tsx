import { Topbar } from "@/components/topbar";

export function GoneView() {
  return (
    <div className="flex min-h-screen flex-col">
      <Topbar />
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center px-6 text-center">
        <p className="text-5xl font-semibold text-ink-faint">410</p>
        <h1 className="mt-4 text-xl font-semibold text-ink">This snapshot was deleted</h1>
        <p className="mt-2 text-ink-dim">
          The publisher revoked this share. The link is permanently gone.
        </p>
      </main>
    </div>
  );
}
