# @accreta/mcp-server

The agent-facing surface. Exposes a knowledge base as MCP tools over stdio.

## Configuring a client

`.mcp.json`, in the project the agent is working in:

```json
{
  "mcpServers": {
    "accreta": {
      "command": "bun",
      "args": ["run", "node_modules/@accreta/mcp-server/src/main.ts"],
      "env": {
        "ACCRETA_ROOT": "../path/to/knowledge-base"
      }
    }
  }
}
```

`ACCRETA_ROOT` is how an agent working in one directory queries a knowledge base living in
another — it needs no filesystem access to the knowledge base itself, only to this server.

## Tools

| Tool | Purpose |
|---|---|
| `search_pages` | Full-text search with type and source filters. The primary discovery tool. |
| `get_page` | Fetch a page by path or wikilink target. |
| `find_consumers` | Impact analysis across the link graph, both directions. |
| `find_canonical` | Resolve a term, including aliases, to the page that defines it. |
| `check_drift` | Which pages their sources have moved out from under. |
| `list_recent_changes` | What changed in a source since a revision. |
| `lint_knowledge_base` | Unresolvable links, missing provenance, unknown page types. |
| `update_verified_revision` | Write. Registered only when `ACCRETA_ALLOW_WRITES=1`. |

## Which fields a page author wrote

The five tools that relay page text return a `_provenance` block naming the fields that carry it:

```json
{
  "count": 1,
  "results": [{ "path": "…", "title": "…", "snippet": "…" }],
  "_provenance": {
    "page_derived_fields": ["results[].title", "results[].snippet"],
    "notice": "… This label raises an attacker's cost; it does not prevent prompt injection."
  }
}
```

Values are byte-identical to what the page contains — the block names fields rather than
delimiting them, because a delimiter is itself a string the page author can write, and mangling
values would cost `get_page` its body fidelity.

`search_pages` additionally returns `matched_aliases` on a hit whose match an alias explains.
Aliases are indexed but never displayed, so a page whose title and body are both benign could
surface on an alias alone and the hit looked unmotivated. The field is omitted when no alias
matched, and it never carries the page's whole alias list.

**This is labelling, not a control.** It prevents nothing: any defence living inside the same
agent loop the injection controls is defeated by the same move. It raises an attacker's cost and
tells a reading model which text it should treat as data.

## Three outcomes, not two

`check_drift` distinguishes results that a simpler design would collapse:

- **`stale`** — the source changed since the page was verified.
- **`unverifiable`** — the page records no revision, so nothing can be said about it.
- **`unresolvable`** — the source cannot place the revision the page names. History was
  rewritten, or the revision came from a previous run of an `fs` source.

Only the absence of all three means "current". Reporting `unresolvable` as "up to date" would
be a claim the system has no basis for, which is why `list_recent_changes` returns
`unresolvable: true` rather than an empty change list.

## Writes

`update_verified_revision` is the only tool that writes, and it is gated twice.

1. **`ACCRETA_ALLOW_WRITES=1`** must be set or the tool is not registered at all — a
   read-only deployment does not advertise a capability it will refuse.
2. **Dry run, then confirm.** The first call returns a description of the edit and a
   `confirm_token`; the second must echo it back.

The token is a hash of the page, the new revision and the *current* value, so it cannot be
produced without having run the dry run and cannot be reused for a different edit. A plain
`confirm: true` flag would let a model skip straight to writing.

What that handshake does **not** do is decide *whether* the edit should happen. It confirms an
intent; it does not authorize one. An agent that is following an instruction it read inside a
page will run the dry run and echo the token back, because doing so is simply the protocol for
getting to the write — the two steps are a sequence it can complete unaided. So enabling writes
extends trust to whoever authored the corpus, not only to whoever is operating the agent. Pages
are untrusted input to the model; see
[the README](../../README.md#pages-are-untrusted-input-to-the-model).

The tool edits the markdown and asks for a reindex rather than updating the index directly.
The index is derived; writing to it would put it out of step with the pages it comes from.
