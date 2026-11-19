import { Button } from "@/components/ui/button";

/** A failed server read that the guest can retry without leaving the share. */
export function UnreachableScreen({ retry }: { readonly retry: () => void }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-bg px-6 text-text">
      <h1 className="font-sans text-xl/xl font-heavy tracking-tight">Can't reach the server</h1>
      <Button variant="solid" onClick={retry}>
        Try again
      </Button>
    </main>
  );
}
