/**
 * D07 · a Jam link opened signed out. When the server allows guest accounts, a name and a password
 * make one that only works for this Jam: signing up puts the guest in the Jam, and once the app
 * opens it joins on this iPhone (D06 or D08). Otherwise, or to use an account, Sign in instead;
 * the link opens again once signed in (D05). A link that can't be joined says why (G11, G12).
 */
import { useAuthActions } from "@convex-dev/auth/react";
import { jamPreview } from "@music/sdk/functions";
import { useQuery } from "convex/react";
import * as Crypto from "expo-crypto";
import { router, useLocalSearchParams } from "expo-router";
import { Users } from "lucide-react-native";
import { useRef, useState } from "react";
import type { ComponentRef } from "react";
import { View } from "react-native";
import type { TextInput } from "react-native";

import { useHoldJamForSignIn } from "@/components/entry/entry-links";
import { jamNavGlyph } from "@/components/jams/jam-home";
import { JamUnavailable, unavailableOf } from "@/components/jams/jam-unavailable";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { accountFailureLine, passwordProblem } from "@/lib/account-form";
import { guestEmail } from "@/lib/jam";

/** Back to Sign in, keeping the link to open once signed in. */
const useSignInInstead = (code: string) => {
  const { holdForSignIn } = useHoldJamForSignIn();

  return () => {
    holdForSignIn({ kind: "jam", secret: code, server: null }, "invite");

    if (router.canGoBack()) router.back();
    else router.replace("/sign-in");
  };
};

/** A random suffix for the guest's made-up sign-in address. */
const randomSuffix = (): string =>
  Array.from(Crypto.getRandomBytes(4), (byte) => byte.toString(36).padStart(2, "0")).join("");

/** The guest account form. */
function GuestForm({ code, host }: { readonly code: string; readonly host: string }) {
  const { signIn } = useAuthActions();
  const { holdForSignIn, drop } = useHoldJamForSignIn();
  const signInInstead = useSignInInstead(code);
  const passwordField = useRef<ComponentRef<typeof TextInput>>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const complete = name.trim() !== "" && password !== "";

  const submit = async () => {
    const problem = passwordProblem(password);

    if (problem !== null) {
      setFailure(problem);

      return;
    }

    setPending(true);
    setFailure(null);
    // Signing up moves the app to the signed-in stack, which then opens the Jam to join it here.
    holdForSignIn({ kind: "jam", secret: code, server: null }, "join");

    try {
      await signIn("password", {
        name: name.trim(),
        email: guestEmail(name, randomSuffix()),
        password,
        jamCode: code,
        flow: "signUp",
      });
    } catch (cause) {
      drop();
      setFailure(accountFailureLine(cause));
      setPending(false);
    }
  };

  return (
    <Page title={`Join ${host}’s Jam`} bottom="plain" trailing={jamNavGlyph}>
      <Notice
        icon={Users}
        title="Just here for the music?"
        body="Create a guest account. It only works for the Jam and is removed when it ends."
      />
      <Field
        label="Your name"
        value={name}
        onChangeText={setName}
        textContentType="name"
        autoComplete="name"
        autoCapitalize="words"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => passwordField.current?.focus()}
      />
      <Field
        ref={passwordField}
        label="Choose a password"
        helper="At least 8 characters."
        value={password}
        onChangeText={(text) => {
          setPassword(text);
          setFailure(null);
        }}
        secureTextEntry
        textContentType="newPassword"
        autoComplete="new-password"
        returnKeyType="go"
        error={failure}
        onSubmitEditing={() => {
          if (complete) void submit();
        }}
      />
      <View className="pt-6">
        <Button
          label="Create guest account"
          pendingLabel="Joining…"
          pending={pending}
          disabled={!complete}
          onPress={() => void submit()}
        />
      </View>
      <View className="pt-4">
        <Button label="Sign in instead" variant="secondary" onPress={signInInstead} />
      </View>
    </Page>
  );
}

/** No guest accounts on this server: sign in to join. */
function SignInToJoin({ code, host }: { readonly code: string; readonly host: string }) {
  const signInInstead = useSignInInstead(code);

  return (
    <Page title={`Join ${host}’s Jam`} bottom="plain" trailing={jamNavGlyph}>
      <Notice
        icon={Users}
        title="Sign in to join"
        body={`Use your account on this server. ${host}’s Jam opens once you’re signed in.`}
      />
      <View className="pt-6">
        <Button label="Sign in" onPress={signInInstead} />
      </View>
    </Page>
  );
}

export default function JamGuest() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const preview = useQuery(jamPreview, { code });

  if (preview === undefined) {
    return (
      <Page title="Join a Jam" bottom="plain" trailing={jamNavGlyph}>
        {null}
      </Page>
    );
  }

  if (preview.state === "invalid" || preview.state === "ended") {
    return <JamUnavailable state={preview.state} hostName="" signedIn={false} />;
  }

  const unavailable = unavailableOf(preview);

  if (unavailable !== null) {
    return <JamUnavailable state={unavailable} hostName={preview.hostName} signedIn={false} />;
  }

  return preview.guestAccounts ? (
    <GuestForm code={code} host={preview.hostName} />
  ) : (
    <SignInToJoin code={code} host={preview.hostName} />
  );
}
