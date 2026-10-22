/**
 * A command's form (F27), generated from its registry schema: one control per field kind, never
 * per command. Run decodes the form with the command's own argument schema and sends it through
 * the SDK, the same path for every mutation, then opens the result (F28).
 */
import { argsDecoder } from "@music/commands/codec";
import { missingFields, outcomeOf } from "@music/commands/forms";
import type { FieldSpec, FormValues } from "@music/commands/forms";
import type { Role } from "@music/commands/models";
import { capabilityLabel } from "@music/commands/permissions";
import { commands, isCommandName } from "@music/commands/registry";
import { makeMusicClient } from "@music/sdk/client";
import { errorMessage } from "@music/sdk/errors";
import { useRead } from "@music/sdk/react";
import { useConvex } from "convex/react";
import { Result } from "effect";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Lock, Play } from "lucide-react-native";
import { useState } from "react";
import { AccessibilityInfo, View } from "react-native";

import { Button } from "@/components/ui/button";
import { ChipGroup } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { SectionHeader } from "@/components/ui/section-header";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import {
  actionTitle,
  editField,
  formArgs,
  outcomeSecret,
  choiceLabel,
  formDefaults,
  missingMessage,
  resultParams,
  selectedIds,
} from "@/lib/actions";
import type { Action } from "@/lib/actions";

import { CommandGlyph } from "./command-glyph";
import { GROUP_ICON } from "./group-icon";
import { holdSecret } from "@/components/settings/secret-slot";
import { PICKERS } from "./pickers";
import { useOffered } from "./use-offered";

/**
 * The chip that leaves an optional choice unset, so the server's default applies. It is the empty
 * text an unset field reads as, so an unset choice shows it selected.
 */
const DEFAULT_CHOICE = "";

/**
 * The form for the command named in the route, if this person may run it now. A name that isn't a
 * command, or one their role or the playback state rules out, gets an explanation instead.
 */
export function ActionFormScreen({ command }: { readonly command: string }) {
  const offered = useOffered();
  const name = isCommandName(command) ? command : null;
  const title = name === null ? "Action" : actionTitle(commands[name].summary);
  const action = offered?.offered.find((entry) => entry.name === name);

  if (offered !== undefined && action !== undefined)
    return <ActionForm key={action.name} action={action} role={offered.me.role} />;

  return (
    <Page title={title} bottom="plain" trailing={<CommandGlyph />}>
      {offered === undefined ? null : (
        <EmptyState
          icon={Lock}
          title="This action isn’t available."
          body="It may need another role, or something playing."
          primary={
            <Button label="Back to Actions" onPress={() => router.dismissTo("/settings/actions")} />
          }
        />
      )}
    </Page>
  );
}

/** A thrown value as the message the form shows. */
const failureText = (cause: unknown): string =>
  errorMessage(cause instanceof Error ? cause : new Error(String(cause)));

function ActionForm({ action, role }: { readonly action: Action; readonly role: Role }) {
  const { name, fields } = action;
  const command = commands[name];
  const convex = useConvex();
  const libraries = useRead("libraries.list", name === "libraries.scan" ? {} : "skip");
  // Only fields the person changed are kept; the rest follow defaults that load later.
  const [edits, setEdits] = useState<FormValues>({});
  const values: FormValues = { ...formDefaults(name, fields, libraries), ...edits };
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const fail = (message: string) => {
    setError(message);
    AccessibilityInfo.announceForAccessibility(message);
  };

  const run = async () => {
    const missing = missingFields(fields, values);

    if (missing.length > 0) return fail(missingMessage(missing));

    const decoded = argsDecoder(name)(formArgs(fields, values));

    if (Result.isFailure(decoded)) return fail(`Check the fields: ${decoded.failure.message}`);

    setPending(true);
    setError(null);

    try {
      const outcome = outcomeOf(await makeMusicClient(convex).run(name, decoded.success));

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      const secret = outcomeSecret(outcome);

      if (secret !== null) holdSecret(secret);

      router.push({
        pathname: "/settings/actions/[command]/result",
        params: { command: name, ...resultParams(outcome) },
      });
    } catch (cause) {
      fail(failureText(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Page title={actionTitle(command.summary)} bottom="plain" trailing={<CommandGlyph />}>
      <Notice
        icon={GROUP_ICON[command.group]}
        title={name}
        body={`${command.summary}. Who can run it: ${capabilityLabel(command.access)}.`}
      />
      {fields.map((spec) => (
        <FieldInput
          key={spec.name}
          spec={spec}
          values={values}
          role={role}
          onChange={(value) => setEdits((current) => editField(fields, current, spec.name, value))}
        />
      ))}
      {error === null ? null : (
        <Text
          variant="calloutMedium"
          tone="danger"
          className="pt-4"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {error}
        </Text>
      )}
      <View className="pt-6">
        <Button
          label="Run"
          icon={Play}
          iconFilled
          pending={pending}
          pendingLabel="Running…"
          onPress={() => void run()}
        />
      </View>
    </Page>
  );
}

/** A field's raw value as text, for text and number inputs. */
const asText = (value: FormValues[string]): string =>
  value === undefined || value === true || value === false ? "" : selectedIds(value).join("");

/** Typed text, with an emptied field read as unset. */
const fromText = (text: string): FormValues[string] => (text === "" ? undefined : text);

/** A number field's helper: its bounds, when the schema sets both. */
const boundsOf = (field: Extract<FieldSpec["field"], { readonly kind: "number" }>) =>
  field.min === null || field.max === null
    ? undefined
    : `From ${String(field.min)} to ${String(field.max)}.`;

/** One field's control, chosen by the kind of value it holds. */
function FieldInput({
  spec,
  values,
  role,
  onChange,
}: {
  readonly spec: FieldSpec;
  readonly values: FormValues;
  readonly role: Role;
  readonly onChange: (value: FormValues[string]) => void;
}) {
  const value = values[spec.name];
  const label = spec.optional ? `${spec.label} (optional)` : spec.label;
  const field = spec.field;

  switch (field.kind) {
    case "text":
      return (
        <Field
          label={label}
          value={asText(value)}
          onChangeText={(text) => onChange(fromText(text))}
          autoCapitalize={field.mono ? "none" : "sentences"}
        />
      );

    case "number": {
      const helper = boundsOf(field);

      return (
        <Field
          label={label}
          value={asText(value)}
          onChangeText={(text) => onChange(fromText(text))}
          keyboardType={field.integer ? "number-pad" : "decimal-pad"}
          {...(helper === undefined ? {} : { helper })}
        />
      );
    }

    case "boolean":
      return (
        <View className="min-h-ios-72 flex-row items-center gap-4 border-b border-border py-3">
          <Text variant="bodyMedium" className="flex-1">
            {label}
          </Text>
          <Switch label={spec.label} value={value === true} onValueChange={onChange} />
        </View>
      );

    case "choice":
      return (
        <>
          <SectionHeader title={label} />
          <ChipGroup
            label={spec.label}
            options={[
              ...(spec.optional ? [{ value: DEFAULT_CHOICE, label: "Default" }] : []),
              ...field.options.map((option) => ({ value: option, label: choiceLabel(option) })),
            ]}
            value={asText(value)}
            onChange={(next) => onChange(next === DEFAULT_CHOICE ? undefined : next)}
          />
        </>
      );

    case "id":
    case "ids": {
      const Picker = PICKERS[field.entity];

      return (
        <>
          <SectionHeader title={label} />
          <Picker spec={spec} value={value} values={values} role={role} onChange={onChange} />
        </>
      );
    }

    default:
      return null;
  }
}
