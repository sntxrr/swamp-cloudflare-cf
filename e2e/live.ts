/**
 * Live end-to-end suite for `@sntxrr/cloudflare-cf`, run against a real
 * Cloudflare account through the real `swamp` CLI.
 *
 * `cf` exposes ~2,900 operations, but they reduce to a handful of shapes the
 * model must handle: HTTP method (GET/POST/PUT/PATCH/DELETE), scope (zone /
 * account / user / radar), request body (none / JSON / octet-stream /
 * multipart), response (JSON / text), and confirmation (`--force`). Each case
 * below exercises one shape on a real resource.
 *
 * Default mode runs reads and dry-runs only, with a model whose `allowWrites`
 * is false, so nothing can be written. `--apply` adds write round-trips on
 * throwaway `swamp-e2e-<run>` resources. Every resource created is registered
 * for cleanup, and cleanup is judged by listing — a list that errors is
 * reported UNVERIFIED, never clean.
 *
 * Usage:
 *   CF_E2E_ZONE=example.com deno run -A e2e/live.ts            # reads + dry-runs
 *   CF_E2E_ZONE=example.com deno run -A e2e/live.ts --apply    # + write round-trips
 *
 * Options:
 *   --source local|published   extension under test (default: local source)
 *   --only a,b                 run only these groups
 *   --skip a,b                 skip these groups (e.g. r2 when R2 is not enabled)
 *   --account-id <id>          required when the credential sees several accounts
 *   --keep-repo                keep the temporary swamp repo for inspection
 *
 * Credential: cf's OAuth profile (`cf auth login`). `cf` must be on PATH.
 *
 * @module
 */
// e2e/live.ts

const args = Deno.args;
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const list = (s?: string) => new Set((s ?? "").split(",").filter(Boolean));

const APPLY = flag("--apply");
const SOURCE = opt("--source") ?? "local";
const ONLY = list(opt("--only"));
const SKIP = list(opt("--skip"));
const KEEP = flag("--keep-repo");
const ZONE = Deno.env.get("CF_E2E_ZONE") ?? "";
if (!ZONE) {
  console.error("CF_E2E_ZONE is required (a zone the suite may write to)");
  Deno.exit(2);
}

const RUN = crypto.randomUUID().slice(0, 6);
const PREFIX = `swamp-e2e-${RUN}`;
const EXT_DIR = new URL("../extensions", import.meta.url).pathname;

// ---- reporting -------------------------------------------------------------

type Status = "PASS" | "FAIL" | "SKIP" | "UNVERIFIED";
const results: {
  group: string;
  shape: string;
  name: string;
  status: Status;
  detail: string;
}[] = [];
let failed = false;

function record(
  group: string,
  shape: string,
  name: string,
  status: Status,
  detail: string,
) {
  results.push({ group, shape, name, status, detail });
  if (status === "FAIL" || status === "UNVERIFIED") failed = true;
  const mark = { PASS: "✓", FAIL: "✗", SKIP: "-", UNVERIFIED: "?" }[status];
  console.log(
    `${mark} ${status.padEnd(10)} ${group.padEnd(12)} ${name}${
      detail ? `  — ${detail}` : ""
    }`,
  );
}

const wanted = (group: string) =>
  (ONLY.size === 0 || ONLY.has(group)) && !SKIP.has(group);

/** Run one case; stop the suite on the first failure (cleanup still runs). */
async function check(
  group: string,
  shape: string,
  name: string,
  fn: () => Promise<string | void>,
  opts: { needsApply?: boolean } = {},
) {
  if (!wanted(group)) return record(group, shape, name, "SKIP", "filtered");
  if (opts.needsApply && !APPLY) {
    return record(group, shape, name, "SKIP", "needs --apply");
  }
  try {
    record(group, shape, name, "PASS", (await fn()) ?? "");
  } catch (e) {
    record(group, shape, name, "FAIL", (e as Error).message.slice(0, 300));
    throw new StopSuite();
  }
}
class StopSuite extends Error {}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ---- swamp driver ----------------------------------------------------------

let REPO = "";

