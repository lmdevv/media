/**
 * F23 · Password reset link: the one-time link F12 just made, to send privately. The token only
 * lives in this page's route; the server keeps its hash, so leaving loses it.
 */
import type { UserId } from "@music/commands/ids";
import { Key, Lock, Share } from "lucide-react-native";
import { View } from "react-native";

import { copyText, shareLink } from "@/components/settings/clipboard";
import { Headline } from "@/components/settings/headline";
import { ValueField } from "@/components/settings/value-field";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { resetLink } from "@/lib/links";
import { personName } from "@/lib/people";
import { until } from "@/lib/when";
import { useConnection } from "@/session/connection";

import { usePerson } from "./data";
import { NavGlyph } from "@/components/settings/nav-glyph";
import { useResetLink } from "./params";
import { useFlash } from "@/components/settings/use-flash";
import { useNow } from "@/components/settings/use-now";

/** A reset link for someone, ready to share. */
export function ResetLinkPage({ id }: { readonly id: UserId | null }) {
  const { origin } = useConnection();
  const person = usePerson(id);
  const made = useResetLink();
  const now = useNow(60_000);
  const [copied, flashCopied] = useFlash();
  const left = made === null ? null : until(made.expiresAt, now);
  const name = person === undefined || person === null ? "them" : personName(person);

  return (
    <Page title="Password reset link" bottom="plain" trailing={<NavGlyph icon={Key} />}>
      {made === null || left === null ? (
        <EmptyState
          icon={Key}
          title={"This link\nhas expired."}
          body={"Make a new one from\ntheir page in People."}
        />
      ) : (
        <ResetLinkBody
          link={resetLink(origin, made.token)}
          name={name}
          left={left}
          copied={copied}
          onCopied={flashCopied}
        />
      )}
    </Page>
  );
}

/** Props for `ResetLinkBody`. */
interface ResetLinkBodyProps {
  readonly link: string;
  readonly name: string;
  /** How long until it expires: `in 24 hours`. */
  readonly left: string;
  readonly copied: boolean;
  readonly onCopied: () => void;
}

function ResetLinkBody({ link, name, left, copied, onCopied }: ResetLinkBodyProps) {
  return (
    <>
      <Headline top="loose">A way back in.</Headline>
      <ValueField label={`One-time link for ${name}`} value={link} helper={`Expires ${left}.`} />
      <View className="pt-2">
        <Notice
          icon={Lock}
          title="Share privately"
          body={`Anyone with this link can set a new password for ${name}. It works once.`}
        />
      </View>
      <View className="pt-6">
        <Button
          label={copied ? "Copied" : "Copy reset link"}
          icon={Share}
          onPress={() => void copyText(link).then(onCopied)}
        />
      </View>
      <View className="pt-3">
        <Button label="Share link" variant="secondary" onPress={() => void shareLink(link)} />
      </View>
    </>
  );
}
