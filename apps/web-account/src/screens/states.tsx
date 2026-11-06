import { Button } from "@media/ui/components/button";

import { AuthPage, Lede, PageTitle } from "@/components/auth-page";

/** The empty page canvas shown while the gate waits for the server or the session. */
export function BlankPage() {
  return <div aria-busy className="min-h-svh bg-page" />;
}

/** The server did not answer. */
export function UnreachableScreen({ retry }: { readonly retry: () => void }) {
  return (
    <AuthPage>
      <div className="flex flex-col gap-3">
        <PageTitle>Can't reach the server.</PageTitle>
        <Lede>Check the connection, then try again.</Lede>
      </div>
      <Button size="lg" className="w-full" onClick={retry}>
        Try again
      </Button>
    </AuthPage>
  );
}
