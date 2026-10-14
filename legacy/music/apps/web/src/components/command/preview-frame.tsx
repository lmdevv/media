import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

/** Classes for the large artwork at the top of a preview. */
export const previewArt = "size-37 rounded-md shadow-art-preview";

/** Props every preview takes from the menu. */
export interface PreviewProps {
  /** Closes the whole menu, before navigating or once playback starts. */
  readonly onClose: () => void;
  /** Returns from the preview to the list on phones, where only one of them shows. */
  readonly onBack: () => void;
  /** Hands the menu the preview's primary action for Enter and the footer, or null to clear it. */
  readonly registerPrimary: (run: (() => void) | null) => void;
}

/** Registers the preview's primary action for Enter and the footer while it is shown. */
export const usePrimary = (
  registerPrimary: PreviewProps["registerPrimary"],
  run: () => void,
): void => {
  const latest = useRef(run);

  latest.current = run;

  useEffect(() => {
    registerPrimary(() => latest.current());

    return () => registerPrimary(null);
  }, [registerPrimary]);
};

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
