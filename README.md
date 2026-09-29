# swamp-cloudflare-cf

A [swamp](https://github.com/swamp-club/swamp) extension for Cloudflare's
agent-first [`cf` CLI](https://blog.cloudflare.com/cloudflare-cf-cli-launch/).

`cf` exposes 3,000+ Cloudflare API operations as generated commands, with JSON
output, natural-language command search and per-command API schemas. This
extension lets a swamp agent **find** a command, **inspect** the request behind
it, **verify** its credential, and **run** it — reads execute, writes are
**dry-run by default** and only apply when the model opts in and the call asks.

## Contents

| Kind       | Name                                                              | Description                                                                   |
| ---------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Model**  | [`@sntxrr/cloudflare-cf`](extensions/models/cloudflare_cf.ts)     | Search, inspect and run cf API operations, with a dry-run write guard.        |
| **Report** | [`@sntxrr/cf-activity`](extensions/reports/cf_activity.ts)        | Model-scope audit — reads vs dry-runs vs applied writes, per command.         |

## Model: `@sntxrr/cloudflare-cf`

| Method   | What it does                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------ |
| `search` | `cf cli search` — find the command for a task described in plain words.                          |
| `schema` | `cf schema` — record an operation's HTTP method, path and parameters.                            |
| `whoami` | Verifies the token with Cloudflare's token-verify endpoints and fails unless it is `active`. Scoped tokens pass. |
| `run`    | Run an API operation. `GET` executes; other methods are `--dry-run` unless `allowWrites` + `apply`. |

## Quick start

```bash
npm i -g cf
swamp extension pull @sntxrr/cloudflare-cf

swamp vault create local_encryption cf-secrets
echo "$CLOUDFLARE_API_TOKEN" | swamp vault put cf-secrets CLOUDFLARE_API_TOKEN

swamp model create @sntxrr/cloudflare-cf example-account \
  --global-arg 'apiToken=${{ vault.get(cf-secrets, CLOUDFLARE_API_TOKEN) }}' \
  --global-arg zone=example.com

swamp model method run example-account whoami
swamp model method run example-account search --input 'query=list dns records'
swamp model method run example-account run --input 'command=dns records list'
swamp data get example-account result --json
```

A write is planned, not sent, until you opt in:

```bash
swamp model method run example-account run \
  --input 'command=dns records create' \
  --input-file <(echo '{"body": {"type": "A", "name": "www.example.com", "content": "192.0.2.1"}}')
# mode: dry-run — output holds the exact POST cf would send
```

Full method reference, global arguments and safety notes live in
[`extensions/README.md`](extensions/README.md).

## Reports

### `@sntxrr/cf-activity`

```bash
swamp report get @sntxrr/cf-activity --model example-account --markdown
```

```
## cf activity — example-account

**6** run(s) · **4** read · **1** dry-run · **1** applied write(s)

| Command                 | Method | Read | Dry-run | Applied |
| ----------------------- | ------ | ---: | ------: | ------: |
| `cf dns records create` | POST   |    0 |       1 |       1 |
| `cf dns records list`   | GET    |    4 |       0 |       0 |
```

## Testing

### Unit tests

```bash
deno test -A extensions/models/ extensions/reports/
```

### Live end-to-end suite

[`e2e/live.ts`](e2e/live.ts) drives the real `swamp` CLI against a real
Cloudflare account. `cf` has ~2,900 operations, but they reduce to a few
shapes the model has to handle, and the suite covers each one on a real
resource:

| Dimension | Covered |
| --------- | ------- |
| Method | GET, POST, PUT, PATCH, DELETE (unconfirmed → must fail; `--force` → deletes) |
| Scope | zone, account, radar, and OAuth auth |
| Request body | none, JSON, octet-stream (KV value, R2 object), multipart (BIND import) |
| Response | JSON, raw text (zone export, KV/R2 values byte-exact), truncation |
| Errors | 404, client-side validation, non-API command, model-owned flag, apply without `allowWrites` |
| Hygiene | `cf`'s account cache never lands in the swamp repo (checked with and without `accountId`) |

```bash
npx -y cf@1.0.0-beta.5 auth login                             # once; the suite uses cf's OAuth profile
CF_E2E_ZONE=example.com deno run -A e2e/live.ts               # reads + dry-runs only
CF_E2E_ZONE=example.com deno run -A e2e/live.ts --apply       # + write round-trips
```

By default it only reads and dry-runs, and the model it creates has
`allowWrites=false`, so nothing can be written. `--apply` adds create →
update → delete round-trips on throwaway `swamp-e2e-<run>` resources (a TXT
record, a KV namespace, a D1 database, an R2 bucket), each deleted and verified
gone by listing at the end. A list that errors is reported `UNVERIFIED`, never
clean. `--source published` tests the registry version instead of the local
source; `--skip r2` skips R2 when it is not enabled on the account.

See [`extensions/README.md`](extensions/README.md#testing) for an end-to-end run
that needs no real credential.

## Development

```bash
swamp extension quality extensions/manifest.yaml
swamp extension push    extensions/manifest.yaml --dry-run
```

## License

[MIT](extensions/LICENSE.md)