async function sh(
  cmd: string,
  argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command(cmd, {
    args: argv,
    cwd: REPO || undefined,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const d = new TextDecoder();
  return {
    code: out.code,
    stdout: d.decode(out.stdout),
    stderr: d.decode(out.stderr),
  };
}

/** Last JSON object in swamp's --json output that carries `key`. */
function lastJsonWith(text: string, key: string): Record<string, unknown> {
  const objs: Record<string, unknown>[] = [];
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          objs.push(JSON.parse(text.slice(start, i + 1)));
        } catch { /* not JSON */ }
      }
    }
  }
  return objs.reverse().find((o) => key in o) ?? {};
}

async function swamp(argv: string[]) {
  return await sh("swamp", [...argv, "--repo-dir", REPO, "--json"]);
}

type Result = {
  mode: string;
  httpMethod: string;
  output: unknown;
  outputText: string | null;
  truncated: boolean;
  argv: string[];
};

let seq = 0;

/** Run a model method; returns the stored record, or throws cf's error. */
async function method(
  model: string,
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestId = `r${++seq}`;
  const file = `${REPO}/.e2e-input-${requestId}.json`;
  await Deno.writeTextFile(file, JSON.stringify({ ...input, requestId }));
  try {
    const out = await swamp([
      "model",
      "method",
      "run",
      model,
      name,
      "--input-file",
      file,
    ]);
    if (out.code !== 0) {
      const err = lastJsonWith(out.stdout + out.stderr, "error").error;
      throw new Error(String(err ?? out.stderr.slice(0, 300)));
    }
  } finally {
    await Deno.remove(file).catch(() => {});
  }
  const got = await swamp(["data", "get", model, requestId]);
  const content = lastJsonWith(got.stdout, "content").content;
  assert(
    content && typeof content === "object",
    `no stored data for ${requestId}`,
  );
  return content as Record<string, unknown>;
}

const run = async (model: string, input: Record<string, unknown>) =>
  await method(model, "run", input) as unknown as Result;

