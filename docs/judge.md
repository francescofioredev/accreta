# The judge

An optional model that answers narrow questions about text as probabilities. It is advisory:
it never edits a page and never changes `last_verified_revision`
([ADR-0014](adr/0014-an-optional-judge-port.md)). With no `judge:` block accreta makes no
network call and behaves as it does without this feature.

## Privacy

**Page text leaves your machine.** Reranking sends each candidate's title and summary to the
judge; checking a citation sends the claim and the cited lines. Do not enable a judge on a
knowledge base whose content may not go to the route you choose.

## Configure

```yaml
judge:
  route: typesafe # typesafe | cloudflare | local
  model: jev-latest # optional; the route has a default
  api_key_env: ACCRETA_JUDGE_KEY # the NAME of the variable, never the key
  rerank:
    top: 20 # hits offered to the judge, 1 to 50
  support:
    threshold: 0.73
```

Each setting can be overridden by `ACCRETA_JUDGE_ROUTE`, `ACCRETA_JUDGE_MODEL`,
`ACCRETA_JUDGE_API_KEY_ENV`, `ACCRETA_JUDGE_RERANK_TOP` and `ACCRETA_JUDGE_SUPPORT_THRESHOLD`.

Two rules keep a cloned knowledge base from taking your key somewhere else:

- **The URL comes only from the environment.** `ACCRETA_JUDGE_URL` moves a route; a `url:` in
  `accreta.config.yaml` is never read: doctor and the judge refuse it, or ignore it when
  `ACCRETA_JUDGE_URL` is set. The `typesafe` route has a default host.
- **`api_key_env` must name a variable starting with `ACCRETA_JUDGE_`.** The key is read from
  that variable and from nowhere else; it is never a config value.

### Routes

| Route        | Where it posts                          | Needs                                                         |
| ------------ | --------------------------------------- | ------------------------------------------------------------- |
| `typesafe`   | the TypeSafe API                        | a key                                                         |
| `cloudflare` | Workers AI; the account is in the URL   | a key, and `ACCRETA_JUDGE_URL` with `{model}` in it           |
| `local`      | any server speaking the same wire format | `ACCRETA_JUDGE_URL`; a key only if your server asks for one |

A `local` server that wants a key is reached the same way: set `ACCRETA_JUDGE_URL` and the key
variable in the shell. A `url:` in the file would be refused, not guessed at.

## Keys, least privilege

Create a key used for nothing else, so it can be revoked alone. Check the exact steps in each
vendor's console; they change.

- **typesafe**: a key for the API only, and no other scope.
- **cloudflare**: an API token limited to Workers AI, restricted to the one account.
- **local**: whatever your server needs, and no more.

Put it in the environment (a shell profile, a secret manager), never in `accreta.config.yaml`
or a page.

## Check it

`accreta doctor` prints a `judge` section when the block exists:

- the variable's name and whether it is set, never its value;
- one live probe, with the latency and the model the server says answered;
- a failure, and exit code 1, if a key sits in `accreta.config.yaml` or a knowledge-base page,
  or if `judge.url` is in the file;
- one warning, and exit code 0, if the judge cannot be reached: search and lint carry on
  without it.
