function stubAgent() {
  return Promise.resolve({ findings: [], meta: {} });
}
stubAgent.kind = "stub";

function makeRealAgent(g) {
  const realAgent = async (prompt, opts) => {
    if (typeof g.agent !== "function") throw new Error("agent harness primitive is unavailable");
    return g.agent(prompt, opts);
  };
  realAgent.kind = "real";
  return realAgent;
}

function makeStubGh() {
  return {
    kind: "stub",
    async list() {
      return [];
    },
    async create() {},
  };
}

function makeRealGh(g) {
  return {
    kind: "real",
    async list(args) {
      if (!g.Bun?.$) throw new Error("Bun shell is unavailable");
      if (args[0] !== "issue" || args[1] !== "list") throw new Error("gh.list expects issue list args");
      const output = args[2] === "--search"
        ? await g.Bun.$`gh issue list --search ${args[3]} --json ${args[5]}`.text()
        : await g.Bun.$`gh issue list ${args.slice(2)}`.text();
      return JSON.parse(output);
    },
    async create(args) {
      if (!g.Bun?.$) throw new Error("Bun shell is unavailable");
      if (args[0] !== "issue" || args[1] !== "create") throw new Error("gh.create expects issue create args");
      await g.Bun.$`gh issue create ${args.slice(2)}`.text();
    },
  };
}

export function resolveAdapters(env, overrides = {}, g = globalThis) {
  const dryRun = Boolean(env?.DRY_RUN);
  return {
    agent: overrides.agent ?? (dryRun ? stubAgent : makeRealAgent(g)),
    gh: overrides.gh ?? (dryRun ? makeStubGh() : makeRealGh(g)),
  };
}

export function makeRealRuntime(g, env) {
  return {
    read: g.read,
    write: g.write,
    log: g.log,
    parallel: g.parallel,
    env,
    adapters: resolveAdapters(env, {}, g),
  };
}

export function makeStubRuntime() {
  const files = new Map([[".claude/workflows/hunt-ledger.json", '{"swept":{}}']]);
  const env = { DRY_RUN: "1" };
  return {
    read(path) {
      if (!files.has(path)) throw new Error(`stub file not found: ${path}`);
      return files.get(path);
    },
    write(path, content) {
      files.set(path, content);
    },
    log() {},
    parallel(tasks) {
      return Promise.all(tasks.map((task) => task()));
    },
    env,
    adapters: resolveAdapters(env),
  };
}
