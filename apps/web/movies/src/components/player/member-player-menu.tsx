import { CommandMenu } from "@media/ui/components/command-menu";
import type { ComponentProps } from "react";

import { useCommandRoot } from "@/commands";
import type { CommandContext } from "@/commands";

export function MemberPlayerMenu({
  context,
  ...props
}: Omit<ComponentProps<typeof CommandMenu>, "root"> & { readonly context: CommandContext }) {
  const root = useCommandRoot(context);

  return <CommandMenu {...props} root={root} />;
}
