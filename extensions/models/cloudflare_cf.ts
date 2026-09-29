/**
 * Cloudflare `cf` CLI — drive Cloudflare's agent-first CLI from swamp.
 *
 * `cf` (https://blog.cloudflare.com/cloudflare-cf-cli-launch/) exposes 3,000+
 * Cloudflare API operations as generated commands of the shape
 * `cf <product> [group…] <operation>`, with JSON on stdout, intent search
 * (`cf cli search`) and per-command API schemas (`cf schema`). This model wraps
 * that surface:
 *
 * - `search` — find the command for a task by describing it.
 * - `schema` — record an operation's HTTP method, path and parameters.
 * - `whoami` — prove the credential works; fails on an invalid token.
 * - `run`    — execute an API operation and store its JSON result.
 *
 * `run` is read-only by default. It classifies every command through
 * `cf schema` first: `GET`/`HEAD` operations execute; anything else runs with
 * `--dry-run`, which records the exact request cf *would* send, unless the
 * model sets `allowWrites` **and** the call passes `apply: true`. Only
 * generated API operations are accepted — project lifecycle commands (`init`,
 * `dev`, `build`, `deploy`, `migrate`) and `auth` profile management have no
 * schema and are refused.
 *
 * The API token is passed to cf through `CLOUDFLARE_API_TOKEN` in the child
 * process environment, never on the command line.
 *
 * @module
 */
// extensions/models/cloudflare_cf.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  apiToken: z.string().min(1).meta({ sensitive: true }).optional().describe(
    "Cloudflare API token, passed to cf as CLOUDFLARE_API_TOKEN. Store in a vault. When omitted, cf falls back to its OAuth profile (`cf auth login`).",
  ),
  accountId: z.string().optional().describe(
    "Default account ID, passed as CLOUDFLARE_ACCOUNT_ID for account-scoped operations.",
  ),
  zone: z.string().optional().describe(
    "Default zone (ID or domain name), passed as --zone. A per-call `zone` overrides it.",
  ),
  profile: z.string().optional().describe(
    "Named cf OAuth profile (--profile). Ignored by cf when apiToken is set.",
  ),
  cfCommand: z.array(z.string().min(1)).min(1).default(["cf"]).describe(
    'Command that launches cf, e.g. ["cf"] or ["npx", "-y", "cf@1.0.0-beta.5"] to pin a version without a global install.',
  ),
  allowWrites: z.boolean().default(false).describe(
    "Permit `run` to execute non-GET operations when the call also passes apply=true. Off by default: writes are dry-run only.",
  ),
  telemetry: z.boolean().default(false).describe(
    "Allow cf's anonymous usage telemetry (CF_SEND_TELEMETRY). Off by default.",
  ),
  timeoutMs: z.number().int().positive().default(120_000).describe(
    "Kill a cf invocation that runs longer than this.",
  ),
  maxOutputBytes: z.number().int().positive().default(256 * 1024).describe(
    "Largest cf stdout persisted per run; larger results are stored truncated as text.",
  ),
  workDir: z.string().optional().describe(
    "Directory cf runs in. cf writes an account cache (.cloudflare/cache/cloudflare-account.json: account ID and name) into its working directory, so it must not be your swamp repo. Default: $XDG_CACHE_HOME/swamp-cloudflare-cf, else ~/.cache/swamp-cloudflare-cf.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** A generated command path segment: `dns`, `records`, `list`, `zero-trust`. */
const COMMAND_TOKEN = /^[a-z0-9][a-z0-9-]*$/;
/** A long flag name without its dashes: `name-contains`, `per-page`. */
const FLAG_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** Flags the model owns; a caller setting them would bypass a guard. */
const RESERVED_FLAGS = new Set([
  "dry-run",
  "body",
  "zone",
  "z",
  "profile",
  "local",
  "persist-to",
  "mode",
  "m",
  "help",
  "h",
  "version",
  "v",
  "quiet",
  "q",
]);
/** HTTP methods `run` executes without apply. */
const READ_METHODS = new Set(["GET", "HEAD"]);

const FlagValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number()])),
]);

const SearchMatchSchema = z.object({
  command: z.string(),
  summary: z.string(),
});

