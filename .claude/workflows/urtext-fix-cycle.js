import { run } from "./lib/fix-core.mjs";
import { makeRealRuntime } from "./lib/adapters.mjs";

await run(makeRealRuntime(globalThis, globalThis.process?.env ?? {}));
