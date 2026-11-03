import { Button } from "@music/ui/components/button";
import { Kbd } from "@music/ui/components/kbd";
import { cn } from "@music/ui/lib/utils";
import { ArrowLeftIcon } from "lucide-react";
import { useLayoutEffect } from "react";
import type { ReactNode } from "react";

import { CHORDS, CHORD_LABELS } from "./menu-keys";
import type { ChordActions } from "./menu-keys";

/** Classes for the large artwork at the top of a preview. */
export const previewArt = "size-37 rounded-md shadow-art-preview";

/** Props every preview takes from the menu. */
export interface PreviewProps {
  /** Closes the whole menu, before navigating or once playback starts. */
  readonly onClose: () => void;
  /** Returns from the preview to the list on phones, where only one of them shows. */
  readonly onBack: () => void;
  /** Hands the menu the preview's actions for its chords and footer, or null to clear them. */
  readonly registerActions: (actions: ChordActions | null) => void;
}

const useRegisterActions = (
  registerActions: PreviewProps["registerActions"],
  actions: ChordActions,
): void => {
  useLayoutEffect(() => {
    registerActions(actions);
  });

  useLayoutEffect(() => () => registerActions(null), [registerActions]);
};

/**
 * A preview's buttons, the Enter one solid, each with a keycap for its chord where the menu has a
 * keyboard footer (large screens). Registers them with the menu while shown, so the chords pressed
 * in the search field run them.
 */
export function PreviewActions({
  actions,
  registerActions,
}: {
  readonly actions: ChordActions;
  readonly registerActions: PreviewProps["registerActions"];
}) {
  useRegisterActions(registerActions, actions);

  return (
    <div className="flex flex-wrap gap-2">
      {CHORDS.map((chord) => {
        const action = actions[chord];

        if (action === undefined) return null;

        return (
          <Button
            key={chord}
            variant={chord === "enter" ? "solid" : "secondary"}
            size="sm"
            className={cn(action.icon !== undefined && "pl-3", "lg:pr-2")}
            disabled={action.disabled === true}
            pending={action.pending === true}
            onClick={action.run}
          >
            {action.icon}
            {action.label}
            <Kbd
              aria-hidden
              className="border-current/40 bg-transparent text-current opacity-(--opacity-muted) max-lg:hidden"
            >
              {CHORD_LABELS[chord]}
            </Kbd>
          </Button>
        );
      })}
    </div>
  );
}

/** The preview pane's padded column, with a Back button on phones. */
export function PreviewFrame({
  children,
  onBack,
}: {
  readonly children: ReactNode;
  readonly onBack: () => void;
}) {
  return (
    <div className="flex w-full flex-col gap-4 p-6">
      <button
        type="button"
        onClick={onBack}
        className="flex w-fit items-center gap-1.5 font-sans text-sm/xs font-medium text-text-muted lg:hidden"
      >
        <ArrowLeftIcon className="size-4" />
        Back
      </button>
      {children}
    </div>
  );
}

/** A preview's heading and the line of detail under it. */
export function PreviewTitle({ title, meta }: { readonly title: string; readonly meta: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="font-sans text-xl/xl font-heavy tracking-tight text-text">{title}</h2>
      <span className="font-sans text-base/sm text-text-muted">{meta}</span>
    </div>
  );
}