const SearchSchema = z.object({
  query: z.string(),
  matches: z.array(SearchMatchSchema),
  searchedAt: z.string(),
});

const ParamSchema = z.object({
  name: z.string(),
  type: z.string().optional(),
  required: z.boolean().optional(),
}).passthrough();

const OperationSchema = z.object({
  command: z.string(),
  operationId: z.string(),
  httpMethod: z.string(),
  path: z.string(),
  readOnly: z.boolean().describe("True for GET/HEAD operations."),
  pathParams: z.array(ParamSchema),
  queryParams: z.array(ParamSchema),
  hasRequestBody: z.boolean(),
  requestBodyFields: z.array(z.unknown()),
  fetchedAt: z.string(),
});

const IdentitySchema = z.object({
  authenticated: z.boolean(),
  authSource: z.string().nullable(),
  tokenValid: z.boolean().nullable().describe(
    "API tokens: Cloudflare's token-verify endpoint reported the token active. OAuth: cf's own user/account lookup succeeded.",
  ),
  tokenKind: z.enum(["user", "account", "oauth"]).nullable().describe(
    "Which verify endpoint accepted the token — user-owned or account-owned — or oauth for a cf login profile.",
  ),
  tokenStatus: z.string().nullable().describe(
    'Status from the verify endpoint, e.g. "active"; null for OAuth.',
  ),
  expiresOn: z.string().nullable(),
  accounts: z.array(z.record(z.string(), z.unknown())).describe(
    "Accounts cf could list — empty for a token without Account Settings Read, which is not an auth failure.",
  ),
  checkedAt: z.string(),
});

const ResultSchema = z.object({
  command: z.string(),
  argv: z.array(z.string()).describe(
    "Arguments passed to cf (the token travels in the environment, never here).",
  ),
  operationId: z.string(),
  httpMethod: z.string(),
  mode: z.enum(["read", "dry-run", "apply"]).describe(
    "read = GET/HEAD executed; dry-run = write planned, nothing sent; apply = write executed.",
  ),
  exitCode: z.number(),
  output: z.unknown().nullable().describe(
    "Parsed JSON stdout. For a dry-run this is the request cf would have sent.",
  ),
  outputText: z.string().nullable().describe(
    "Raw stdout when it was not JSON or exceeded maxOutputBytes.",
  ),
  truncated: z.boolean(),
  ranAt: z.string(),
});

const SearchArgsSchema = z.object({
  query: z.string().min(1).describe(
    "Describe the task by action and resource type only — cf asks that queries never include names, domains, IDs or tokens.",
  ),
  requestId: z.string().default("search").describe(
    "Data name for the stored search record. Defaults to the spec name so methods never share one. Avoid the reserved name 'latest'.",
  ),
});

const SchemaArgsSchema = z.object({
  command: z.string().min(1).describe(
    'Command path without the leading "cf", e.g. "dns records list".',
  ),
  requestId: z.string().default("operation").describe(
    "Data name for the stored operation record. Defaults to the spec name so methods never share one. Avoid the reserved name 'latest'.",
  ),
});

const WhoamiArgsSchema = z.object({
  requestId: z.string().default("identity").describe(
    "Data name for the stored identity record. Defaults to the spec name so methods never share one. Avoid the reserved name 'latest'.",
  ),
});

const RunArgsSchema = z.object({
  command: z.string().min(1).describe(
    'Command path without the leading "cf", e.g. "dns records list". Find it with the search method.',
  ),
  args: z.array(z.string()).default([]).describe(
    'Positional arguments, e.g. ["<dns-record-id>"] for "dns records get".',
  ),
  flags: z.record(z.string(), FlagValueSchema).default({}).describe(
    'Command options without dashes, e.g. {"type": "A", "per-page": 100}. true emits a bare flag, false is omitted, arrays repeat the flag.',
  ),
  body: z.unknown().optional().describe(
    "Request body, sent as --body. An object or array is JSON-encoded; a string is passed through raw — use a string for octet-stream uploads (KV values, R2 objects), or a pre-serialized JSON document.",
  ),
  zone: z.string().optional().describe(
    "Zone ID or domain for this call; overrides the model's zone.",
  ),
  apply: z.boolean().default(false).describe(
    "Execute a non-GET operation for real. Also requires the model's allowWrites; otherwise the write is a dry-run.",
  ),
  requestId: z.string().default("result").describe(
    "Data name for the stored result record. Defaults to the spec name so methods never share one. Avoid the reserved name 'latest'.",
  ),
});

