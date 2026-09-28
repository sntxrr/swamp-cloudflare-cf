// extensions/models/cloudflare_cf_test.ts
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260923.37";
import {
  captureOutput,
  cfEnv,
  flagsToArgv,
  model,
  parseCommand,
} from "./cloudflare_cf.ts";

type RunContext = Parameters<typeof model.methods.run.execute>[1];

const TOKEN = "cf-test-token-not-real";

const GLOBAL_ARGS = {
  apiToken: TOKEN,
  cfCommand: ["cf"],
  allowWrites: false,
  telemetry: false,
  timeoutMs: 5_000,
  maxOutputBytes: 256 * 1024,
};

type Call = { argv: string[]; env: Record<string, string> };
type Reply = { code?: number; stdout?: string; stderr?: string };

/** Swap in a fake `Deno.Command` for the duration of `fn`. */
async function withFakeCf(
  handler: (argv: string[]) => Reply,
  fn: (calls: Call[]) => Promise<void>,
) {
  const calls: Call[] = [];
  const original = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    #call: Call;
    constructor(
      _cmd: string,
      opts: { args?: string[]; env?: Record<string, string> },
    ) {
      this.#call = { argv: opts.args ?? [], env: opts.env ?? {} };
      calls.push(this.#call);
    }
    output() {
      const r = handler(this.#call.argv);
      const enc = new TextEncoder();
      return Promise.resolve({
        code: r.code ?? 0,
        stdout: enc.encode(r.stdout ?? ""),
        stderr: enc.encode(r.stderr ?? ""),
      });
    }
  };
  try {
    await fn(calls);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = original;
  }
}

function context(
  methodName: string,
  globalArgs: Record<string, unknown> = GLOBAL_ARGS,
) {
  const ctx = createModelTestContext({ globalArgs, methodName });
  return { ...ctx, context: ctx.context as unknown as RunContext };
}

const SCHEMAS: Record<string, Record<string, unknown>> = {
  "dns records list": {
    operationId: "dns-records-for-a-zone-list-dns-records",
    httpMethod: "GET",
    path: "/zones/{zone_id}/dns_records",
    pathParams: [{ name: "zone_id", type: "string", required: true }],
    queryParams: [{ name: "type", type: "string", required: false }],
    hasRequestBody: false,
    requestBodyFields: [],
  },
  "dns records create": {
    operationId: "dns-records-for-a-zone-create-dns-record",
    httpMethod: "POST",
    path: "/zones/{zone_id}/dns_records",
    pathParams: [{ name: "zone_id", type: "string", required: true }],
    queryParams: [],
    hasRequestBody: true,
    requestBodyFields: [],
  },
};

/** A fake cf that knows two schemas and echoes the argv it ran. */
function fakeCf(argv: string[]): Reply {
  if (argv[0] === "schema") {
    const s = SCHEMAS[argv.slice(1).join(" ")];
    return s ? { stdout: JSON.stringify(s) } : {
      code: 1,
      stderr: `Schema not found for "${argv.slice(1).join(" ")}".`,
    };
  }
  if (argv.includes("--dry-run")) {
    return { stdout: JSON.stringify({ method: "POST", dryRun: true }) };
  }
  return { stdout: JSON.stringify({ ran: argv }) };
}

// ---- pure helpers ---------------------------------------------------------

Deno.test("parseCommand splits, strips a leading cf, and rejects option-like tokens", () => {
  assertEquals(parseCommand("cf dns  records list"), [
    "dns",
    "records",
    "list",
  ]);
  assertThrows(() => parseCommand("dns records list --type A"), Error, "flags");
  assertThrows(() => parseCommand("dns;rm"), Error);
  assertThrows(() => parseCommand("   "), Error, "empty");
});

Deno.test("flagsToArgv renders values and refuses model-owned flags", () => {
  assertEquals(
    flagsToArgv({
      type: "A",
      "per-page": 100,
      proxied: true,
      skip: false,
      tag: ["a", "b"],
    }),
    [
      "--type",
      "A",
      "--per-page",
      "100",
      "--proxied",
      "--tag",
      "a",
      "--tag",
      "b",
    ],
  );
  assertThrows(() => flagsToArgv({ "dry-run": false }), Error, "managed");
  assertThrows(() => flagsToArgv({ zone: "x" }), Error, "managed");
  assertThrows(() => flagsToArgv({ "--profile": "x" }), Error, "managed");
  assertThrows(() => flagsToArgv({ "bad name": "x" }), Error, "valid");
});

Deno.test("cfEnv carries the token in env and disables telemetry by default", () => {
  const env = cfEnv({ ...GLOBAL_ARGS, accountId: "acct" } as never);
  assertEquals(env.CLOUDFLARE_API_TOKEN, TOKEN);
  assertEquals(env.CLOUDFLARE_ACCOUNT_ID, "acct");
  assertEquals(env.CF_SEND_TELEMETRY, "false");
  assertEquals(env.CF_QUIET, "1");
});

Deno.test("captureOutput parses JSON, keeps text, and truncates oversize output", () => {
  assertEquals(captureOutput('{"a":1}', 100).output, { a: 1 });
  assertEquals(captureOutput("plain", 100).outputText, "plain");
  const big = captureOutput("x".repeat(50), 10);
  assertEquals(big.truncated, true);
  assertEquals(big.outputText, "x".repeat(10));
});

Deno.test("each method defaults to its own data name", () => {
  // swamp data names are shared across specs; a common default would make
  // data.latest(model, name) return whichever method ran last.
  const names = [
    model.methods.search.arguments.parse({ query: "q" }).requestId,
    model.methods.schema.arguments.parse({ command: "c" }).requestId,
    model.methods.whoami.arguments.parse({}).requestId,
    model.methods.run.arguments.parse({ command: "c" }).requestId,
  ];
  assertEquals(names, ["search", "operation", "identity", "result"]);
});

// ---- methods --------------------------------------------------------------

Deno.test("search stores matches from cf cli search", async () => {
  const { context: ctx, getWrittenResources } = context("search");
  await withFakeCf(
    () => ({
      stdout: JSON.stringify([
        { command: "cf dns records list", summary: "List DNS Records" },
      ]),
    }),
    async (calls) => {
      await model.methods.search.execute(
        { query: "list dns records", requestId: "unit" },
        ctx,
      );
      assertEquals(calls[0].argv, ["cli", "search", "list dns records"]);
    },
  );
  const [w] = getWrittenResources();
  assertEquals(w.specName, "search");
  assertEquals((w.data as { matches: unknown[] }).matches.length, 1);
});

Deno.test("schema records method, path and readOnly", async () => {
  const { context: ctx, getWrittenResources } = context("schema");
  await withFakeCf(fakeCf, async () => {
    await model.methods.schema.execute(
      { command: "dns records create", requestId: "unit" },
      ctx,
    );
  });
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.httpMethod, "POST");
  assertEquals(data.readOnly, false);
  assertEquals(data.command, "cf dns records create");
});

