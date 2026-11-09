import type { Infer, ObjectType, PropertyValidators, Validator } from "convex/values";

import { mutation, query } from "../../_generated/server";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { requireService } from "../auth/caller";
import type { ServiceCaller } from "../auth/caller";

type Returns = Validator<unknown, "required", string>;

interface ServerFunction<Ctx, Args extends PropertyValidators, Result extends Returns> {
  readonly args: Args;
  readonly returns: Result;
  readonly handler: (
    ctx: Omit<Ctx, "auth">,
    args: ObjectType<Args>,
    service: ServiceCaller,
  ) => Infer<Result> | Promise<Infer<Result>>;
}

export const serverQuery = <Args extends PropertyValidators, Result extends Returns>(
  definition: ServerFunction<QueryCtx, Args, Result>,
) => {
  const returns: Returns = definition.returns;

  return query({
    args: definition.args,
    returns,
    handler: async (ctx, ...[args]: [ObjectType<Args>]): Promise<Infer<Result>> =>
      definition.handler(ctx, args, await requireService(ctx, "media-service")),
  });
};

export const serverMutation = <Args extends PropertyValidators, Result extends Returns>(
  definition: ServerFunction<MutationCtx, Args, Result>,
) => {
  const returns: Returns = definition.returns;

  return mutation({
    args: definition.args,
    returns,
    handler: async (ctx, ...[args]: [ObjectType<Args>]): Promise<Infer<Result>> =>
      definition.handler(ctx, args, await requireService(ctx, "media-service")),
  });
};
