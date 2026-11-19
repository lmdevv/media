import { Redacted } from "effect";
import type { ComponentProps, ComponentType, ReactNode } from "react";

import { useGuestLinks } from "@media/ui/lib/use-guest-links";
import type { GuestLinksModel } from "@media/ui/lib/use-guest-links";
import type { GuestTarget } from "@media/ui/lib/guest-links";

/** Actions use each app's button styles. */
export type GuestLinkButtonProps = ComponentProps<"button"> & {
  readonly tone: "primary" | "secondary" | "danger";
};

type GuestLinkInputProps = Pick<
  ComponentProps<"input">,
  "type" | "min" | "max" | "step" | "required" | "value" | "onChange" | "readOnly" | "onFocus"
>;

interface GuestLinksFormProps {
  readonly target: GuestTarget;
  readonly Button: ComponentType<GuestLinkButtonProps>;
  readonly Input: ComponentType<GuestLinkInputProps>;
  readonly children: (form: ReactNode, pending: boolean) => ReactNode;
}

/** Keeps each target's form separate and passes pending create or revoke state to its dialog. */
export function GuestLinksForm(props: GuestLinksFormProps) {
  return <GuestLinksSession key={JSON.stringify(props.target)} {...props} />;
}

function GuestLinksSession({ target, Button, Input, children }: GuestLinksFormProps) {
  const model = useGuestLinks(target);

  return children(<GuestLinksFields model={model} Button={Button} Input={Input} />, model.pending);
}

/** Fields use each app's controls and never recover a secret from list metadata. */
export function GuestLinksFields({
  model,
  Button,
  Input,
}: {
  readonly model: GuestLinksModel;
  readonly Button: ComponentType<GuestLinkButtonProps>;
  readonly Input: ComponentType<GuestLinkInputProps>;
}) {
  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void model.create();
        }}
      >
        <label className="flex flex-col gap-2">
          <span>Expires in days</span>
          <Input
            type="number"
            min={1}
            max={30}
            step={1}
            required
            value={model.expiry}
            onChange={(event) => model.setExpiry(event.target.value)}
          />
        </label>
        <div>
          <Button
            tone="primary"
            type="submit"
            disabled={model.pending || model.made || model.days === null}
          >
            Create link
          </Button>
        </div>
      </form>
      {model.created === null ? null : (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-2">
            <span>New guest link</span>
            <Input
              data-sensitive="guest-link"
              readOnly
              value={Redacted.value(model.created)}
              onFocus={(event) => event.target.select()}
            />
          </label>
          <p className="text-text-muted">This link cannot be shown again.</p>
          <div>
            <Button tone="secondary" type="button" onClick={() => void model.copy()}>
              {model.copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}
      <section aria-label="Your guest links" className="flex flex-col gap-3">
        <h3 className="font-semibold">Your guest links</h3>
        {model.rows.length === 0 && !model.loading && model.failure === null ? (
          <p className="text-text-muted">No guest links yet.</p>
        ) : null}
        <ul className="flex flex-col gap-3">
          {model.rows.map((row) => (
            <li key={row.linkId} className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <span className="capitalize">{row.state}</span>
                <p className="text-text-muted">
                  Expires {new Date(row.expiresAt).toLocaleString()}
                </p>
              </div>
              {row.state === "open" ? (
                <Button
                  tone="danger"
                  type="button"
                  disabled={model.pending}
                  onClick={() => void model.revoke(row.linkId)}
                >
                  Revoke
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {model.loading ? (
          <p role="status" className="text-text-muted">
            Loading links…
          </p>
        ) : null}
        {model.failure === null ? null : (
          <div role="alert">
            <p>{model.failure.message}</p>
            <Button tone="secondary" type="button" onClick={model.failure.retry}>
              Try again
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
