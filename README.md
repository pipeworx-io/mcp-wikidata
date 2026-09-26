# Wikidata — Structured Knowledge Graph

Wikidata is the free, structured-data sister of Wikipedia. ~110 million items (people, places, works, concepts) with machine-readable properties and relationships. The closest thing the open web has to a universal knowledge graph. Free, no auth, supports SPARQL queries.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1684+ live data sources.

## Why this matters for AI agents

For entity disambiguation, structured facts about anything notable, or graph traversal ("what books did this author write that won prizes?"), Wikidata is the canonical open source. Pair with [Wikipedia](/docs/reference/wikipedia) (prose) and [OpenAlex](/docs/reference/openalex) (academic specifics) for full open-knowledge coverage.

Common flows:

- **Entity lookup.** "Who is Paul McCartney?" → Q2599 with structured facts (birth date, nationality, occupation, band memberships).
- **Property query.** "What's the population of France?" → Q142, property P1082 (population), with references and timestamps.
- **Disambiguation.** "Paris" → Q90 (capital of France), Q830149 (Paris, Texas), Q3296 (Paris, Greek mythology). Wikidata's structured types resolve which "Paris" the agent is asking about.
- **Graph traversal.** SPARQL: "All Nobel laureates in Physics born in Italy" → joinable across structured properties.

## Tools

| Tool | What it returns |
|---|---|
| `search_entities` | Q-ids matching a label or alias, with labels, descriptions and aliases. Start here when you have a name and need an id. |
| `get_entity` | Full entity by Q-id — labels, descriptions, aliases, raw P-coded claims, sitelinks, plus `lastrevid` / `modified`. Takes `language`. |
| `get_entities` | The same, for up to 50 Q-ids in ONE call. Returns a per-QID map plus a `not_found` list, so one bad id doesn't fail the batch — see "One bad id used to zero the batch" below. Takes `language`. |
| `get_wikidata_facts` | The same statements with property names and values resolved to human-readable labels, plus `lastrevid` / `modified`. Prefer this for "what is X's <attribute>". Takes `language`. |
| `wikidata_recent_changes` | Items created or edited most recently, newest-first, from `list=recentchanges` — Q-id, revision ids, UTC timestamp, user, comment, byte size, plus a `cursor` for paging further back. |

### Reading labels in another language

`search_entities`, `get_entity`, `get_entities` and `get_wikidata_facts` all take
`language`. It is passed straight to the API's own `languages` param, so a single code
(`"ka"`) or a comma/pipe-joined list (`"ka,ru,en"`) both work, and a list returns every
requested language's label, description and aliases **side by side in one upstream call** —
the shape you need to decide whether two records in different languages are the same entity.
Omit it and you get English, exactly as before.

Two fields, and the difference matters:

- `labels` / `descriptions` / `aliases_by_language` are keyed by language and contain **only
  what Wikidata actually has**. Ask for a language the entity has no label in and the key is
  simply absent — that absence is the honest answer, and it is how you detect a translation gap.
- `label` / `description` are the single best value, and they **fall back to English** when the
  requested language is missing. So `get_entity({id:"Q162887", language:"zu"})` returns
  `label: "Enguri HPP"` with an empty `labels` map: there is no Zulu label, and you can tell.

`get_wikidata_facts` localizes both halves — property names and their values — so
`{id:"Q162887", language:"ka"}` comes back with Georgian keys (`ქვეყანა` → `საქართველო`),
not English keys with Georgian values.

**`mul` is a real language code here, and you will see it.** Wikidata moved
language-neutral labels — personal names, most Latin binomials, many place names — to
the `mul` ("multiple languages") code, and `wbgetentities` then returns an *empty* `en`
label map for those items. Q42 (Douglas Adams) is one: it has an English description and
no English label. The fallback chain is therefore **requested → `en` → `mul`**, and when
the name came from `mul` you see it under a `mul` key in the `labels` map:

```json
{"id":"Q42","label":"Douglas Adams","labels":{"mul":"Douglas Adams"},
 "description":"British science fiction writer and humorist (1952–2001)"}
```

That key is the provenance: the name is not attributed to a language the entity does not
carry. Before this the pack returned `label: null` for Q42 — a clean 200 with a null
where the answer was.

### One bad id used to zero the batch

`wbgetentities` is inconsistent about unknown ids, and the two cases look nothing alike:

- An unknown but **well-formed** id (`Q999999999`) comes back marked `missing`, and every
  other id in the request still resolves.
