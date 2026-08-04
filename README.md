# Wikidata — Structured Knowledge Graph

Wikidata is the free, structured-data sister of Wikipedia. ~110 million items (people, places, works, concepts) with machine-readable properties and relationships. The closest thing the open web has to a universal knowledge graph. Free, no auth, supports SPARQL queries.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Why this matters for AI agents

For entity disambiguation, structured facts about anything notable, or graph traversal ("what books did this author write that won prizes?"), Wikidata is the canonical open source. Pair with [Wikipedia](/docs/reference/wikipedia) (prose) and [OpenAlex](/docs/reference/openalex) (academic specifics) for full open-knowledge coverage.

Common flows:

- **Entity lookup.** "Who is Paul McCartney?" → Q2599 with structured facts (birth date, nationality, occupation, band memberships).
- **Property query.** "What's the population of France?" → Q142, property P1082 (population), with references and timestamps.
- **Disambiguation.** "Paris" → Q90 (capital of France), Q830149 (Paris, Texas), Q3296 (Paris, Greek mythology). Wikidata's structured types resolve which "Paris" the agent is asking about.
- **Graph traversal.** SPARQL: "All Nobel laureates in Physics born in Italy" → joinable across structured properties.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Wikidata data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
