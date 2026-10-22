/**
 * Actions (F26): every command this person may run, searched and grouped, generated from the
 * command registry. Rows show the registry's summary over the command's name, the same name the
 * CLI and agents use. With no match the list gives way to G18; the search field stays above it so
 * the query can be edited, not only cleared.
 */
import { commands } from "@music/commands/registry";
import { router } from "expo-router";
import { Command } from "lucide-react-native";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowChevron } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { actionSections, actionTitle } from "@/lib/actions";
import type { ActionSection } from "@/lib/actions";

import { CommandGlyph } from "./command-glyph";
import { GROUP_ICON } from "./group-icon";
import { SearchField } from "./search-field";
import { useOffered } from "./use-offered";

/** The Actions page. */
export function ActionList() {
  const [query, setQuery] = useState("");
  const offered = useOffered();
  const sections = offered === undefined ? undefined : actionSections(offered.offered, query);

  return (
    <Page title="Actions" bottom="plain" trailing={<CommandGlyph />}>
      <SearchField value={query} onChangeText={setQuery} placeholder="Search any [music] action" />
      {sections === undefined ? null : sections.length === 0 ? (
        <EmptyState
          icon={Command}
          title="No matching action."
          body={"Try searching for “playlist”,\n“scan”, or “play”."}
          primary={<Button label="Clear search" onPress={() => setQuery("")} />}
        />
      ) : (
        <>
          {sections.map(({ section, actions }) => (
            <SectionGroup key={section} title={section} actions={actions} />
          ))}
          <Notice
            icon={Command}
            title="Same actions, everywhere"
            body="The app, CLI, and agents use one command registry."
          />
        </>
      )}
    </Page>
  );
}

function SectionGroup({
  title,
  actions,
}: {
  readonly title: string;
  readonly actions: ActionSection["actions"];
}) {
  return (
    <>
      <SectionHeader title={title} />
      {actions.map(({ name }) => (
        <Row
          key={name}
          title={actionTitle(commands[name].summary)}
          subtitle={name}
          leading={{ kind: "icon", icon: GROUP_ICON[commands[name].group], tone: "muted" }}
          trailing={<RowChevron />}
          onPress={() =>
            router.push({ pathname: "/settings/actions/[command]", params: { command: name } })
          }
        />
      ))}
    </>
  );
}