type Logger = {
  info: (message: string, props?: Record<string, unknown>) => void;
  warn: (message: string, props?: Record<string, unknown>) => void;
};

type DataHandle = unknown;

type MethodContext = {
  globalArgs: GlobalArgs;
  logger: Logger;
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<DataHandle>;
};

/** Outcome of one cf invocation. */
type CfOutput = { code: number; stdout: string; stderr: string };

/** Split and validate a command path like "dns records list". */
export function parseCommand(command: string): string[] {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] === "cf") tokens.shift();
  if (tokens.length === 0 || tokens[0] === "") {
    throw new Error("command is empty");
  }
  for (const t of tokens) {
    if (!COMMAND_TOKEN.test(t)) {
      throw new Error(
        `command token "${t}" is not a cf subcommand name — pass options via flags and IDs via args`,
      );
    }
  }
  return tokens;
}

/** Render the flags record into argv, refusing names the model controls. */
export function flagsToArgv(
  flags: Record<string, z.infer<typeof FlagValueSchema>>,
): string[] {
  const argv: string[] = [];
  for (const [rawName, value] of Object.entries(flags)) {
    const name = rawName.replace(/^-+/, "");
    if (!FLAG_NAME.test(name)) {
      throw new Error(`flag "${rawName}" is not a valid option name`);
    }
    if (RESERVED_FLAGS.has(name)) {
      throw new Error(
        `flag "--${name}" is managed by the model — use the matching method input or global argument`,
      );
    }
    if (value === false) continue;
    if (value === true) {
      argv.push(`--${name}`);
    } else if (Array.isArray(value)) {
      for (const v of value) argv.push(`--${name}`, String(v));
    } else {
      argv.push(`--${name}`, String(value));
    }
  }
  return argv;
}

/**
 * Render `body` for cf's --body. Strings go through untouched: for an
 * octet-stream operation (KV value, R2 object) cf uploads --body verbatim, so
 * JSON-encoding "hello" would store the seven bytes `"hello"` — measured with
 * `cf kv keys put --dry-run` on 2026-09-28. Everything else is JSON.
 */
export function bodyArg(body: unknown): string {
  return typeof body === "string" ? body : JSON.stringify(body);
}

/** Positionals must not be mistaken for options by cf's parser. */
export function checkPositionals(args: string[]): string[] {
  for (const a of args) {
    if (a.startsWith("-")) {
      throw new Error(
        `positional argument "${a}" starts with "-" and would be parsed as an option`,
      );
    }
  }
  return args;
}

/** Environment for the cf child: credentials plus non-interactive output. */
export function cfEnv(globalArgs: GlobalArgs): Record<string, string> {
  const env: Record<string, string> = {
    CF_QUIET: "1",
    NO_COLOR: "1",
    CF_NO_OSC_PROGRESS: "1",
    CF_SEND_TELEMETRY: globalArgs.telemetry ? "true" : "false",
  };
  if (globalArgs.apiToken) env.CLOUDFLARE_API_TOKEN = globalArgs.apiToken;
  if (globalArgs.accountId) env.CLOUDFLARE_ACCOUNT_ID = globalArgs.accountId;
  return env;
}

/** Global cf options every invocation carries. */
function profileArgv(globalArgs: GlobalArgs): string[] {
  return globalArgs.profile ? ["--profile", globalArgs.profile] : [];
}

/**
 * Trim a stderr blob to its informative lines for an error message.
 *
 * cf draws its errors in a box (`┌ Error` / `┌ APIError` … `└`), and for an
 * argument error it prints the command's whole usage text *first* — 160+
 * lines — with the box last. Keeping the head of that would cut off the
 * reason, so when a box is present only the last one is kept.
 */
