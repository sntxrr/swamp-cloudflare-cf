# @sntxrr/cloudflare-cf

Swamp model for Cloudflare's agent-first
[`cf` CLI](https://blog.cloudflare.com/cloudflare-cf-cli-launch/), which exposes
3,000+ Cloudflare API operations as generated commands of the shape
`cf <product> [group…] <operation>`, with JSON output, intent search and
per-command API schemas.

The model lets a swamp agent **find** the right command, **inspect** the API
request behind it, **verify** its credential, and **run** it — with every
non-`GET` operation dry-run by default.

## Requirements

`cf` on the `PATH` of the process running swamp (`npm i -g cf`), or point the
`cfCommand` global argument at another launcher, e.g.
`["npx", "-y", "cf@1.0.0-beta.5"]` to pin a version without a global install.

## Setup

Store an API token in a vault rather than passing it inline:

```bash
swamp vault create local_encryption cf-secrets --json
echo "$CLOUDFLARE_API_TOKEN" | swamp vault put cf-secrets CLOUDFLARE_API_TOKEN --json
```

Create a model instance, wiring the token from the vault:

```bash
swamp model create @sntxrr/cloudflare-cf example-account \
  --global-arg 'apiToken=${{ vault.get(cf-secrets, CLOUDFLARE_API_TOKEN) }}' \
  --global-arg zone=example.com
```

Global arguments:

| Arg              | Default    | Description                                                                                  |
| ---------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `apiToken`       | —          | API token, passed to cf as `CLOUDFLARE_API_TOKEN` in the child env. **Store in a vault.** Omit to use cf's OAuth profile. |
| `accountId`      | —          | Default account, passed as `CLOUDFLARE_ACCOUNT_ID`.                                          |
| `zone`           | —          | Default zone ID or domain, passed as `--zone`. A domain name is resolved through the account, so a token without Account Settings Read also needs `accountId` (or pass the zone ID). |
| `profile`        | —          | Named cf OAuth profile (`--profile`).                                                        |
| `cfCommand`      | `["cf"]`   | Command that launches cf.                                                                    |
| `allowWrites`    | `false`    | Permit `run` to execute non-`GET` operations when the call also sets `apply=true`.           |
| `telemetry`      | `false`    | Allow cf's anonymous usage telemetry (`CF_SEND_TELEMETRY`).                                  |
| `timeoutMs`      | `120000`   | Kill a cf invocation that runs longer than this.                                             |
| `maxOutputBytes` | `262144`   | Largest stdout persisted per run; larger results are stored truncated as text.               |
| `workDir`        | `~/.cache/swamp-cloudflare-cf` | Directory `cf` runs in (`$XDG_CACHE_HOME/swamp-cloudflare-cf` when set). `cf` writes an account cache — account ID and an account name that can contain the owner's email — into its working directory, so it must never be a repo. Relative `flags.file` paths still resolve against swamp's directory. |

The token only ever travels in the child process environment — it is never on
the cf command line, never in stored `argv`, and redacted from error messages.

## Methods

Each method stores its record under its own default data name — `search`,
`operation`, `identity`, `result` — so `data.latest("<model>", "result")` always
means the last `run`. Pass `requestId` to keep several side by side.

### `search`

Find the command for a task by describing it (`cf cli search`). Describe the
action and resource type only — cf asks that queries never include names,
domains, IDs or tokens.

```bash
swamp model method run example-account search --input 'query=list dns records'
```

Writes the `search` resource: the query and up to five `{command, summary}`
matches.

### `schema`

Record the API operation behind a command (`cf schema`): operation ID, HTTP
method, path, path/query parameters, and whether it is read-only.

```bash
swamp model method run example-account schema --input 'command=dns records create'
```

Writes the `operation` resource.

### `whoami`

Verify the credential. An API token is checked against Cloudflare's own
token-verify endpoints: `/user/tokens/verify` first, then
`/accounts/{id}/tokens/verify` when `accountId` is set, because an
account-owned token only verifies there. The method fails unless one of them
reports the token `active`. An invalid token is always a failure.

`cf auth whoami`'s own `tokenValid` field is **not** used for API tokens. It
only means "could read `/user` or list accounts", so a correctly scoped token
(say, DNS edit on one zone) reports `tokenValid: false` even though it works.
The field is used only for OAuth profiles, where no verify endpoint exists.

```bash
swamp model method run example-account whoami
```

It writes the `identity` resource with `tokenValid`, `tokenKind`
(`user` / `account` / `oauth`), `tokenStatus`, `expiresOn`, the auth source and
the accounts `cf` could list. An empty `accounts` list just means the token
lacks Account Settings Read; it is not an auth failure.

### `run`

Run a generated API operation and store its JSON result.

```bash
# Read — executes immediately
swamp model method run example-account run \
  --input 'command=dns records list' \
  --input-file <(echo '{"flags": {"type": "A"}}')

# Write — dry-run: records the exact request cf would send, sends nothing
swamp model method run example-account run \
  --input 'command=dns records create' \
  --input-file <(echo '{"body": {"type": "A", "name": "www.example.com", "content": "192.0.2.1"}}')
```

Inputs:

| Input       | Description                                                                               |
| ----------- | ----------------------------------------------------------------------------------------- |
| `command`   | Command path without the leading `cf`, e.g. `dns records get`.                            |
| `args`      | Positional arguments, e.g. `["<dns-record-id>"]`. Values starting with `-` are refused.   |
| `flags`     | Options without dashes: `{"per-page": 100, "proxied": true}`. `true` = bare flag, `false` = omitted, arrays repeat. |
| `body`      | Request body, sent as `--body`. An object is JSON-encoded; a **string is sent raw**, which is what octet-stream uploads (KV values, R2 objects) need. Use `flags: {"file": "/abs/path"}` for multipart uploads such as `dns records import`. |
| `zone`      | Zone for this call; overrides the model's `zone`.                                         |
| `apply`     | Execute a non-`GET` operation for real (also needs the model's `allowWrites`).            |
| `requestId` | Stored data name (default `result`; `latest` is reserved by swamp).                       |

How `run` decides what to do:

1. It looks the command up with `cf schema`. Anything without a schema — `init`,
   `dev`, `build`, `deploy`, `migrate`, `auth …` — is refused; `run` only runs
   generated API operations.
2. `GET`/`HEAD` operations execute (`mode: read`).
3. Any other method runs with `--dry-run` (`mode: dry-run`) and stores the
   planned request: method, URL, path params and body. `cf` does not look up
   a zone *name* during a dry-run, so the URL shows `/zones/example.com/…`
   where the real call uses the zone ID.
4. Only when the model sets `allowWrites: true` **and** the call passes
   `apply=true` does the write execute (`mode: apply`). `apply=true` without
   `allowWrites` fails before cf is invoked.
5. Destructive operations such as deletes also need `flags: {"force": true}`.
   Without a terminal and without `--force`, `cf` declines its own "Continue?"
   prompt, prints `Aborted.` and **exits 0 having changed nothing**. `run`
   detects this and fails, telling you to re-run with `force`. An aborted write
   is never stored, so `cf-activity` never counts it as applied.

```bash
swamp model method run example-account run \
  --input 'command=dns records delete' \
  --input-file <(echo '{"args": ["<dns-record-id>"], "flags": {"force": true}, "apply": true}')
```

Flags the model owns (`dry-run`, `body`, `zone`, `profile`, `local`, `help`, …)
cannot be set through `flags`, so a caller cannot sidestep the dry-run guard.

The `result` resource records the command, argv, operation ID, HTTP method,
mode, exit code, and the parsed JSON output (or raw text when stdout was not
JSON or exceeded `maxOutputBytes`).

> Some operations return credentials — creating an API token, for example.
> Their responses are stored in swamp data like any other result. Keep such
> operations out of models whose data is shared, or rotate what they return.

## Reports

### `@sntxrr/cf-activity`

A model-scope report bundled with this extension. It runs after the model's
method executions and summarizes every retained `result` version: counts of
reads, dry-runs and applied writes, a per-command table, and a log of every
applied write.

```bash
swamp report get @sntxrr/cf-activity --model example-account --markdown
```

Labels: `cloudflare`, `audit`, `cf`. Skip it with
`--skip-report @sntxrr/cf-activity`.

## Testing

Unit tests (a fake `Deno.Command` — no cf binary, no network, no token):

```bash
deno test -A extensions/models/ extensions/reports/
```

End-to-end without a real credential: `search`, `schema` and a dry-run `run`
never need a valid token, and a bogus one proves the failure paths.

```bash
swamp vault create local_encryption cf-test-secrets
printf 'not-a-real-token' | swamp vault put cf-test-secrets CLOUDFLARE_API_TOKEN
swamp model create @sntxrr/cloudflare-cf cf-tester \
  --global-arg 'apiToken=${{ vault.get(cf-test-secrets, CLOUDFLARE_API_TOKEN) }}' \
  --global-arg zone=0123456789abcdef0123456789abcdef

swamp model method run cf-tester search --input 'query=list dns records'   # succeeds
swamp model method run cf-tester run --input 'command=dns records create' \
  --input-file <(echo '{"body": {"type": "A", "name": "www.example.com", "content": "192.0.2.1"}}')  # dry-run
swamp model method run cf-tester whoami                                   # fails: tokenValid=false
swamp model method run cf-tester run --input 'command=dns records list'   # fails: [9106] Authentication failed
swamp model delete cf-tester --force
```

## Safety notes

- Writes are dry-run unless both `allowWrites` and `apply` are set. Review the
  stored dry-run plan before applying.
- Use a token scoped to exactly the operations the model needs; cf's 3,000+
  operations are all reachable through `run`.
- `run` makes one attempt and never retries a write.
- cf is in beta (`1.0.0-beta.x`) and its command surface tracks Cloudflare's
  public OpenAPI release — pin `cfCommand` to a version for repeatable runs.
