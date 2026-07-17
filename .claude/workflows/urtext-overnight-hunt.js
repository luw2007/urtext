import { run } from "./lib/hunt-core.mjs";
import { makeRealRuntime } from "./lib/adapters.mjs";
await run(makeRealRuntime(globalThis, globalThis.process?.env ?? {}));