export function summarise(text: string, token?: string): string {
  const lines = text.split("\n");
  const box = lines.findLastIndex((l) => l.startsWith("┌"));
  const cleaned = (box >= 0 ? lines.slice(box) : lines)
    .map((l) => l.replace(/^[│┌└]\s?/, "").trim())
    .filter((l) => l.length > 0)
    .join(" · ")
    .slice(0, 600);
  return token ? cleaned.split(token).join("[redacted]") : cleaned;
}

/**
 * The directory cf runs in. cf writes `.cloudflare/cache/cloudflare-account.json`
 * — the account ID and an account name that can contain the owner's email —
 * into its *current working directory* (measured 2026-09-28). Inheriting
 * swamp's cwd put that file in the swamp repo, where `git add -A` picked it up.
 * A private per-user cache directory keeps it out of every repo.
 */
export function cfWorkDir(globalArgs: GlobalArgs): string {
  if (globalArgs.workDir) return globalArgs.workDir;
  const xdg = Deno.env.get("XDG_CACHE_HOME");
  const home = Deno.env.get("HOME");
  const base = xdg ||
    (home ? `${home}/.cache` : Deno.env.get("TMPDIR") || "/tmp");
  return `${base.replace(/\/+$/, "")}/swamp-cloudflare-cf`;
}

/**
 * Make relative `file` flag values absolute against swamp's working
 * directory, so moving cf into cfWorkDir does not change what they point at.
 */
export function resolveFileFlags<T>(
  flags: Record<string, T>,
  base: string,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(flags)) {
    const name = k.replace(/^-+/, "");
    out[k] = name === "file" && typeof v === "string" && !v.startsWith("/")
      ? `${base.replace(/\/+$/, "")}/${v}` as T
      : v;
  }
  return out;
}

