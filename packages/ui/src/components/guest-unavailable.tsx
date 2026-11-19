import type { ComponentProps, ComponentType } from "react";
import { Button } from "./button";

const LeaveButton = (props: ComponentProps<"button">) => <Button variant="secondary" {...props} />;

export function GuestUnavailable({
  onLeave,
  Button: Action = LeaveButton,
}: {
  readonly onLeave?: (() => Promise<void>) | undefined;
  readonly Button?: ComponentType<ComponentProps<"button">>;
}) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-5 bg-page px-5 text-text">
      <h1 className="text-title/title font-bold tracking-display">This link isn't available</h1>
      {onLeave === undefined ? null : (
        <Action
          onClick={() => {
            void onLeave().catch(() => undefined);
          }}
        >
          Leave
        </Action>
      )}
    </main>
  );
}
