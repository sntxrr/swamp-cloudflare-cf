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
  tokenValid: z.boolean().nullable(),
  accounts: z.array(z.record(z.string(), z.unknown())),
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
    "JSON request body, sent as --body (bypasses individual body flags).",
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

/** Trim a stderr blob to its informative lines for an error message. */
function summarise(text: string, token?: string): string {
  const cleaned = text
    .split("\n")
    .map((l) => l.replace(/^[│┌└]\s?/, "").trim())
    .filter((l) => l.length > 0)
    .join(" · ")
    .slice(0, 600);
  return token ? cleaned.split(token).join("[redacted]") : cleaned;
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
    const output = await new Deno.Command(bin, {
      args: [...prefix, ...argv],
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
  version: "2026.09.28.1",
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
        "Verify the configured credential with cf auth whoami; fails when the token is invalid",
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
        const identity = {
          authenticated: raw.authenticated === true,
          authSource: typeof raw.authSource === "string"
            ? raw.authSource
            : null,
          tokenValid: typeof raw.tokenValid === "boolean"
            ? raw.tokenValid
            : null,
          accounts: Array.isArray(raw.accounts)
            ? raw.accounts as Record<string, unknown>[]
            : [],
          checkedAt: new Date().toISOString(),
        };
        // cf reports authenticated=true for any token it *found*, valid or
        // not — tokenValid is the field that proves the credential works.
        if (!identity.authenticated || identity.tokenValid === false) {
          throw new Error(
            `cf credential is not usable (authenticated=${identity.authenticated}, tokenValid=${identity.tokenValid}, source=${
              identity.authSource ?? "none"
            })`,
          );
        }
        const handle = await context.writeResource(
          "identity",
          args.requestId,
          identity,
        );
        logger.info("Authenticated via {source}; {count} account(s)", {
          source: identity.authSource ?? "unknown",
          count: identity.accounts.length,
        });
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
          ...flagsToArgv(args.flags),
          ...(zone ? ["--zone", zone] : []),
          ...(args.body !== undefined
            ? ["--body", JSON.stringify(args.body)]
            : []),
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
};