- An id **outside the item-id range** or plainly malformed (`Q99999999999`, `NOTAQID`)
  makes the API refuse the **entire request** — HTTP 200, no `entities` at all, a
  top-level `{"error":{"code":"no-such-entity","id":"Q99999999999"}}`.

Read naively the second case is an empty map, so one typo in a 50-id batch reported all
50 as `not_found`: a clean 200 saying nothing resolved. The error names the offending id,
so `get_entities` drops it and retries (bounded, one id per pass). A batch of
`["Q162887","Q99999999999","Q90","NOTAQID","Q1326165"]` now resolves the three real
entities and returns the two bad ids in `not_found`.

### Pinning statements to an edit

Wikidata is live and continuously edited, so "the current statements" is only meaningful
relative to a revision. Both entity tools return `lastrevid`, `modified` and a
`revision_url`, so an answer built from them can be pinned to the exact edit it was read
at, and re-checked later for drift.

`wikidata_recent_changes` answers the other half of that: which items changed, and when.
Namespace `0` is items (Q-ids), `120` is properties (P-ids), `146` is lexemes. `type` is
`new` (freshly created), `edit` (edits to existing items) or `all`. Use `since` for a time
window and `cursor` to page further back.

## Auth

None. Wikidata is fully open. Wikidata's SPARQL endpoint has fair-use rate limits but generous for most agent traffic.

## Identifier scheme

| Prefix | Type |
|---|---|
| Q | Item (an entity — person, place, thing) |
| P | Property (a relationship type — "spouse," "instance of," "located in") |
| L | Lexeme (a word/sense, for linguistic data) |

Every entity has a stable Q-number that serves as a permanent identifier across Wikipedia language editions. Embed Q-numbers in agent output as canonical citations.

## Common pitfalls

- **Quality varies wildly by entity.** A famous person (Einstein, Q937) has hundreds of well-sourced properties. A small-town politician may have 5 properties, half from auto-imported sources. Always check the `references` field on properties you're acting on.
- **Multiple values for "current" properties.** "President of company X" may have 8 historical values plus a current one. Wikidata uses qualifier properties (start time, end time, "preferred rank") to indicate which is current — but agents often grab the first value naively.
- **Property duplication.** Multiple properties can express related concepts ("country" P17, "country of origin" P495, "country of citizenship" P27). Picking the right one matters for accuracy.
- **Vandalism risk.** Wikidata is editable like Wikipedia. High-profile entities are watched, but obscure ones can carry vandalism for days. Don't quote a single Wikidata fact as ground truth without a `references` chain to an authoritative source.
- **Translation gaps.** Labels exist in many languages but not always in the one you asked for. `label` falls back to English, then to the language-neutral `mul` label, when that happens, so a non-English request never comes back empty — but it also means a returned `label` is not proof the entity HAS a label in that language. Read the `labels` map for that: a missing key is a real gap, and a `mul` key means the name is language-neutral rather than translated. See "Reading labels in another language" above.
- **SPARQL timeouts.** Complex graph queries can hit the SPARQL endpoint's 60-second timeout. Decompose into smaller queries or use property-specific lookups.
- **Identifiers, not facts.** Wikidata is best for "what's the canonical ID of this entity" and "what does it link to." For deep biographical or historical narrative, follow the linked Wikipedia article.

## Data sources

- MediaWiki Action API — `https://www.wikidata.org/w/api.php`
  - `action=wbsearchentities` (search), `action=wbgetentities` (entity read, `props=info|labels|descriptions|aliases|claims|sitelinks`, `languages=` for the language filter, up to 50 pipe-joined ids per call)
  - `action=query&list=recentchanges` (recent changes feed)
- API docs: https://www.wikidata.org/w/api.php and https://www.mediawiki.org/wiki/API:Recentchanges
- Entity pages: `https://www.wikidata.org/wiki/<QID>`; a specific revision: `https://www.wikidata.org/w/index.php?oldid=<revid>`

All endpoints are keyless. Wikidata asks callers to send a descriptive User-Agent; this
pack sends `Pipeworx-Wikidata-MCP/1.0`.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "wikidata": {
      "url": "https://gateway.pipeworx.io/wikidata/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/wikidata/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1684+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/wikidata_search_entities \
  -H 'Content-Type: application/json' \
  -d '{"query":"Albert Einstein"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/wikidata_search_entities`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "wikidata": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-wikidata"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-wikidata
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Wikidata data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
