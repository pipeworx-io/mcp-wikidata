interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Wikidata MCP — wraps Wikidata API (wikidata.org/w/api.php)
 *
 * Free, no authentication required. Uses wbsearchentities and wbgetentities actions.
 *
 * Tools:
 * - search_entities: search Wikidata entities by label (people, places, concepts)
 * - get_entity: get full entity data by Wikidata ID (e.g., Q42 = Douglas Adams)
 */


const API_BASE = 'https://www.wikidata.org/w/api.php';

// ── Tool definitions ──────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'search_entities',
    description:
      'Search Wikidata entities by label or alias (e.g., "Albert Einstein", "Python programming language", "Tokyo"). Returns entity IDs, labels, descriptions, and aliases. Useful for finding the Wikidata ID of any concept.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query (e.g., "Marie Curie", "Bitcoin", "Great Wall of China")',
        },
        language: {
          type: 'string',
          description: 'Language code for labels (default "en"). E.g., "fr", "de", "ja"',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (1-50, default 10)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_entity',
    description:
      'Get full Wikidata entity by ID (e.g., "Q42" for Douglas Adams, "Q5" for human, "Q1764" for Budapest). Returns labels, descriptions, aliases, claims/statements (properties and values), and sitelinks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description: 'Wikidata entity ID (e.g., "Q42", "Q937", "P31")',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_wikidata_facts',
    description:
      'Structured facts about a Wikidata entity in HUMAN-READABLE form — property names and values resolved to labels, not raw P/Q codes. PREFER OVER get_entity for "what is X\x27s <attribute>", "facts about X", "X\x27s date of birth / capital / population". E.g. Q42 (Douglas Adams) -> {"date of birth":["1952-03-11..."],"occupation":["writer",...],"place of birth":["Cambridge"]}. Pass a Q-id from search_entities.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Wikidata entity Q-id (e.g. "Q42"). Find it with search_entities.' } },
      required: ['id'],
    },
  }
];

// ── callTool dispatcher ───────────────────────────────────────────────

const WD_HEADERS = { Accept: 'application/json', 'User-Agent': 'Pipeworx-Wikidata-MCP/1.0' };
async function wdEntities(ids: string, props: string) {
  const res = await fetch(`${API_BASE}?${new URLSearchParams({ action: 'wbgetentities', ids, format: 'json', languages: 'en', props })}`, { headers: WD_HEADERS });
  if (!res.ok) throw new Error(`Wikidata API error (${res.status})`);
  return (await res.json()) as { entities?: Record<string, { labels?: Record<string, { value: string }>; descriptions?: Record<string, { value: string }>; claims?: Record<string, Array<{ mainsnak: { datavalue?: { type: string; value: unknown } } }>> }> };
}

