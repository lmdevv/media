import type { Scope } from "@media/contracts/scopes";
import { Badge } from "@media/ui/components/badge";
import { cn } from "@media/ui/lib/utils";

function ScopeBadge({ scope }: { readonly scope: Scope }) {
  return (
    <Badge className={cn("rounded-poster", scope === "admin" ? "text-warning" : "text-text")}>
      {scope}
    </Badge>
  );
}

/** A row of {@link ScopeBadge}s. */
export function ScopeBadges({
  scopes,
  className,
}: {
  readonly scopes: ReadonlyArray<Scope>;
  readonly className?: string;
}) {
  return (
    <span className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {scopes.map((scope) => (
        <ScopeBadge key={scope} scope={scope} />
      ))}
    </span>
  );
}