/** Run cf with the given argv; never throws on a non-zero exit. */
export async function invokeCf(
  globalArgs: GlobalArgs,
  argv: string[],
): Promise<CfOutput> {
  const [bin, ...prefix] = globalArgs.cfCommand;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), globalArgs.timeoutMs);
  try {
    const cwd = cfWorkDir(globalArgs);
    await Deno.mkdir(cwd, { recursive: true, mode: 0o700 });
    const output = await new Deno.Command(bin, {
      args: [...prefix, ...argv],
      cwd,
      env: cfEnv(globalArgs),
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).output();
    const decoder = new TextDecoder();
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new Error(
        `cf ${argv.join(" ")} timed out after ${globalArgs.timeoutMs}ms`,
      );
    }
    if (cause instanceof Deno.errors.NotFound) {
      throw new Error(
        `"${bin}" was not found on PATH — install cf with \`npm i -g cf\` or set cfCommand (e.g. ["npx", "-y", "cf"])`,
      );
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

/** Run cf and parse its stdout as JSON, failing loudly on any error. */
async function cfJson(
  globalArgs: GlobalArgs,
  argv: string[],
): Promise<unknown> {
  const out = await invokeCf(globalArgs, argv);
  if (out.code !== 0) {
    throw new Error(
      `cf ${argv.join(" ")} exited ${out.code}: ${
        summarise(out.stderr || out.stdout, globalArgs.apiToken)
      }`,
    );
  }
  try {
    return JSON.parse(out.stdout);
  } catch {
    throw new Error(
      `cf ${argv.join(" ")} did not return JSON: ${
        summarise(out.stdout, globalArgs.apiToken)
      }`,
    );
  }
}

/**
 * cf's non-interactive answer to a confirmation prompt. Destructive commands
 * (deletes, and anything else that asks "Continue?") print this to stderr and
 * exit **0** having done nothing when there is no TTY and no --force.
 * Measured 2026-09-28 on `cf dns records delete`: exit 0, empty stdout,
 * stderr "This permanently deletes the resource. Continue? (non-interactive;
 * pass --force to confirm) Aborted." — the record was untouched.
 */
const ABORTED_CONFIRMATION = /pass --force to confirm|\bAborted\.?\s*$/m;

/** True when cf exited 0 only because it declined an unconfirmed action. */
export function wasAborted(out: { code: number; stderr: string }): boolean {
  return out.code === 0 && ABORTED_CONFIRMATION.test(out.stderr);
}

/** Result of asking Cloudflare's token-verify endpoints about an API token. */
type TokenVerification = {
  kind: "user" | "account" | null;
  status: string | null;
  expiresOn: string | null;
  error: string | null;
};

/**
 * Verify an API token with Cloudflare's own verify endpoints.
 *
 * `cf auth whoami` does not do this: its `tokenValid` only means "could read
 * /user or list accounts", so a least-privilege token (say, DNS edit on one
 * zone) that is perfectly valid reports `tokenValid: false`. User-owned tokens
 * verify at /user/tokens/verify, account-owned ones at
 * /accounts/{id}/tokens/verify — each rejects the other kind — so the account
 * endpoint is tried when the user one fails and an accountId is configured.
 */
export async function verifyToken(
  globalArgs: GlobalArgs,
): Promise<TokenVerification> {
  const attempts: Array<["user" | "account", string[]]> = [
    ["user", ["user", "tokens", "verify"]],
  ];
  if (globalArgs.accountId) {
    attempts.push(["account", ["accounts", "tokens", "verify"]]);
  }
  const errors: string[] = [];
  for (const [kind, argv] of attempts) {
    const out = await invokeCf(globalArgs, argv);
    if (out.code === 0) {
      try {
        const raw = JSON.parse(out.stdout) as Record<string, unknown>;
        const result = (raw.result ?? raw) as Record<string, unknown>;
        const status = typeof result.status === "string" ? result.status : null;
        return {
          kind,
          status,
          expiresOn: typeof result.expires_on === "string"
            ? result.expires_on
            : null,
          error: status === "active" ? null : `token status is ${status}`,
        };
      } catch {
        errors.push(`${kind}: verify did not return JSON`);
        continue;
      }
    }
    errors.push(
      `${kind}: ${
        summarise(out.stderr || out.stdout, globalArgs.apiToken).slice(0, 160)
      }`,
    );
  }
  return {
    kind: null,
    status: null,
    expiresOn: null,
    error: errors.join("; "),
  };
}

/** Look up an operation's schema; refuses commands that are not API operations. */
async function fetchOperation(
  globalArgs: GlobalArgs,
  tokens: string[],
): Promise<z.infer<typeof OperationSchema>> {
  const out = await invokeCf(globalArgs, ["schema", ...tokens]);
  const command = `cf ${tokens.join(" ")}`;
  if (out.code !== 0) {
    throw new Error(
      `${command} is not a generated Cloudflare API operation (cf schema: ${
        summarise(out.stderr || out.stdout, globalArgs.apiToken).slice(0, 200)
      }). Use the search method to find one.`,
    );
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(out.stdout);
  } catch {
    throw new Error(`cf schema ${tokens.join(" ")} did not return JSON`);
  }
  if (typeof raw.httpMethod !== "string" || typeof raw.path !== "string") {
    throw new Error(
      `cf schema ${tokens.join(" ")} returned no httpMethod/path`,
    );
  }
  const httpMethod = raw.httpMethod.toUpperCase();
  return {
    command,
    operationId: String(raw.operationId ?? ""),
    httpMethod,
    path: raw.path,
    readOnly: READ_METHODS.has(httpMethod),
    pathParams: Array.isArray(raw.pathParams) ? raw.pathParams : [],
    queryParams: Array.isArray(raw.queryParams) ? raw.queryParams : [],
    hasRequestBody: raw.hasRequestBody === true,
    requestBodyFields: Array.isArray(raw.requestBodyFields)
      ? raw.requestBodyFields
      : [],
    fetchedAt: new Date().toISOString(),
  };
}

/** Parse stdout into the stored output fields, honoring the size cap. */
export function captureOutput(
  stdout: string,
  maxBytes: number,
): { output: unknown; outputText: string | null; truncated: boolean } {
  const bytes = new TextEncoder().encode(stdout);
  if (bytes.length > maxBytes) {
    return {
      output: null,
      outputText: new TextDecoder().decode(bytes.slice(0, maxBytes)),
      truncated: true,
    };
  }
  const trimmed = stdout.trim();
  if (trimmed === "") {
    return { output: null, outputText: null, truncated: false };
  }
  try {
    return { output: JSON.parse(trimmed), outputText: null, truncated: false };
  } catch {
    return { output: null, outputText: stdout, truncated: false };
  }
}

export const model = {
  type: "@sntxrr/cloudflare-cf",
  version: "2026.09.29.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    "search": {
      description: "Commands matching a `cf cli search` intent query",
      schema: SearchSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "operation": {
      description:
        "API schema of one cf command: HTTP method, path and parameters",
      schema: OperationSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    "identity": {
      description: "Authentication status reported by `cf auth whoami`",
      schema: IdentitySchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "result": {
      description:
        "Outcome of a `run`: the argv, read/dry-run/apply mode, and parsed JSON output",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    search: {
      description:
        "Find the cf command for a task by describing it (cf cli search)",
      arguments: SearchArgsSchema,
      execute: async (
        args: z.infer<typeof SearchArgsSchema>,
        context: MethodContext,
      ) => {
        const { globalArgs, logger } = context;
        const parsed = await cfJson(globalArgs, ["cli", "search", args.query]);
        const matches = z.array(SearchMatchSchema).parse(parsed);
        const handle = await context.writeResource("search", args.requestId, {
          query: args.query,
          matches,
          searchedAt: new Date().toISOString(),
        });
        logger.info("Found {count} command(s); best match {best}", {
          count: matches.length,
          best: matches[0]?.command ?? "none",
        });
        return { dataHandles: [handle] };
      },
    },
    schema: {
      description:
        "Record a cf command's API operation: HTTP method, path and parameters",
      arguments: SchemaArgsSchema,
      execute: async (
        args: z.infer<typeof SchemaArgsSchema>,
        context: MethodContext,
      ) => {
        const { globalArgs, logger } = context;
        const op = await fetchOperation(
          globalArgs,
          parseCommand(args.command),
        );
        const handle = await context.writeResource(
          "operation",
          args.requestId,
          op,
        );
        logger.info("{command} → {method} {path}", {
          command: op.command,
          method: op.httpMethod,
          path: op.path,
        });
        return { dataHandles: [handle] };
      },
    },
    whoami: {
      description:
        "Verify the configured credential: API tokens against Cloudflare's token-verify endpoints, OAuth via cf auth whoami; fails when it is not usable",
      arguments: WhoamiArgsSchema,
      execute: async (
        args: z.infer<typeof WhoamiArgsSchema>,
        context: MethodContext,
      ) => {
        const { globalArgs, logger } = context;
        const raw = await cfJson(globalArgs, [
          ...profileArgv(globalArgs),
          "auth",
          "whoami",
        ]) as Record<string, unknown>;
        const authenticated = raw.authenticated === true;
        const authSource = typeof raw.authSource === "string"
          ? raw.authSource
          : null;
        if (!authenticated) {
          throw new Error(
            `cf found no credential (source=${
              authSource ?? "none"
            }) — set apiToken or run \`cf auth login\``,
          );
        }

        // An API token is judged by Cloudflare's verify endpoints, not by
        // cf's tokenValid (see verifyToken). OAuth profiles have no verify
        // endpoint, so cf's own lookup is the best signal there.
        const isApiToken = (authSource ?? "").includes("CLOUDFLARE_API_TOKEN");
        let tokenValid: boolean | null;
        let tokenKind: "user" | "account" | "oauth" | null;
        let tokenStatus: string | null = null;
        let expiresOn: string | null = null;
        if (isApiToken) {
          const v = await verifyToken(globalArgs);
          if (v.error) {
            throw new Error(
              `Cloudflare rejected the API token (${v.error})${
                globalArgs.accountId
                  ? ""
                  : " — an account-owned token also needs accountId set"
              }`,
            );
          }
          tokenValid = true;
          tokenKind = v.kind;
          tokenStatus = v.status;
          expiresOn = v.expiresOn;
        } else {
          tokenValid = typeof raw.tokenValid === "boolean"
            ? raw.tokenValid
            : null;
          tokenKind = "oauth";
          expiresOn = typeof raw.expiresAt === "string" ? raw.expiresAt : null;
          if (tokenValid === false) {
            throw new Error(
              `cf OAuth credential is not usable (source=${
                authSource ?? "none"
              })`,
            );
          }
        }

        const identity = {
          authenticated,
          authSource,
          tokenValid,
          tokenKind,
          tokenStatus,
          expiresOn,
          accounts: Array.isArray(raw.accounts)
            ? raw.accounts as Record<string, unknown>[]
            : [],
          checkedAt: new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "identity",
          args.requestId,
          identity,
        );
        logger.info(
          "Authenticated via {source} ({kind} token, {status}); {count} account(s) visible",
          {
            source: identity.authSource ?? "unknown",
            kind: identity.tokenKind ?? "unknown",
            status: identity.tokenStatus ?? "n/a",
            count: identity.accounts.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    run: {
      description:
        "Run a cf API operation and store its JSON result; non-GET operations are dry-run unless allowWrites and apply are both set",
      arguments: RunArgsSchema,
      execute: async (
        args: z.infer<typeof RunArgsSchema>,
        context: MethodContext,
      ) => {
        const { globalArgs, logger } = context;
        const tokens = parseCommand(args.command);
        const op = await fetchOperation(globalArgs, tokens);

        let mode: "read" | "dry-run" | "apply" = "read";
        if (!op.readOnly) {
          if (args.apply && !globalArgs.allowWrites) {
            throw new Error(
              `${op.command} is a ${op.httpMethod} operation and this model does not set allowWrites — refusing to apply`,
            );
          }
          mode = args.apply ? "apply" : "dry-run";
        }

        const zone = args.zone ?? globalArgs.zone;
        const argv = [
          ...profileArgv(globalArgs),
          ...tokens,
          ...checkPositionals(args.args),
          ...flagsToArgv(resolveFileFlags(args.flags, Deno.cwd())),
          ...(zone ? ["--zone", zone] : []),
          ...(args.body !== undefined ? ["--body", bodyArg(args.body)] : []),
          ...(mode === "dry-run" ? ["--dry-run"] : []),
        ];

        logger.info("{mode}: {method} {command}", {
          mode,
          method: op.httpMethod,
          command: op.command,
        });

        const out = await invokeCf(globalArgs, argv);
        if (out.code !== 0) {
          throw new Error(
            `${op.command} exited ${out.code}: ${
              summarise(out.stderr || out.stdout, globalArgs.apiToken)
            }`,
          );
        }
        // Exit 0 is not proof the action ran: see ABORTED_CONFIRMATION.
        if (wasAborted(out)) {
          throw new Error(
            `${op.command} asked for confirmation and cf aborted it — nothing was ${
              mode === "apply" ? "changed" : "run"
            }. Re-run with flags: {"force": true} to confirm this ${op.httpMethod}.`,
          );
        }

        // cf prints a dry-run plan to stdout for some operations and stderr
        // for others; keep whichever carried it.
        const payload = mode === "dry-run" && out.stdout.trim() === ""
          ? out.stderr
          : out.stdout;
        const captured = captureOutput(payload, globalArgs.maxOutputBytes);
        if (captured.truncated) {
          logger.warn(
            "Output exceeded {max} bytes and was stored truncated as text",
            { max: globalArgs.maxOutputBytes },
          );
        }

        const handle = await context.writeResource("result", args.requestId, {
          command: op.command,
          argv,
          operationId: op.operationId,
          httpMethod: op.httpMethod,
          mode,
          exitCode: out.code,
          ...captured,
          ranAt: new Date().toISOString(),
        });
        if (mode === "dry-run") {
          logger.info(
            "Dry-run only — nothing was sent. Set allowWrites on the model and apply=true to execute.",
          );
        }
        return { dataHandles: [handle] };
      },
    },
  },
  reports: ["@sntxrr/cf-activity"],
  upgrades: [
    {
      toVersion: "2026.09.28.2",
      description:
        "whoami verifies API tokens with Cloudflare's verify endpoints; no globalArguments change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.28.3",
      description:
        "run fails when cf aborts an unconfirmed action instead of recording it as applied; no globalArguments change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.29.1",
      description:
        "string bodies pass raw; errors keep cf's error box; cf runs in a private workDir (new optional global argument, default applied — no migration needed)",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.29.2",
      description:
        "cf-activity counts every retained version of each result, not just the latest; no globalArguments change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
};
