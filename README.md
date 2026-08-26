# Wikidata — Structured Knowledge Graph

Wikidata is the free, structured-data sister of Wikipedia. ~110 million items (people, places, works, concepts) with machine-readable properties and relationships. The closest thing the open web has to a universal knowledge graph. Free, no auth, supports SPARQL queries.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

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
| `get_entity` | Full entity by Q-id — labels, descriptions, aliases, raw P-coded claims, sitelinks, plus `lastrevid` / `modified`. |
| `get_wikidata_facts` | The same statements with property names and values resolved to human-readable labels, plus `lastrevid` / `modified`. Prefer this for "what is X's <attribute>". |
| `wikidata_recent_changes` | Items created or edited most recently, newest-first, from `list=recentchanges` — Q-id, revision ids, UTC timestamp, user, comment, byte size, plus a `cursor` for paging further back. |

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
- **Translation gaps.** Labels exist in many languages but not always in the language you queried. Default fallback to English (`en`) when label is missing.
- **SPARQL timeouts.** Complex graph queries can hit the SPARQL endpoint's 60-second timeout. Decompose into smaller queries or use property-specific lookups.
- **Identifiers, not facts.** Wikidata is best for "what's the canonical ID of this entity" and "what does it link to." For deep biographical or historical narrative, follow the linked Wikipedia article.

## Data sources

- MediaWiki Action API — `https://www.wikidata.org/w/api.php`
  - `action=wbsearchentities` (search), `action=wbgetentities` (entity read, `props=info|labels|descriptions|aliases|claims|sitelinks`)
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

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

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
