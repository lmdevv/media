import type { CheckedCommand } from "../check.ts";
import type { Domain } from "../command.ts";
import type { Emitted, Target } from "../outputs.ts";
import { fieldsType, wireType } from "../render.ts";
import { GENERATED_NOTE } from "../note.ts";

const TITLES = {
  core: "Core",
  movies: "Movies",
  music: "Music",
} as const satisfies { readonly [D in Domain]: string };

/** Inline code that holds any text, backticks included, as CommonMark reads it. */
const codeSpan = (text: string): string => {
  const longest = Math.max(0, ...(text.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);

  return longest === 0 ? `${fence}${text}${fence}` : `${fence} ${text} ${fence}`;
};

const entry = (command: CheckedCommand): string =>
  [
    `## ${codeSpan(command.name)}`,
    `${command.summary}.`,
    [
      `- Kind: ${command.kind}`,
      `- Scope: ${command.scope}`,
      `- Arguments: ${command.args.length === 0 ? "none" : codeSpan(fieldsType(command.args))}`,
      `- Result: ${codeSpan(wireType(command.result))}`,
    ].join("\n"),
  ].join("\n\n");

const reference = (domain: Domain, commands: ReadonlyArray<CheckedCommand>): Emitted => ({
  path: `${domain}.md`,
  text: [
    `<!-- ${GENERATED_NOTE.join(" ")} -->`,
    `# ${TITLES[domain]} commands`,
    ...commands.map(entry),
  ]
    .join("\n\n")
    .concat("\n"),
});

/** The agent skill's reference: one file per domain, loaded on demand (ADR 0021). */
export const skillTarget = (root: string): Target => ({
  root,
  emit: (commands) =>
    [...Map.groupBy(commands, (command) => command.domain)].map(([domain, inDomain]) =>
      reference(domain, inDomain),
    ),
});
