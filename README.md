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

```bash
deno test --allow-net extensions/models/ extensions/reports/
```

See [`extensions/README.md`](extensions/README.md#testing) for an end-to-end run
that needs no real credential.

## Development

```bash
swamp extension quality extensions/manifest.yaml
swamp extension push    extensions/manifest.yaml --dry-run
```

## License

[MIT](extensions/LICENSE.md)
