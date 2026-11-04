import { cn } from "@media/ui/lib/utils";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { copyText } from "@/lib/secure-context";

const COPIED_MS = 2000;

/**
 * A one-line mono value with a Copy button at its end, for a new API key or an invite link. The
 * value is selectable so it can be copied by hand when the clipboard is unavailable.
 *
 * @param emphasis - `light` is the white button of Key created; `accent` is the red one of Users.
 */
export function CopyField({
  value,
  label,
  emphasis = "light",
  className,
}: {
  readonly value: string;
  /** Accessible name of the value, such as `New API key`. */
  readonly label: string;
  readonly emphasis?: "light" | "accent";
  readonly className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return () => undefined;

    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);

    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async (): Promise<void> => {
    try {
      await copyText(value);
      setCopied(true);
    } catch {
      toast.error("Couldn’t copy. Select it and copy it yourself.");
    }
  };

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-3 rounded-control border border-hairline bg-bg pl-3.5",
        emphasis === "light" ? "h-13 pr-1.5" : "h-9 pr-0.5",
        className,
      )}
    >
      <output
        aria-label={label}
        className={cn(
          "min-w-0 flex-1 truncate font-mono text-text select-all",
          emphasis === "light" ? "text-body/body" : "text-label/label",
        )}
      >
        {value}
      </output>
      <button
        type="button"
        onClick={() => void copy()}
        className={cn(
          "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-control font-sans text-label/label font-bold transition-colors",
          emphasis === "light"
            ? "h-10 bg-text px-3.5 text-bg hover:bg-text/85"
            : "h-8 bg-accent px-2.5 font-semibold text-on-accent hover:bg-accent-pressed",
        )}
      >
        {copied ? (
          <CheckIcon className="size-3.5" strokeWidth={2} aria-hidden />
        ) : (
          <CopyIcon className="size-3.5" strokeWidth={2} aria-hidden />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
