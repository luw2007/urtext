function makeStubAgent() {
  const stubAgent = (prompt, opts = {}) => {
    stubAgent.calls.push({ prompt, opts });
    if (opts.schema?.properties?.key) {
      const key = prompt.match(/Your cluster key: ([^.]+)\./)?.[1] ?? "stub";
      return Promise.resolve({ key, fixed: [], refuted: [], tests_added: [], full_suite_green: true });
    }
    return Promise.resolve({ findings: [], meta: {} });
  };
  stubAgent.calls = [];
  stubAgent.kind = "stub";
  return stubAgent;
}

function makeRealAgent(g) {
  const realAgent = async (prompt, opts) => {
    if (typeof g.agent !== "function") throw new Error("agent harness primitive is unavailable");
    return g.agent(prompt, opts);
  };
  realAgent.kind = "real";
  return realAgent;
}

function makeStubWorktree() {
  return {
    kind: "stub",
    calls: [],
    async head() {
      this.calls.push({ method: "head" });
      return "stub-head";
    },
    async add(path, base) {
      this.calls.push({ method: "add", path, base });
    },
  };
}

function makeRealWorktree(g) {
  return {
    kind: "real",
    async head() {
      if (!g.Bun?.$) throw new Error("Bun shell is unavailable");
      return (await g.Bun.$`git rev-parse HEAD`.text()).trim();
    },
    async add(path, base) {
      if (!g.Bun?.$) throw new Error("Bun shell is unavailable");
      await g.Bun.$`git worktree add ${path} ${base}`.text();
    },
  };
}

function makeStubGh() {
  return {
    kind: "stub",
    calls: { list: [], create: [] },
    async list(args) {
      this.calls.list.push(args);
      return [];
    },
    async create(args) {
      this.calls.create.push(args);
    },
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
    agent: overrides.agent ?? (dryRun ? makeStubAgent() : makeRealAgent(g)),
    gh: overrides.gh ?? (dryRun ? makeStubGh() : makeRealGh(g)),
    worktree: overrides.worktree ?? (dryRun ? makeStubWorktree() : makeRealWorktree(g)),
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
  const files = new Map([
    [".claude/workflows/hunt-ledger.json", '{"swept":{}}'],
    [".claude/workflows/fix-cycle-input.json", '{"cycle":0,"clusters":[{"key":"stub","prompt":"Dry-run smoke","issues":[]}]}'],
  ]);
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