/** cf auth whoami output for an API token that can read neither /user nor accounts. */
const SCOPED_WHOAMI = {
  authenticated: true,
  authSource: "CLOUDFLARE_API_TOKEN environment variable",
  tokenValid: false,
  accounts: [],
};

/** A fake cf for whoami: whoami output plus per-endpoint verify replies. */
function whoamiCf(
  whoami: Record<string, unknown>,
  verify: { user?: Reply; account?: Reply },
) {
  return (argv: string[]): Reply => {
    const cmd = argv.filter((a) => !a.startsWith("--")).join(" ");
    if (cmd.endsWith("auth whoami")) return { stdout: JSON.stringify(whoami) };
    if (cmd === "user tokens verify") {
      return verify.user ?? { code: 1, stderr: "[1000] Invalid API Token" };
    }
    if (cmd === "accounts tokens verify") {
      return verify.account ?? { code: 1, stderr: "[1000] Invalid API Token" };
    }
    return { code: 1, stderr: `unexpected ${cmd}` };
  };
}

const ACTIVE = { stdout: JSON.stringify({ id: "tok", status: "active" }) };

Deno.test("whoami accepts a scoped token cf mislabels tokenValid=false", async () => {
  // Measured live 2026-09-28: a DNS-only token that /user/tokens/verify reports
  // active came back from cf auth whoami as tokenValid:false, 0 accounts.
  const { context: ctx, getWrittenResources } = context("whoami");
  await withFakeCf(whoamiCf(SCOPED_WHOAMI, { user: ACTIVE }), async (calls) => {
    await model.methods.whoami.execute({ requestId: "unit" }, ctx);
    assertEquals(calls.map((c) => c.argv.join(" ")), [
      "auth whoami",
      "user tokens verify",
    ]);
  });
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.tokenValid, true);
  assertEquals(data.tokenKind, "user");
  assertEquals(data.tokenStatus, "active");
  assertEquals((data.accounts as unknown[]).length, 0);
});

