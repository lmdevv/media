import { describeFailure } from "@media/mobile-core/failure";
import type { Paged } from "@media/mobile-core/pages";
import type { QueryState } from "@media/sdk/react";
import type { LucideIcon } from "lucide-react-native";
import { RotateCcw } from "lucide-react-native";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ActionSheetIOS, ActivityIndicator, View } from "react-native";
import type { ActionSheetIOSOptions } from "react-native";
import type { Href } from "expo-router";

import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { Icon } from "@/components/ui/icon";
import { NavHeader } from "@/components/ui/nav-header";
import { ProgressBar } from "@/components/ui/progress-bar";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";

/** Props for `OwnerScreen`. */
export interface OwnerScreenProps {
  readonly title?: string | undefined;
  readonly trailing?: ReactNode;
  readonly onBack?: (() => void) | undefined;
  /** Where back goes when nothing is under the screen; Owner Settings by default. */
  readonly fallback?: Href;
  readonly back?: boolean;
  readonly children: ReactNode;
}

/** An owner page: back, a title, an optional action, and the scrolling column. */
export function OwnerScreen({
  title,
  trailing,
  onBack,
  fallback = "/owner",
  back = true,
  children,
}: OwnerScreenProps) {
  return (
    <Screen
      readable
      scroll
      edges={["top"]}
      header={
        <NavHeader
          fallback={fallback}
          back={back}
          title={title}
          trailing={trailing}
          onBack={onBack}
        />
      }
      contentClassName="pb-10"
    >
      {children}
    </Screen>
  );
}

/** A 22pt bold heading over a group of rows, such as Recent Scans. */
export function SectionHeading({ children }: { readonly children: string }) {
  return (
    <Text variant="heading" accessibilityRole="header">
      {children}
    </Text>
  );
}

/** The 24pt pause Paper leaves between a list and the action under it. */
export function Spacer() {
  return <View className="h-6" />;
}

/** A query still loading: a spinner where its rows go. */
export function Loading() {
  return <ActivityIndicator className="py-10" colorClassName="accent-text-muted" />;
}

/** Something that failed to load: the line saying why, and Try Again. */
function FailedToLoad({
  message,
  retry,
}: {
  readonly message: string;
  readonly retry: () => void;
}) {
  return (
    <CalmState
      title="Couldn’t Load This"
      description={message}
      actions={<Button label="Try Again" variant="secondary" icon={RotateCcw} onPress={retry} />}
    />
  );
}

/** A query that failed: what went wrong and Try Again. */
function LoadFailure({ error, retry }: { readonly error: unknown; readonly retry: () => void }) {
  return <FailedToLoad message={describeFailure(error)} retry={retry} />;
}

/** Renders a query's rows once it loads, a spinner before, and a failure with Try Again. */
export function QueryView<A>({
  query,
  children,
}: {
  readonly query: QueryState<A>;
  readonly children: (data: A) => ReactNode;
}) {
  if (query.status === "loading") return <Loading />;

  if (query.status === "error") return <LoadFailure error={query.error} retry={query.retry} />;

  return children(query.data);
}

/**
 * Renders a paged list's rows once its first page loads, a spinner before, and a failure with Try
 * Again; under the rows, Show More while more pages follow, or a later page's failure.
 */
export function PagedView<Row>({
  list,
  children,
}: {
  readonly list: Paged<Row>;
  /** Draws the rows; `done` once no page follows them. */
  readonly children: (rows: ReadonlyArray<Row>, done: boolean) => ReactNode;
}) {
  if (list.status === "loading") return <Loading />;

  if (list.status === "failed") return <FailedToLoad message={list.message} retry={list.retry} />;

  const { next } = list;

  return (
    <>
      {children(list.rows, next.kind === "done")}
      {next.kind === "loading" ? <Loading /> : null}
      {next.kind === "more" ? (
        <Button label="Show More" variant="secondary" onPress={next.load} />
      ) : null}
      {next.kind === "failed" ? (
        <>
          <Text variant="meta" tone="danger">
            {next.message}
          </Text>
          <Button label="Try Again" variant="secondary" icon={RotateCcw} onPress={next.retry} />
        </>
      ) : null}
    </>
  );
}

/** A large count such as `42 of 186` or `68%` over the red progress track (I06, J03). */
export function Meter({
  label,
  value,
  accessibilityLabel,
}: {
  readonly label: string;
  readonly value: number;
  readonly accessibilityLabel: string;
}) {
  return (
    <View className="gap-4 pt-8" accessible accessibilityLabel={accessibilityLabel}>
      <Text variant="display">{label}</Text>
      <ProgressBar value={value} />
    </View>
  );
}

function StateBadge({ icon }: { readonly icon: LucideIcon }) {
  return (
    <View className="size-18 items-center justify-center self-center rounded-pill bg-surface">
      <Icon icon={icon} size="badge" />
    </View>
  );
}

/** A centered state inside a page: a badge, a heading, and an optional muted line. */
export function InlineState({
  icon,
  title,
  description,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly description?: string | undefined;
}) {
  return (
    <View className="items-center gap-4 py-6">
      <StateBadge icon={icon} />
      <Text variant="title" className="text-center" accessibilityRole="header">
        {title}
      </Text>
      {description === undefined ? null : (
        <Text tone="muted" className="text-center">
          {description}
        </Text>
      )}
    </View>
  );
}

/** One choice of an action sheet. */
export interface SheetAction {
  readonly label: string;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}

/** Shows the native action sheet with `actions` and Cancel, such as a row's or `…`'s choices. */
export const showActions = (title: string | undefined, actions: ReadonlyArray<SheetAction>) => {
  const options: ActionSheetIOSOptions = {
    title,
    options: [...actions.map((action) => action.label), "Cancel"],
    cancelButtonIndex: actions.length,
    destructiveButtonIndex: actions.flatMap((action, index) =>
      action.destructive === true ? [index] : [],
    ),
  };

  ActionSheetIOS.showActionSheetWithOptions(options, (index) => actions[index]?.onPress());
};

/** The clock, ticking every `everyMs` while mounted, for `Today, 3:12 PM` and live counts. */
export const useNow = (everyMs: number): number => {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);

    return () => clearInterval(timer);
  }, [everyMs]);

  return now;
};