/** Expect a run to fail; returns the error text. */
async function runFails(
  model: string,
  input: Record<string, unknown>,
): Promise<string> {
  try {
    await run(model, input);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected this call to fail, but it succeeded");
}

/** Unwrap cf's list output (an array, or an object with `result`). */
function items(o: unknown): Record<string, unknown>[] {
  if (Array.isArray(o)) return o;
  const r = (o as { result?: unknown })?.result;
  return Array.isArray(r) ? r : [];
}

// ---- cleanup registry ------------------------------------------------------

type Cleanup = {
  label: string;
  /** true = verified gone; throws when it cannot tell. */
  gone: () => Promise<boolean>;
  remove: () => Promise<void>;
};
const cleanups: Cleanup[] = [];

/** Delete, retrying once with --force when cf aborts an unconfirmed prompt. */
async function del(model: string, input: Record<string, unknown>) {
  try {
    await run(model, { ...input, apply: true });
  } catch (e) {
    if (!/aborted/i.test((e as Error).message)) throw e;
    await run(model, {
      ...input,
      apply: true,
      flags: { ...(input.flags as object ?? {}), force: true },
    });
  }
}

async function runCleanup() {
  for (const c of cleanups.reverse()) {
    try {
      if (!(await c.gone())) {
        await c.remove().catch((e) =>
          console.log(`  cleanup ${c.label}: ${(e as Error).message}`)
        );
      }
      const gone = await c.gone();
      record(
        "cleanup",
        "verify",
        c.label,
        gone ? "PASS" : "FAIL",
        gone ? "verified gone" : "STILL PRESENT — remove by hand",
      );
    } catch (e) {
      record(
        "cleanup",
        "verify",
        c.label,
        "UNVERIFIED",
        `could not list: ${(e as Error).message.slice(0, 160)}`,
      );
    }
  }
}

// ---- the suite -------------------------------------------------------------

async function setup(): Promise<{ accountId: string }> {
  REPO = await Deno.makeTempDir({ prefix: "swamp-cf-e2e-" });
  const init = await swamp(["repo", "init"]);
  assert(init.code === 0, `swamp repo init failed: ${init.stderr}`);
  if (SOURCE === "local") {
    await Deno.writeTextFile(
      `${REPO}/.swamp-sources.yaml`,
      `sources:\n  - path: ${EXT_DIR}\n`,
    );
  } else {
    const pull = await swamp(["extension", "pull", "@sntxrr/cloudflare-cf"]);
    assert(pull.code === 0, `extension pull failed: ${pull.stderr}`);
  }
  const types = await swamp(["model", "type", "search", "cloudflare-cf"]);
  assert(
    types.stdout.includes("@sntxrr/cloudflare-cf"),
    `model type did not load (${SOURCE}): ${types.stderr.slice(0, 300)}`,
  );

  // OAuth: no apiToken, so cf uses its login profile.
  const mk = async (name: string, extra: string[]) => {
    const r = await swamp([
      "model",
      "create",
      "@sntxrr/cloudflare-cf",
      name,
      "--global-arg",
      `zone=${ZONE}`,
      ...extra.flatMap((a) => ["--global-arg", a]),
    ]);
    assert(r.code === 0, `model create ${name}: ${r.stdout}${r.stderr}`);
  };
  await mk("probe", []);
  const id = await method("probe", "whoami", {});
  const accounts = (id.accounts as { id: string; name: string }[]) ?? [];
  let accountId = opt("--account-id") ?? "";
  if (!accountId) {
    assert(
      accounts.length === 1,
      `credential sees ${accounts.length} accounts — pass --account-id (${
        accounts.map((a) => a.name).join(", ")
      })`,
    );
    accountId = accounts[0].id;
  }
  // Writes are impossible unless --apply: the model itself refuses them.
  await mk("e2e", [`accountId=${accountId}`, `allowWrites=${APPLY}`]);
  await mk("ro", [
    `accountId=${accountId}`,
    "allowWrites=false",
    "maxOutputBytes=512",
  ]);
  return { accountId };
}

async function suite() {
  const { accountId } = await setup();
  console.log(
    `\nrepo ${REPO} · source=${SOURCE} · mode=${
      APPLY ? "APPLY" : "read+dry-run"
    } · run ${RUN}\n`,
  );

  // -- auth
  await check("auth", "oauth", "whoami via cf OAuth profile", async () => {
    const id = await method("e2e", "whoami", {});
    assert(id.tokenKind === "oauth", `tokenKind=${id.tokenKind}`);
    assert(id.tokenValid === true, `tokenValid=${id.tokenValid}`);
    return `oauth, ${(id.accounts as unknown[]).length} account(s)`;
  });

  // -- discovery
  await check(
    "discovery",
    "search",
    "search finds kv namespace create",
    async () => {
      const s = await method("e2e", "search", {
        query: "create a kv namespace",
      });
      const cmds = (s.matches as { command: string }[]).map((m) => m.command);
      assert(cmds.includes("cf kv namespaces create"), cmds.join(", "));
    },
  );
  await check(
    "discovery",
    "schema",
    "schema classifies read vs write",
    async () => {
      const w = await method("e2e", "schema", { command: "d1 query" });
      const r = await method("e2e", "schema", { command: "dns records list" });
      assert(w.httpMethod === "POST" && w.readOnly === false, "d1 query");
      assert(r.httpMethod === "GET" && r.readOnly === true, "dns records list");
    },
  );

  // -- zone reads
  let firstId = "", firstType = "";
  await check("zone-read", "GET list", "dns records list", async () => {
    const r = await run("e2e", { command: "dns records list" });
    const recs = items(r.output);
    assert(
      r.mode === "read" && recs.length > 0,
      `mode=${r.mode} n=${recs.length}`,
    );
    firstId = String(recs[0].id);
    firstType = String(recs[0].type);
    return `${recs.length} records`;
  });
  await check(
    "zone-read",
    "GET + flags",
    "dns records list --type",
    async () => {
      const r = await run("e2e", {
        command: "dns records list",
        flags: { type: firstType },
      });
      const recs = items(r.output);
      assert(recs.every((x) => x.type === firstType), "filter not applied");
      return `${recs.length} × ${firstType}`;
    },
  );
  await check(
    "zone-read",
    "GET positional",
    "dns records get <id>",
    async () => {
      const r = await run("e2e", {
        command: "dns records get",
        args: [firstId],
      });
      const o = (r.output as { id?: string; result?: { id?: string } }) ?? {};
      assert((o.id ?? o.result?.id) === firstId, "wrong record returned");
    },
  );
  await check(
    "zone-read",
    "GET text response",
    "dns records export",
    async () => {
      const r = await run("e2e", { command: "dns records export" });
      assert(r.output === null && r.outputText, "expected raw text, got JSON");
      assert(/\bSOA\b/.test(r.outputText), "zone file has no SOA");
      return `${r.outputText.split("\n").length} lines`;
    },
  );
  await check(
    "zone-read",
    "truncation",
    "maxOutputBytes caps output",
    async () => {
      const r = await run("ro", { command: "dns records list" });
      assert(r.truncated === true, "not marked truncated");
      assert((r.outputText ?? "").length <= 512, "text exceeds cap");
    },
  );

  // -- account, radar
  for (
    const [cmd, label] of [
      ["kv namespaces list", "kv"],
      ["d1 list", "d1"],
      ["r2 buckets list", "r2"],
    ]
  ) {
    await check(
      label === "r2" ? "r2" : "account-read",
      "GET account",
      cmd,
      async () => {
        const r = await run("e2e", { command: cmd });
        assert(r.mode === "read" && r.output !== null, "no JSON output");
      },
    );
  }
  await check("radar", "GET radar", "radar dns top locations", async () => {
    const r = await run("e2e", {
      command: "radar dns top locations",
      flags: { limit: 3, "date-range": "7d" },
    });
    assert(r.output !== null, "no JSON output");
  });

  // -- error shapes
  await check("errors", "404", "get a record that does not exist", async () => {
    const e = await runFails("e2e", {
      command: "dns records get",
      args: ["0".repeat(32)],
    });
    assert(/404|not found|81044|Record does not exist/i.test(e), e);
  });
  await check(
    "errors",
    "client validation",
    "invalid choice is rejected",
    async () => {
      const e = await runFails("e2e", {
        command: "dns records list",
        flags: { type: "NOT-A-TYPE" },
      });
      assert(/choice|invalid/i.test(e), e);
    },
  );
  await check("errors", "guard", "non-API command refused", async () => {
    const e = await runFails("e2e", { command: "deploy" });
    assert(/not a generated Cloudflare API operation/.test(e), e);
  });
  await check("errors", "guard", "model-owned flag refused", async () => {
    const e = await runFails("e2e", {
      command: "dns records list",
      flags: { "dry-run": false },
    });
    assert(/managed by the model/.test(e), e);
  });
  await check(
    "errors",
    "guard",
    "apply refused without allowWrites",
    async () => {
      const e = await runFails("ro", {
        command: "dns records create",
        apply: true,
        body: { type: "TXT", name: `${PREFIX}-guard.${ZONE}`, content: '"x"' },
      });
      assert(/does not set allowWrites/.test(e), e);
    },
  );

  // -- dry-run request shapes (safe in both modes)
  await check("dry-run", "POST json", "dns records create", async () => {
    const r = await run("e2e", {
      command: "dns records create",
      body: { type: "TXT", name: `${PREFIX}-dry.${ZONE}`, content: '"x"' },
    });
    const o = r.output as Record<string, unknown>;
    assert(r.mode === "dry-run" && o.method === "POST", `mode=${r.mode}`);
    assert(o.bodyKind === "json", `bodyKind=${o.bodyKind}`);
  });
  await check(
    "dry-run",
    "PUT octet-stream",
    "kv value body is sent raw",
    async () => {
      const r = await run("e2e", {
        command: "kv keys put",
        args: ["greeting"],
        flags: { "namespace-id": "0".repeat(32) },
        body: "hello e2e",
      });
      const o = r.output as Record<string, unknown>;
      assert(o.method === "PUT", `method=${o.method}`);
      assert(
        o.body === "hello e2e",
        `body sent as ${JSON.stringify(o.body)} (bodyKind=${o.bodyKind})`,
      );
    },
  );
  await check(
    "dry-run",
    "POST multipart",
    "dns records import --file",
    async () => {
      const zoneFile = `${REPO}/.e2e-import.txt`;
      await Deno.writeTextFile(
        zoneFile,
        `${PREFIX}-imp.${ZONE}. 60 IN TXT "imported"\n`,
      );
      const r = await run("e2e", {
        command: "dns records import",
        flags: { file: zoneFile },
      });
      const o = r.output as Record<string, unknown>;
      assert(o.bodyKind === "multipart", `bodyKind=${o.bodyKind}`);
    },
  );
  await check("dry-run", "DELETE", "dns records delete", async () => {
    const r = await run("e2e", {
      command: "dns records delete",
      args: ["0".repeat(32)],
    });
    assert(
      r.mode === "dry-run" &&
        (r.output as Record<string, unknown>).method === "DELETE",
      `mode=${r.mode}`,
    );
  });

  // -- write round-trips (--apply)
  await dnsRoundTrip();
  await dnsImport();
  await kvRoundTrip();
  await d1RoundTrip();
  await r2RoundTrip();
  void accountId;
}

const txt = (s: string) => `"${s}"`;

async function dnsByName(name: string) {
  const r = await run("e2e", {
    command: "dns records list",
    flags: { name },
  });
  return items(r.output);
}

async function dnsRoundTrip() {
  const name = `${PREFIX}-txt.${ZONE}`;
  let id = "";
  const content = async () => {
    const r = await run("e2e", { command: "dns records get", args: [id] });
    const o = r.output as Record<string, unknown>;
    return String((o.result as Record<string, unknown>)?.content ?? o.content);
  };
  await check("dns-write", "POST json", "create TXT", async () => {
    const r = await run("e2e", {
      command: "dns records create",
      apply: true,
      body: {
        type: "TXT",
        name,
        content: txt("v1"),
        ttl: 60,
        comment: "swamp cf e2e — safe to delete",
      },
    });
    assert(r.mode === "apply", `mode=${r.mode}`);
    const o = r.output as Record<string, unknown>;
    id = String((o.result as Record<string, unknown>)?.id ?? o.id);
    cleanups.push({
      label: `dns ${name}`,
      gone: async () => (await dnsByName(name)).length === 0,
      remove: async () => {
        for (const rec of await dnsByName(name)) {
          await del("e2e", {
            command: "dns records delete",
            args: [String(rec.id)],
          });
        }
      },
    });
    assert((await content()) === txt("v1"), "content after create");
  }, { needsApply: true });
  await check("dns-write", "PATCH", "edit content", async () => {
    await run("e2e", {
      command: "dns records edit",
      args: [id],
      apply: true,
      body: { content: txt("v2") },
    });
    assert((await content()) === txt("v2"), await content());
  }, { needsApply: true });
  await check("dns-write", "PUT", "replace record", async () => {
    await run("e2e", {
      command: "dns records update",
      args: [id],
      apply: true,
      body: { type: "TXT", name, content: txt("v3"), ttl: 60 },
    });
    assert((await content()) === txt("v3"), await content());
  }, { needsApply: true });
  await check(
    "dns-write",
    "DELETE unconfirmed",
    "delete without force fails",
    async () => {
      const e = await runFails("e2e", {
        command: "dns records delete",
        args: [id],
        apply: true,
      });
      assert(/aborted/i.test(e), e);
      assert((await dnsByName(name)).length === 1, "record vanished anyway");
    },
    { needsApply: true },
  );
  await check("dns-write", "DELETE --force", "delete with force", async () => {
    await run("e2e", {
      command: "dns records delete",
      args: [id],
      apply: true,
      flags: { force: true },
    });
    assert((await dnsByName(name)).length === 0, "record still present");
  }, { needsApply: true });
}

async function dnsImport() {
  const name = `${PREFIX}-imp.${ZONE}`;
  await check(
    "dns-write",
    "POST multipart",
    "import a BIND zone file",
    async () => {
      const zoneFile = `${REPO}/.e2e-import.txt`;
      await Deno.writeTextFile(zoneFile, `${name}. 60 IN TXT "imported"\n`);
      cleanups.push({
        label: `dns ${name}`,
        gone: async () => (await dnsByName(name)).length === 0,
        remove: async () => {
          for (const rec of await dnsByName(name)) {
            await del("e2e", {
              command: "dns records delete",
              args: [String(rec.id)],
            });
          }
        },
      });
      await run("e2e", {
        command: "dns records import",
        apply: true,
        flags: { file: zoneFile },
      });
      const recs = await dnsByName(name);
      assert(recs.length === 1, `${recs.length} records after import`);
      assert(recs[0].content === txt("imported"), String(recs[0].content));
    },
    { needsApply: true },
  );
}

async function kvRoundTrip() {
  const title = `${PREFIX}-kv`;
  let ns = "";
  const nsByTitle = async (t: string) => {
    const r = await run("e2e", { command: "kv namespaces list" });
    return items(r.output).filter((n) => n.title === t);
  };
  await check("kv", "POST json (account)", "create namespace", async () => {
    const r = await run("e2e", {
      command: "kv namespaces create",
      apply: true,
      body: { title },
    });
    const o = r.output as Record<string, unknown>;
    ns = String((o.result as Record<string, unknown>)?.id ?? o.id);
    cleanups.push({
      label: `kv namespace ${title}`,
      gone: async () =>
        (await nsByTitle(title)).length === 0 &&
        (await nsByTitle(`${title}-renamed`)).length === 0,
      remove: async () => {
        await del("e2e", { command: "kv namespaces delete", args: [ns] });
      },
    });
    assert(ns.length === 32, `id=${ns}`);
  }, { needsApply: true });
  await check("kv", "PUT json (account)", "rename namespace", async () => {
    await run("e2e", {
      command: "kv namespaces update",
      args: [ns],
      apply: true,
      body: { title: `${title}-renamed` },
    });
    assert((await nsByTitle(`${title}-renamed`)).length === 1, "not renamed");
  }, { needsApply: true });
  await check("kv", "PUT octet-stream", "put a value", async () => {
    await run("e2e", {
      command: "kv keys put",
      args: ["greeting"],
      apply: true,
      flags: { "namespace-id": ns },
      body: "hello e2e",
    });
  }, { needsApply: true });
  await check(
    "kv",
    "GET text response",
    "value round-trips byte-exact",
    async () => {
      const r = await run("e2e", {
        command: "kv keys get",
        args: ["greeting"],
        flags: { "namespace-id": ns, text: true },
      });
      // A JSON-quoted value would parse into `output`; only raw text is right.
      assert(
        r.outputText?.trimEnd() === "hello e2e",
        `got output=${JSON.stringify(r.output)} text=${
          JSON.stringify(r.outputText)
        }`,
      );
    },
    { needsApply: true },
  );
  await check("kv", "DELETE (account)", "delete namespace", async () => {
    await del("e2e", { command: "kv namespaces delete", args: [ns] });
    assert((await nsByTitle(`${title}-renamed`)).length === 0, "still listed");
  }, { needsApply: true });
}

async function d1RoundTrip() {
  const name = `${PREFIX}-d1`;
  let db = "";
  const dbByName = async () => {
    const r = await run("e2e", { command: "d1 list", flags: { name } });
    return items(r.output).filter((d) => d.name === name);
  };
  await check("d1", "POST json (account)", "create database", async () => {
    const r = await run("e2e", {
      command: "d1 create",
      apply: true,
      body: { name },
    });
    const o = r.output as Record<string, unknown>;
    db = String((o.result as Record<string, unknown>)?.uuid ?? o.uuid);
    cleanups.push({
      label: `d1 ${name}`,
      gone: async () => (await dbByName()).length === 0,
      remove: async () => {
        await del("e2e", { command: "d1 delete", args: [db] });
      },
    });
    assert(/^[0-9a-f-]{36}$/.test(db), `uuid=${db}`);
  }, { needsApply: true });
  await check(
    "d1",
    "POST (read semantics)",
    "query writes and reads rows",
    async () => {
      await run("e2e", {
        command: "d1 query",
        args: [db],
        apply: true,
        body: {
          sql:
            "CREATE TABLE t (k TEXT); INSERT INTO t VALUES ('swamp'); SELECT k FROM t;",
        },
      });
      const r = await run("e2e", {
        command: "d1 query",
        args: [db],
        apply: true,
        body: { sql: "SELECT k FROM t" },
      });
      assert(JSON.stringify(r.output).includes('"k":"swamp"'), "row not found");
    },
    { needsApply: true },
  );
  await check("d1", "DELETE (account)", "delete database", async () => {
    await del("e2e", { command: "d1 delete", args: [db] });
    assert((await dbByName()).length === 0, "still listed");
  }, { needsApply: true });
}

async function r2RoundTrip() {
  const bucket = `${PREFIX}-r2`;
  const bucketExists = async () => {
    const r = await run("e2e", { command: "r2 buckets list" });
    const o = r.output as Record<string, unknown>;
    const buckets = (o.buckets ??
      (o.result as Record<string, unknown>)?.buckets ?? []) as {
        name: string;
      }[];
    return buckets.some((b) => b.name === bucket);
  };
  await check("r2", "POST json (account)", "create bucket", async () => {
    await run("e2e", {
      command: "r2 buckets create",
      apply: true,
      body: { name: bucket },
    });
    cleanups.push({
      label: `r2 ${bucket}`,
      gone: async () => !(await bucketExists()),
      remove: async () => {
        await del("e2e", {
          command: "r2 objects delete",
          args: ["hello.txt"],
          flags: { "bucket-name": bucket },
        }).catch(() => {});
        await del("e2e", { command: "r2 buckets delete", args: [bucket] });
      },
    });
    assert(await bucketExists(), "bucket not listed");
  }, { needsApply: true });
  await check("r2", "PUT octet-stream", "upload an object", async () => {
    await run("e2e", {
      command: "r2 objects put",
      args: ["hello.txt"],
      apply: true,
      flags: { "bucket-name": bucket, "content-type": "text/plain" },
      body: "hello r2",
    });
  }, { needsApply: true });
  await check(
    "r2",
    "GET binary→text",
    "object round-trips byte-exact",
    async () => {
      const r = await run("e2e", {
        command: "r2 objects get",
        args: ["hello.txt"],
        flags: { "bucket-name": bucket, text: true },
      });
      assert(
        r.outputText?.trimEnd() === "hello r2",
        `got output=${JSON.stringify(r.output)} text=${
          JSON.stringify(r.outputText)
        }`,
      );
    },
    { needsApply: true },
  );
  await check(
    "r2",
    "DELETE (account)",
    "delete object and bucket",
    async () => {
      await del("e2e", {
        command: "r2 objects delete",
        args: ["hello.txt"],
        flags: { "bucket-name": bucket },
      });
      await del("e2e", { command: "r2 buckets delete", args: [bucket] });
      assert(!(await bucketExists()), "bucket still listed");
    },
    { needsApply: true },
  );
}

// ---- main ------------------------------------------------------------------

try {
  await suite();
} catch (e) {
  if (!(e instanceof StopSuite)) {
    record("suite", "setup", "setup", "FAIL", (e as Error).message);
  } else {
    console.log("\nstopped at the first failure; running cleanup");
  }
} finally {
  if (REPO) await runCleanup();
  const count = (s: Status) => results.filter((r) => r.status === s).length;
  console.log(
    `\n${count("PASS")} passed · ${count("FAIL")} failed · ${
      count("UNVERIFIED")
    } unverified · ${count("SKIP")} skipped  (run ${RUN}, mode ${
      APPLY ? "APPLY" : "read+dry-run"
    })`,
  );
  if (REPO && !KEEP) await Deno.remove(REPO, { recursive: true });
  else if (REPO) console.log(`repo kept: ${REPO}`);
  Deno.exit(failed ? 1 : 0);
}
