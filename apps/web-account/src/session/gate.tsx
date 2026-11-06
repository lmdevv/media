import { usePlatform, usePlatformQuery, usePlatformStatus } from "@media/sdk/react";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { Brand, Match } from "effect";
import { useEffect } from "react";
import type { ReactNode } from "react";

import { NeedsAccountScreen } from "@/screens/needs-account";
import { PersonalPickerScreen } from "@/screens/personal-picker";
import { SetUpOwnerScreen } from "@/screens/set-up-owner";
import { SharedPickerScreen } from "@/screens/shared-picker";
import { SignInScreen } from "@/screens/sign-in";
import { TileLockScreen } from "@/screens/tile-lock";
import { BlankPage, UnreachableScreen } from "@/screens/states";

import { useAccountStore, useOrigin, useSlot } from "./account";
import { MeContext } from "./me";
import { deviceUnknown, isRenewing, screenOf } from "./screen";
import type { Intent, Need, Screen, ScreenInputs } from "./screen";
import type { UserId } from "./platform-types";

const NEEDS: ReadonlyArray<Need> = ["public", "anyone", "account", "admin"];

/** The most a page's routes need together; a route that names none needs a sign-in. */
const strictest = (needs: ReadonlyArray<Need | undefined>): Need =>
  needs.reduce<Need>(
    (most, need) => (need !== undefined && NEEDS.indexOf(need) > NEEDS.indexOf(most) ? need : most),
    needs.includes("public") ? "public" : "anyone",
  );

const useIntent = (): Intent => {
  const route = useRouterState({
    select: (state) => {
      const match = state.matches.at(-1);
      const params: Readonly<Record<string, string>> = match?.params ?? {};

      return {
        intent: match?.staticData.intent,
        userId: params["userId"],
        need: strictest(state.matches.map((each) => each.staticData.need)),
      };
    },
    structuralSharing: true,
  });

  if (route.intent === "picker") return { kind: "picker" };

  if (route.intent === "add") return { kind: "add" };

  if (route.intent === "tile" && route.userId !== undefined) {
    return { kind: "tile", userId: Brand.nominal<UserId>()(route.userId) };
  }

  return { kind: "page", need: route.need };
};

/** Forgets this browser's device code once the core says it no longer knows the device. */
const useForgetUnknownDevice = (inputs: ScreenInputs): void => {
  const store = useAccountStore();
  const unknown = deviceUnknown(inputs);

  useEffect(() => {
    if (unknown) store.clearDevice();
  }, [unknown, store]);
};

const ASK_AGAIN_MS = 1000;

/**
 * Asks who is signed in again after the server refused the session while the client still holds
 * one: the session was renewed, or a tile opened on this shared device replaced it. A session that
 * really ended fails its renewal, and the status turns signed out instead.
 */
const useAskAgain = (me: ScreenInputs["me"]): void => {
  useEffect(() => {
    const timer =
      me.status === "error" && isRenewing(me.error)
        ? setTimeout(me.retry, ASK_AGAIN_MS)
        : undefined;

    return () => clearTimeout(timer);
  }, [me]);
};

const render: (screen: Screen) => ReactNode = Match.type<Screen>().pipe(
  Match.discriminatorsExhaustive("kind")({
    loading: () => <BlankPage />,
    unreachable: ({ retry }) => <UnreachableScreen retry={retry} />,
    setUpOwner: () => <SetUpOwnerScreen />,
    signIn: ({ adding }) => <SignInScreen adding={adding} />,
    personalPicker: ({ tiles }) => <PersonalPickerScreen tiles={tiles} />,
    sharedPicker: ({ picker }) => <SharedPickerScreen picker={picker} />,
    tileLock: ({ picker, tile, approval }) => (
      <TileLockScreen picker={picker} tile={tile} approval={approval} />
    ),
    needsAccount: ({ me }) => <NeedsAccountScreen me={me} admin={false} />,
    needsAdmin: ({ me }) => <NeedsAccountScreen me={me} admin />,
    page: ({ me }) => (
      <MeContext value={me}>
        <Outlet />
      </MeContext>
    ),
  }),
);

/** Decides from the server, the session, and this browser which screen shows, and shows it. */
export function Gate() {
  const platform = usePlatform();
  const status = usePlatformStatus();
  const origin = useOrigin();
  const slot = useSlot();
  const intent = useIntent();

  const server = usePlatformQuery(platform.core.server.info);

  const me = usePlatformQuery(
    platform.core.auth.sessions.current,
    ...(status === "signedIn" ? [] : (["skip"] as const)),
  );

  const picker = usePlatformQuery(
    platform.core.devices.picker.show,
    ...(origin.device === null ? (["skip"] as const) : [{ device: origin.device }]),
  );

  const inputs: ScreenInputs = {
    intent,
    server,
    status,
    me,
    device: origin.device,
    picker,
    held: new Set(origin.people.keys()),
    slotHeld: [...origin.people.values()].includes(slot),
  };

  useForgetUnknownDevice(inputs);
  useAskAgain(me);

  return render(screenOf(inputs));
}