Deno.test("whoami falls back to the account endpoint for an account-owned token", async () => {
  const { context: ctx, getWrittenResources } = context("whoami", {
    ...GLOBAL_ARGS,
    accountId: "acct",
  });
  await withFakeCf(
    whoamiCf(SCOPED_WHOAMI, { account: ACTIVE }),
    async (calls) => {
      await model.methods.whoami.execute({ requestId: "unit" }, ctx);
      assertEquals(calls[2].env.CLOUDFLARE_ACCOUNT_ID, "acct");
    },
  );
  assertEquals(
    (getWrittenResources()[0].data as Record<string, unknown>).tokenKind,
    "account",
  );
});

Deno.test("whoami fails when every verify endpoint rejects the token", async () => {
  const { context: ctx, getWrittenResources } = context("whoami", {
    ...GLOBAL_ARGS,
    accountId: "acct",
  });
  await withFakeCf(whoamiCf(SCOPED_WHOAMI, {}), async () => {
    const err = await assertRejects(
      () => model.methods.whoami.execute({ requestId: "unit" }, ctx),
      Error,
      "rejected the API token",
    );
    assertStringIncludes(err.message, "user:");
    assertStringIncludes(err.message, "account:");
  });
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("whoami hints at accountId when only the user endpoint was tried", async () => {
  const { context: ctx } = context("whoami");
  await withFakeCf(whoamiCf(SCOPED_WHOAMI, {}), async (calls) => {
    await assertRejects(
      () => model.methods.whoami.execute({ requestId: "unit" }, ctx),
      Error,
      "needs accountId",
    );
    assertEquals(calls.length, 2);
  });
});

Deno.test("whoami fails on a verify reply whose status is not active", async () => {
  const { context: ctx } = context("whoami");
  await withFakeCf(
    whoamiCf(SCOPED_WHOAMI, {
      user: { stdout: JSON.stringify({ id: "tok", status: "disabled" }) },
    }),
    async () => {
      await assertRejects(
        () => model.methods.whoami.execute({ requestId: "unit" }, ctx),
        Error,
        "status is disabled",
      );
    },
  );
});

Deno.test("whoami trusts cf's lookup for an OAuth profile", async () => {
  const oauth = {
    authenticated: true,
    authSource: "OAuth token from default profile",
    tokenValid: true,
    accounts: [{ id: "abc", name: "Example Co" }],
  };
  const { context: ctx, getWrittenResources } = context("whoami", {
    ...GLOBAL_ARGS,
    apiToken: undefined,
  });
  await withFakeCf(whoamiCf(oauth, {}), async (calls) => {
    await model.methods.whoami.execute({ requestId: "unit" }, ctx);
    assertEquals(calls.length, 1); // no verify endpoint for OAuth
  });
  assertEquals(
    (getWrittenResources()[0].data as Record<string, unknown>).tokenKind,
    "oauth",
  );

  const bad = context("whoami", { ...GLOBAL_ARGS, apiToken: undefined });
  await withFakeCf(whoamiCf({ ...oauth, tokenValid: false }, {}), async () => {
    await assertRejects(
      () => model.methods.whoami.execute({ requestId: "unit" }, bad.context),
      Error,
      "OAuth credential is not usable",
    );
  });
});

Deno.test("whoami fails when cf finds no credential at all", async () => {
  const { context: ctx } = context("whoami");
  await withFakeCf(
    whoamiCf({ authenticated: false, error: "Not logged in" }, {}),
    async () => {
      await assertRejects(
        () => model.methods.whoami.execute({ requestId: "unit" }, ctx),
        Error,
        "found no credential",
      );
    },
  );
});

Deno.test("run executes a GET operation and stores parsed output", async () => {
  const { context: ctx, getWrittenResources } = context("run");
  await withFakeCf(fakeCf, async (calls) => {
    await model.methods.run.execute({
      command: "dns records list",
      args: [],
      flags: { type: "A" },
      zone: "example.com",
      apply: false,
      requestId: "unit",
    }, ctx);
    assertEquals(calls[0].argv, ["schema", "dns", "records", "list"]);
    assertEquals(calls[1].argv, [
      "dns",
      "records",
      "list",
      "--type",
      "A",
      "--zone",
      "example.com",
    ]);
    // The token never appears in argv.
    for (const c of calls) assertEquals(c.argv.includes(TOKEN), false);
    assertEquals(calls[1].env.CLOUDFLARE_API_TOKEN, TOKEN);
  });
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.mode, "read");
  assertEquals(data.httpMethod, "GET");
});

Deno.test("run dry-runs a write by default", async () => {
  const { context: ctx, getWrittenResources } = context("run");
  await withFakeCf(fakeCf, async (calls) => {
    await model.methods.run.execute({
      command: "dns records create",
      args: [],
      flags: {},
      body: { type: "A", name: "www.example.com", content: "192.0.2.1" },
      apply: false,
      requestId: "unit",
    }, ctx);
    assertEquals(calls[1].argv.at(-1), "--dry-run");
    assertStringIncludes(calls[1].argv.join(" "), '--body {"type":"A"');
  });
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.mode, "dry-run");
  assertEquals(data.output, { method: "POST", dryRun: true });
});

