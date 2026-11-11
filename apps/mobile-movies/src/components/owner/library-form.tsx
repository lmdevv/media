import { normalizeFolder } from "@media/contracts/library-folder";
import { useCommand } from "@media/sdk/react";
import { router, useLocalSearchParams, usePathname } from "expo-router";
import { Check, Folder } from "lucide-react-native";
import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { View } from "react-native";

import { Chip } from "@/components/browse/chip";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { describeFailure, isFailure } from "@/lib/failure";
import {
  KIND_LABELS,
  UNAVAILABLE_FOLDER,
  fieldNamedIn,
  filledFolders,
  folderProblem,
  withFolder,
  withKind,
} from "@/lib/library-form";
import type { FormKind, LibraryDraft } from "@/lib/library-form";

import { OwnerScreen } from "./parts";

const KINDS: ReadonlyArray<FormKind> = ["movies", "shows"];

type FolderPick = { folder?: string; field?: string; picked?: string };

/** Props for `LibraryForm`. */
export interface LibraryFormProps {
  readonly title: string;
  readonly initial: LibraryDraft;
  /** A new library chooses Movies or Shows; an existing one keeps its kind. */
  readonly chooseKind: boolean;
  readonly submitLabel: string;
  /** Saves the draft; a failure shows under the folder it names, or over the button. */
  readonly onSubmit: (draft: LibraryDraft) => Promise<void>;
  /** The check in the navigation row submits too (I03); first run leaves it out (I15). */
  readonly checkButton?: boolean;
  /** Another way on under the submit button, such as Set Up Later. */
  readonly secondary?: ReactNode;
  readonly onBack?: (() => void) | undefined;
  /** Hides back on a form nothing is under, such as first run's. */
  readonly back?: boolean;
}

const useFolderCheck = () => {
  const folders = useCommand("libraries.folders");
  const browses = useRef<Promise<boolean> | null>(null);

  return async (
    paths: ReadonlyArray<{ readonly field: number; readonly path: string }>,
  ): Promise<ReadonlyArray<number>> => {
    browses.current ??= folders({}).then(
      () => true,
      () => false,
    );

    if (!(await browses.current)) {
      browses.current = null;

      return [];
    }

    const unreadable = await Promise.all(
      paths.map(async ({ field, path }) => {
        try {
          await folders({ path: normalizeFolder(path) });

          return null;
        } catch (cause) {
          return isFailure(cause, "NotFound") ? field : null;
        }
      }),
    );

    return unreadable.flatMap((field) => (field === null ? [] : [field]));
  };
};

/** A library's name, kind, and folders, and the action that saves them. */
export function LibraryForm({
  title,
  initial,
  chooseKind,
  submitLabel,
  onSubmit,
  checkButton = true,
  secondary,
  onBack,
  back = true,
}: LibraryFormProps) {
  const pathname = usePathname();
  const pick = useLocalSearchParams<FolderPick>();
  const checkFolders = useFolderCheck();
  const [draft, setDraft] = useState(initial);
  const [problems, setProblems] = useState<ReadonlyMap<number, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);

  const pickKey =
    pick.folder === undefined ? null : `${pick.picked ?? ""}:${pick.field ?? "0"}:${pick.folder}`;

  if (pickKey !== null && pickKey !== applied && pick.folder !== undefined) {
    const field = Number(pick.field ?? "0");

    setApplied(pickKey);
    setDraft(withFolder(draft, Number.isInteger(field) ? field : 0, pick.folder));
    setProblems(new Map());
  }

  const unavailable = [...problems.values()].includes(UNAVAILABLE_FOLDER);

  const browse = (field: number) => {
    router.push({
      pathname: "/owner/folders",
      params: { returnTo: pathname, field: String(field) },
    });
  };

  const submit = async () => {
    if (busy) return;

    const folders = filledFolders(draft);

    const local = new Map(
      folders.flatMap(({ field, path }) => {
        const problem = folderProblem(path);

        return problem === null ? [] : [[field, problem] as const];
      }),
    );

    setError(null);
    setProblems(local);

    if (local.size > 0) return;

    if (draft.name.trim() === "") {
      setError("Give the library a name.");

      return;
    }

    setBusy(true);

    try {
      const unreadable = await checkFolders(folders);

      if (unreadable.length > 0) {
        setProblems(new Map(unreadable.map((field) => [field, UNAVAILABLE_FOLDER] as const)));

        return;
      }

      await onSubmit(draft);
    } catch (cause) {
      const message = describeFailure(cause);
      const field = fieldNamedIn(message, folders);

      if (field === null) setError(message);
      else setProblems(new Map([[field, message]]));
    } finally {
      setBusy(false);
    }
  };

  const firstUnavailable = [...problems.entries()].find(([, line]) => line === UNAVAILABLE_FOLDER);

  return (
    <OwnerScreen
      title={title}
      onBack={onBack}
      back={back}
      trailing={
        checkButton ? (
          <IconButton
            icon={Check}
            label={submitLabel}
            disabled={busy}
            onPress={() => void submit()}
          />
        ) : undefined
      }
    >
      <TextField
        label="Name"
        value={draft.name}
        onChangeText={(name) => {
          setDraft({ ...draft, name });
          setError(null);
        }}
        autoCapitalize="words"
        returnKeyType="done"
        maxLength={80}
      />
      {chooseKind ? (
        <View className="flex-row gap-2" accessibilityRole="radiogroup">
          {KINDS.map((kind) => (
            <Chip
              key={kind}
              label={KIND_LABELS[kind]}
              selected={draft.kind === kind}
              onPress={() => setDraft(withKind(draft, kind))}
            />
          ))}
        </View>
      ) : null}
      {draft.folders.map((folder, field) => (
        <TextField
          key={`folder-${String(field)}`}
          label={field === 0 ? "Server Folder" : `Server Folder ${field + 1}`}
          value={folder}
          placeholder="/media/movies"
          error={problems.get(field) ?? null}
          onChangeText={(text) => {
            setDraft(withFolder(draft, field, text));
            setProblems(new Map());
          }}
          autoCapitalize="none"
          keyboardType="url"
          returnKeyType="done"
        />
      ))}
      {unavailable ? null : (
        <ListRow icon={Folder} title="Browse Server Folders" onPress={() => browse(0)} />
      )}
      {error === null ? null : (
        <Text variant="meta" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
      {unavailable && firstUnavailable !== undefined ? (
        <Button
          label="Choose Another Folder"
          icon={Folder}
          onPress={() => browse(firstUnavailable[0])}
        />
      ) : (
        <Button label={submitLabel} busy={busy} onPress={() => void submit()} />
      )}
      {secondary}
    </OwnerScreen>
  );
}
