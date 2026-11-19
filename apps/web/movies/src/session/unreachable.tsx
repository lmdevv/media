import { Button } from "@media/ui/components/button";

/** The page when the server can't confirm who is signed in; `retry` asks again. */
export function UnreachableScreen({ retry }: { readonly retry: () => void }) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-5 bg-page text-text">
      <h1 className="text-title/title font-bold">Can't reach the server</h1>
      <Button onClick={retry}>Try again</Button>
    </main>
  );
}