Deno.test("run refuses apply when the model does not allow writes", async () => {
  const { context: ctx, getWrittenResources } = context("run");
  await withFakeCf(fakeCf, async (calls) => {
    await assertRejects(
      () =>
        model.methods.run.execute({
          command: "dns records create",
          args: [],
          flags: {},
          apply: true,
          requestId: "unit",
        }, ctx),
      Error,
      "allowWrites",
    );
    // Only the schema lookup ran; the write was never invoked.
    assertEquals(calls.length, 1);
  });
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("run applies a write when allowWrites and apply are both set", async () => {
  const { context: ctx, getWrittenResources } = context("run", {
    ...GLOBAL_ARGS,
    allowWrites: true,
  });
  await withFakeCf(fakeCf, async (calls) => {
    await model.methods.run.execute({
      command: "dns records create",
      args: [],
      flags: {},
      apply: true,
      requestId: "unit",
    }, ctx);
    assertEquals(calls[1].argv.includes("--dry-run"), false);
  });
  assertEquals(
    (getWrittenResources()[0].data as Record<string, unknown>).mode,
    "apply",
  );
});

Deno.test("run refuses commands that are not API operations", async () => {
  const { context: ctx } = context("run");
  await withFakeCf(fakeCf, async (calls) => {
    await assertRejects(
      () =>
        model.methods.run.execute({
          command: "deploy",
          args: [],
          flags: {},
          apply: false,
          requestId: "unit",
        }, ctx),
      Error,
      "not a generated Cloudflare API operation",
    );
    assertEquals(calls.length, 1);
  });
});

Deno.test("run rejects positionals that look like options", async () => {
  const { context: ctx } = context("run");
  await withFakeCf(fakeCf, async () => {
    await assertRejects(
      () =>
        model.methods.run.execute({
          command: "dns records list",
          args: ["--dry-run=false"],
          flags: {},
          apply: false,
          requestId: "unit",
        }, ctx),
      Error,
      "parsed as an option",
    );
  });
});

Deno.test("run surfaces cf errors with the token redacted", async () => {
  const { context: ctx } = context("run");
  await withFakeCf(
    (argv) =>
      argv[0] === "schema" ? fakeCf(argv) : {
        code: 1,
        stderr: `┌ APIError\n│ [9106] Authentication failed for ${TOKEN}\n└`,
      },
    async () => {
      const err = await assertRejects(
        () =>
          model.methods.run.execute({
            command: "dns records list",
            args: [],
            flags: {},
            apply: false,
            requestId: "unit",
          }, ctx),
        Error,
        "[9106] Authentication failed",
      );
      assertEquals(err.message.includes(TOKEN), false);
    },
  );
});
