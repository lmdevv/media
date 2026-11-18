import { toast } from "sonner";

/** What a cancel command answers, as `core.libraries.cancelScan` and `movies.imports.cancel` do. */
interface CancelAnswer {
  readonly outcome: "finished" | "canceling" | "movedOn";
}

/**
 * Says when a cancel changed nothing because the job was claimed again after the person looked,
 * so a later attempt runs on; the screen then shows that attempt, which they may cancel.
 */
export const reportMovedOn = (answers: ReadonlyArray<CancelAnswer>, what: string): void => {
  if (answers.some((answer) => answer.outcome === "movedOn")) {
    toast.message(`The ${what} started over before the cancel arrived`);
  }
};
