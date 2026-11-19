import { Button } from "./button";

export function GuestUnavailable({
  onLeave,
}: {
  readonly onLeave?: (() => Promise<void>) | undefined;
}) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-5 bg-page px-5 text-text">
      <h1 className="text-title/title font-bold tracking-display">This link isn't available</h1>
      {onLeave === undefined ? null : (
        <Button
          variant="secondary"
          onClick={() => {
            void onLeave().catch(() => undefined);
          }}
        >
          Leave
        </Button>
      )}
    </main>
  );
}
