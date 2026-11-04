import packageJson from "../../package.json" with { type: "json" };
import { register } from "../../commands/core/server";

const SERVER_NAME = "[media]";

export const { info } = register({
  info: () => ({ name: SERVER_NAME, version: packageJson.version }),
});