async function getFacts(idRaw: string) {
  const qid = String(idRaw ?? '').trim().toUpperCase();
  if (!/^Q\d+$/.test(qid)) throw new Error('Required argument "id" must be a Wikidata Q-id like "Q42". Use search_entities to find it.');
  const data = await wdEntities(qid, 'labels|descriptions|claims');
  const ent = data.entities?.[qid];
  if (!ent) throw new Error(`Entity not found: ${qid}`);
  const claims = ent.claims ?? {};
  const propIds = Object.keys(claims).slice(0, 40);
  const valueQids = new Set<string>();
  for (const p of propIds) for (const s of (claims[p] || []).slice(0, 10)) {
    const dv = s.mainsnak?.datavalue;
    if (dv?.type === 'wikibase-entityid') { const v = dv.value as { id?: string }; if (v.id) valueQids.add(v.id); }
  }
  const toResolve = [...propIds, ...valueQids];
  const labels: Record<string, string> = {};
  for (let i = 0; i < toResolve.length; i += 50) {
    const ld = await wdEntities(toResolve.slice(i, i + 50).join('|'), 'labels');
    for (const [k, e] of Object.entries(ld.entities ?? {})) { const lab = e.labels?.en?.value; if (lab) labels[k] = lab; }
  }
  const facts: Record<string, unknown[]> = {};
  for (const p of propIds) {
    const vals = (claims[p] || []).slice(0, 10).map((s) => {
      const dv = s.mainsnak?.datavalue; if (!dv) return null;
      if (dv.type === 'wikibase-entityid') { const v = dv.value as { id?: string }; return v.id ? (labels[v.id] || v.id) : null; }
      if (dv.type === 'time') return (dv.value as { time: string }).time;
      if (dv.type === 'quantity') return (dv.value as { amount: string }).amount;
      if (dv.type === 'monolingualtext') return (dv.value as { text: string }).text;
      if (dv.type === 'globecoordinate') { const v = dv.value as { latitude: number; longitude: number }; return `${v.latitude},${v.longitude}`; }
      if (dv.type === 'string' || dv.type === 'url' || dv.type === 'external-id') return dv.value;
      return dv.value;
    }).filter((v) => v != null);
    if (vals.length) facts[labels[p] || p] = vals;
  }
  return { id: qid, label: ent.labels?.en?.value ?? null, description: ent.descriptions?.en?.value ?? null, facts };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_entities':
      return searchEntities(
        args.query as string,
        (args.language as string) ?? 'en',
        (args.limit as number) ?? 10,
      );
    case 'get_wikidata_facts':
      return getFacts(args.id as string);
    case 'get_entity':
      return getEntity(args.id as string);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Tool implementations ─────────────────────────────────────────────

async function searchEntities(query: string, language: string, limit: number) {
  const safeLimit = Math.min(50, Math.max(1, limit));
  const params = new URLSearchParams({
    action: 'wbsearchentities',
    search: query,
    language,
    limit: String(safeLimit),
    format: 'json',
    uselang: language,
  });

  const res = await fetch(`${API_BASE}?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Pipeworx-Wikidata-MCP/1.0' },
  });
  if (!res.ok) throw new Error(`Wikidata API error (${res.status})`);

  const data = (await res.json()) as {
    search: Array<{
      id: string;
      label: string;
      description: string;
      aliases: string[];
      concepturi: string;
    }>;
  };

  return {
    results: (data.search ?? []).map((e) => ({
      id: e.id,
      label: e.label ?? null,
      description: e.description ?? null,
      aliases: e.aliases ?? [],
      uri: e.concepturi ?? null,
    })),
  };
}

async function getEntity(id: string) {
  const params = new URLSearchParams({
    action: 'wbgetentities',
    ids: id,
    format: 'json',
    languages: 'en',
    props: 'labels|descriptions|aliases|claims|sitelinks',
  });

  const res = await fetch(`${API_BASE}?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Pipeworx-Wikidata-MCP/1.0' },
  });
  if (!res.ok) throw new Error(`Wikidata API error (${res.status})`);

  const data = (await res.json()) as {
    entities: Record<string, {
      id: string;
      type: string;
      labels: Record<string, { value: string }>;
      descriptions: Record<string, { value: string }>;
      aliases: Record<string, Array<{ value: string }>>;
      claims: Record<string, Array<{
        mainsnak: {
          property: string;
          datavalue?: {
            type: string;
            value: unknown;
          };
        };
      }>>;
      sitelinks: Record<string, { site: string; title: string }>;
    }>;
  };

  const entity = data.entities?.[id];
  if (!entity) throw new Error(`Entity not found: ${id}`);

  // Extract a simplified claims summary (top properties with values)
  const claims: Record<string, unknown[]> = {};
  for (const [prop, statements] of Object.entries(entity.claims ?? {})) {
    claims[prop] = statements.slice(0, 5).map((s) => {
      const dv = s.mainsnak?.datavalue;
      if (!dv) return null;
      if (dv.type === 'wikibase-entityid') {
        const v = dv.value as { id: string };
        return v.id;
      }
      if (dv.type === 'time') {
        const v = dv.value as { time: string };
        return v.time;
      }
      if (dv.type === 'quantity') {
        const v = dv.value as { amount: string; unit: string };
        return { amount: v.amount, unit: v.unit };
      }
      if (dv.type === 'string' || dv.type === 'url' || dv.type === 'external-id') {
        return dv.value;
      }
      if (dv.type === 'monolingualtext') {
        const v = dv.value as { text: string; language: string };
        return v.text;
      }
      return dv.value;
    });
  }

  // Limit claims to first 30 properties to avoid huge payloads
  const limitedClaims: Record<string, unknown[]> = {};
  const claimKeys = Object.keys(claims).slice(0, 30);
  for (const k of claimKeys) {
    limitedClaims[k] = claims[k];
  }

  return {
    id: entity.id,
    type: entity.type,
    label: entity.labels?.en?.value ?? null,
    description: entity.descriptions?.en?.value ?? null,
    aliases: (entity.aliases?.en ?? []).map((a) => a.value),
    claims: limitedClaims,
    sitelinks_count: Object.keys(entity.sitelinks ?? {}).length,
    wikipedia_en: entity.sitelinks?.enwiki?.title ?? null,
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
