import { Option } from "effect";

/** `call`'s answer, or none once `ms` pass first. The call itself goes on. */
export const withDeadline = async <A>(call: Promise<A>, ms: number): Promise<Option.Option<A>> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const late = new Promise<Option.Option<A>>((resolve) => {
    timer = setTimeout(() => resolve(Option.none()), ms);
  });

  try {
    return await Promise.race([call.then(Option.some), late]);
  } finally {
    clearTimeout(timer);
  }
};
