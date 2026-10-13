# Governing who reads which part of a knowledge base

> A survey, not a decision. October 2026. The decision it feeds is ADR-0018.
> Entries marked *partly verified* were checked against a bibliography record or a search
> result, not the primary text. Every URL was fetched on 2026-10-13.

The question: can accreta let a team give people, teams and roles access to separate areas
of one knowledge base, laid out as a folder tree? Two facts about accreta frame every source
below.

- **Reading can only be governed where accreta stands between the reader and the pages.**
  Locally it does not: whoever has the repository has every page, and git cannot restrict
  reads by path. The hosted server (#145, #146, #147) is the first place a read check can
  live.
- **accreta does not see most writes.** The agent writes pages with its own file tools.
  Write governance belongs to the repository — review, CODEOWNERS — not to accreta.

## 1. Access-control models

- **Sandhu, Coyne, Feinstein, Youman, "Role-Based Access Control Models", IEEE Computer
  29(2):38–47, 1996.** Permissions attach to roles, users to roles. The
  vocabulary a config file can carry without knowing anyone's identity.
- **NIST RBAC, ANSI/INCITS 359-2004, revised 2012.**
  <https://csrc.nist.gov/projects/role-based-access-control>
- **NIST SP 800-162, Guide to ABAC (2014, updated 2019).**
  <https://csrc.nist.gov/pubs/sp/800/162/upd2/final> Decisions from subject, object and
  environment attributes. A page's folder and a source's audience are object attributes.
- **Pang et al., "Zanzibar: Google's Consistent, Global Authorization System", USENIX ATC
  2019.** <https://www.usenix.org/conference/atc19/presentation/pang> Folder inheritance as a
  rewrite rule ("viewers of the parent folder are also viewers of the document"). Its "new enemy"
  problem — Alice removes Bob from a folder, then adds new documents; Bob must not see them —
  is the consistency requirement any ACL change in accreta has to meet.
- **OpenFGA, SpiceDB, Permify.** <https://openfga.dev/docs/modeling/parent-child>,
  <https://authzed.com/docs/spicedb/concepts/schema>,
  <https://fusionauth.io/permify-docs/getting-started/modeling> Open Zanzibar descendants.
  Inheritance through tuple-to-userset rules (SpiceDB writes `parent->read`). Each is a server, which ADR-0009 rules out for the core.
- **Cutler et al., "Cedar: A New Language for Expressive, Fast, Safe, and Analyzable
  Authorization", OOPSLA 2024, doi:10.1145/3649835.**
  <https://docs.cedarpolicy.com/auth/authorization.html> Default deny; a matching `forbid`
  overrides any `permit`; entity hierarchies through `in`. The safest semantics for a folder
  tree.
- **Open Policy Agent, partial evaluation for data filtering.**
  <https://www.openpolicyagent.org/docs/filtering> A policy compiled into a SQL `WHERE`
  clause for list and search endpoints. The shape accreta's SQLite queries need.

## 2. How wikis and document systems do it

| System | Read control | Write control | Inheritance |
|---|---|---|---|
| MediaWiki | not designed for it | yes | — |
| DokuWiki *(partly verified)* | per namespace | per namespace | most specific rule wins |
| Confluence | page restrictions | page restrictions | view inherited; edit not inherited |
| Notion | per page, teamspaces | per page | subpages inherit; the broadest grant wins |
| GitBook | per space and collection | same | resolved by precedence, not by highest role |
| Obsidian Sync | per vault | per vault | none; "fine-grained permissions are not supported yet" |
| GitHub CODEOWNERS | none | review routing | last matching pattern wins |
| Backstage | permission framework, off by default | same | conditional decisions, e.g. `isEntityOwner` |

- **MediaWiki, Manual:Preventing access.**
  <https://www.mediawiki.org/wiki/Manual:Preventing_access> "MediaWiki was not designed to
  support per-page or partial-page access restrictions." Recommends separate wikis.
- **MediaWiki, Security issues with authorization extensions.**
  <https://www.mediawiki.org/wiki/Security_issues_with_authorization_extensions> The best
  checklist of how a restricted page escapes: search, page lists, feeds, diffs, transclusion,
  the API, redirects, caches. Section 6 maps it onto accreta.
- **Confluence page restrictions.**
  <https://confluence.atlassian.com/doc/page-restrictions-139414.html> "View restrictions are
  inherited"; "edit restrictions are not inherited." That a child can only narrow is implied
  (a parent's restriction still blocks the child), not stated.
- **Notion sharing and permissions.** <https://www.notion.com/help/sharing-and-permissions>
  The counter-example: a broader grant elsewhere defeats a narrower restriction.
- **GitBook permissions and inheritance.**
  <https://gitbook.com/docs/collaborate/member-management/permissions-and-inheritance>
- **Obsidian Sync collaboration.** <https://obsidian.md/help/sync/collaborate>
- **Gitolite configuration.** <https://gitolite.com/gitolite/conf.html> Path restrictions
  exist only for pushes. A git host cannot hide part of a repository from a reader.
- **GitHub CODEOWNERS.**
  <https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners>
- **Backstage permissions.** <https://backstage.io/docs/permissions/overview>,
  <https://backstage.io/docs/permissions/writing-a-policy>

## 3. Leakage through what is derived from the pages

- **SharePoint search, security trimming.**
  <https://learn.microsoft.com/en-us/sharepoint/dev/general-development/search-in-sharepoint>
  Results trimmed by the caller's identity at query time, before or after retrieval.
- **Microsoft 365 Copilot privacy.**
  <https://learn.microsoft.com/en-us/microsoft-365/copilot/microsoft-365-copilot-privacy>
  Surfaces only what the user may view — and so inherits every overshare.
- **Elasticsearch document-level security.**
  <https://www.elastic.co/docs/deploy-manage/users-roles/cluster-or-deployment-auth/controlling-access-at-document-field-level>
  A restricted user can still learn terms that exist only in hidden documents, and how many
  hidden documents contain them; document-level security "doesn't affect global index
  statistics that relevancy scoring uses." SQLite FTS5's bm25 is the same case.
- **RoyChowdhury et al., "ConfusedPilot", arXiv:2408.04870, 2024.** A planted document
  served by a trusted assistant to other users. Write access to a source is an integrity
  attack on every reader of what the agent compiles from it.
- **Greshake et al., "Not What You've Signed Up For: Compromising Real-World LLM-Integrated
  Applications with Indirect Prompt Injection", AISec 2023, arXiv:2302.12173.** Retrieved
  content steers the agent's tool use. A visible page can misuse what its reader may see.
- **Zeng et al., "The Good and The Bad: Exploring Privacy Issues in RAG", ACL Findings 2024,
  arXiv:2402.16893.**
- **Zhong et al., "HoneyBee", SIGMOD 2026, doi:10.1145/3786625, arXiv:2505.01538.** Role-based access in vector search: an
  index per role is fast and memory-heavy, one shared index with filtering is slow.
- **Arceo and Narsing, "Securing the Agent: Vendor-Neutral, Multitenant Enterprise Retrieval
  and Tool Use", arXiv:2605.05287, 2026.** Relevance is not
  authorization; check access at retrieval time.
- **Maheshwar (AuthZed), "RAG with Access Control", Pinecone Learn, 2026.**
  <https://www.pinecone.io/learn/rag-access-control/> Pre-filter with the set of readable
  resources, or post-filter with a per-item check.

## 4. An agent that reads everything and writes for everyone

- **Denning, "A Lattice Model of Secure Information Flow", CACM 19(5), 1976,
  doi:10.1145/360051.360056.** Labels form a lattice; information flows only upward. A page's
  label should be at least the join of the labels of what it was compiled from.
- **Bell and LaPadula, MITRE MTR-2997 Rev. 1, 1976.** *Partly verified.* "No read up, no
  write down". The compiling agent reads high and writes for every reader — exactly the
  trusted subject the *-property exists to constrain.
- **Denning and Schlörer, "Inference Controls for Statistical Databases", IEEE Computer
  16(7), 1983**, and **Lunt, "Aggregation and Inference: Facts and Fallacies", IEEE S&P
  1989.** *Lunt partly verified.* A combination can be more sensitive than every piece of
  it. A synthesis page is a combination.
- **Costa et al., "Securing AI Agents with Information-Flow Control" (FIDES),
  arXiv:2505.23643, 2025.** Deterministic confidentiality and integrity labels tracked by the
  planner.
- **Debenedetti et al., "Defeating Prompt Injections by Design" (CaMeL), arXiv:2503.18813,
  2025.** Values carry provenance metadata; policies checked at tool calls.
- **MCP authorization, revision 2026-07-28.**
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization> Optional; over HTTP the server
  is an OAuth 2.1 resource server, validates the token's audience and never passes it on.
  stdio servers take credentials from the environment. The spec standardizes no user or
  group claim — mapping claims to roles is the server's job.

## 5. Separate stores or one filtered store

- **MediaWiki** (above) recommends separate wikis for real boundaries.
- **Pinecone multitenancy.**
  <https://docs.pinecone.io/guides/index-data/implement-multitenancy> A namespace per tenant
  is physical isolation; metadata filtering scans everything.
- **Weaviate multi-tenancy.**
  <https://docs.weaviate.io/weaviate/manage-collections/multi-tenancy> A shard per tenant.
- **HoneyBee** (above) prices the middle ground.

## 6. accreta's own surfaces

Every channel through which a page's existence, path, title or text reaches someone who did
not fetch it, on `main` at f79e6de. Each one needs the same read check.

| Channel | Where | What escapes |
|---|---|---|
| `search_pages` | `packages/core/src/query/search.ts:33`, snippet at :55; `matched_aliases` at `packages/mcp-server/src/tools.ts:158` | path, title, body snippet, aliases from frontmatter |
| bm25 ranking | `search.ts:60` | term statistics across the whole corpus |
| `get_page` | `query/page.ts:62` | any path or wikilink |
| `find_consumers` | `query/page.ts:94`, `targetExists` at :178 | titles of linking pages; existence of the target |
| `find_canonical` | `query/page.ts:209` | path, title, `canonical_source` on exact match |
| `lint_knowledge_base` | `query/lint.ts:86`, `supersession.ts:34` | paths, link targets, footnote text |
| `check_drift` | `source/drift.ts:153`, `mcp-server/src/tools.ts:259` | page paths per source, cited paths |
| `list_recent_changes` | `tools.ts:356` | changed paths in a source |
| `cite` | `tools.ts:402` | whether a source path exists (#178) |
| counts and paging | `query/paging.ts:87`; `meta.page_count` at `index-db/build.ts:300` | totals; cursors bound to a build, not to a reader. Nothing reads `page_count` today: latent, not live |
| page bodies | wikilinks and footnotes written in the text | the path and title of whatever a page links to or cites |

The last row is not a query: it is content. No filter fixes a visible page whose body names
a hidden one. Only checking the flow at write time does.

## What recurs

1. **Every derived surface is a read path.** One check, applied inside the query, not after
   it — or the counts, cursors and existence answers leak what the results hide.
2. **Inheritance is a decision.** Most-specific-wins, narrow-only and broadest-wins all ship
   in real products. For reads, deny by default and let a subfolder only narrow.
3. **Reading and writing are different problems.** Reading is confidentiality; writing is
   ownership and integrity, and in accreta it already lives in the repository.
4. **The compiling agent is the weak point.** It reads every area and writes into each.
   Labels must flow from sources to pages, and synthesis can exceed every label it read.
5. **Hard boundaries are physical.** A filter governs who sees what; only a separate store
   governs what the agent can combine.
