interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Wikidata MCP — wraps Wikidata API (wikidata.org/w/api.php)
 *
 * Free, no authentication required. Uses wbsearchentities and wbgetentities actions.
 *
 * Tools:
 * - search_entities: search Wikidata entities by label (people, places, concepts)
 * - get_entity: get full entity data by Wikidata ID (e.g., Q42 = Douglas Adams)
 * - get_entities: batch version of get_entity — up to 50 Q-ids in one call
 * - get_wikidata_facts: label-resolved facts for an entity
 * - wikidata_recent_changes: newest created/edited items from list=recentchanges
 *
 * Entity reads request props=info so every response carries lastrevid + modified,
 * letting a caller pin the statements they got to the exact revision they came from.
 *
 * Multilingual labels (get_entity/get_entities/get_wikidata_facts): all three accept
 * an optional `language` argument — a single code ("ka") or a comma/pipe-joined list
 * ("ka,ru,en") — passed straight through to wbgetentities' own `languages` param, so
 * one upstream call returns every requested language's label/description/aliases
 * side by side (no extra round-trip). This exists because search_entities already
 * resolves non-English queries to the right QID (verified live: "ენგურჰესი" and
 * "Ингурская ГЭС" both resolve to Q162887), but the detail tools used to throw every
 * language but English away once you had that QID — exactly backwards for a caller
 * doing cross-lingual entity reconciliation. Fleet #1791.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Wikidata');
}

const API_BASE = 'https://www.wikidata.org/w/api.php';
const MAX_BATCH_IDS = 50; // wbgetentities' own documented pipe-joined-ids cap
// One retry per id the API refuses outright (see getEntities). Bounded so a
// batch of garbage ids costs a handful of round trips, not fifty.
const MAX_REFUSED_ID_RETRIES = 8;

// ── Tool definitions ──────────────────────────────────────────────────

const LANGUAGE_DESC =
  'Language code(s) for labels/descriptions/aliases — a single code (e.g. "ka") or a ' +
  'comma/pipe-joined list to compare several at once (e.g. "ka,ru,en"), which returns every ' +
  'requested language\x27s label side by side in one call — the shape needed to decide whether ' +
  'two records in different languages describe the same entity. Default "en". Falls back to ' +
  '"en", then to Wikidata\x27s language-neutral "mul" label, for any requested language the ' +
  'entity has no label in — Q42 (Douglas Adams) has no English label at all, only a "mul" one. ' +
  'When the name came from "mul" it appears under a "mul" key in the labels map, so you can ' +
  'tell where it came from.';

const tools: McpToolExport['tools'] = [
  {
    name: 'search_entities',
    description:
      'Search Wikidata entities by label or alias (e.g., "Albert Einstein", "Python programming language", "Tokyo"). Returns entity IDs, labels, descriptions, and aliases. Useful for finding the Wikidata ID of any concept.',
    summary: 'Wikidata entities matching a name search, with their Q-ids.',
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
      'Get full Wikidata entity by ID (e.g., "Q42" for Douglas Adams, "Q5" for human, "Q1764" for Budapest). Returns labels, descriptions, aliases, claims/statements (properties and values), sitelinks, and the revision the data came from — lastrevid plus the modified timestamp — so live statements can be pinned to a specific edit. Pass "language" (comma/pipe-joined for several) to get labels/descriptions in languages other than English, side by side. For checking several ids at once, use get_entities instead of looping this.',
    summary: 'One Wikidata entity\'s full record — labels, descriptions, claims — by Q-id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description: 'Wikidata entity ID (e.g., "Q42", "Q937", "P31")',
        },
        language: {
          type: 'string',
          description: LANGUAGE_DESC,
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_entities',
    description:
      `Batch version of get_entity — resolve up to ${MAX_BATCH_IDS} Wikidata Q-ids in ONE call instead of looping single get_entity calls. Same fields as get_entity per entity (labels, descriptions, aliases, claims, sitelinks, revision info), keyed by Q-id. Any id that does not resolve (bad format, deleted, or genuinely unknown) is reported in "not_found" rather than failing the whole batch — the other ids still resolve. Pass "language" (comma/pipe-joined for several) the same as get_entity to get multilingual labels for every entity in the batch.`,
    summary: 'Multiple Wikidata entities\' full records, by Q-id, in one call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ids: {
          description:
            `Wikidata Q-ids to resolve, up to ${MAX_BATCH_IDS} — either an array of strings (e.g. ["Q162887","Q1326165","Q3493773"]) or a single comma/pipe-joined string (e.g. "Q162887,Q1326165,Q3493773").`,
          oneOf: [
            { type: 'array', items: { type: 'string' } },
            { type: 'string' },
          ],
        },
        language: {
          type: 'string',
          description: LANGUAGE_DESC,
        },
      },
      required: ['ids'],
    },
  },
  {
    name: 'get_wikidata_facts',
    description:
      'Structured facts about a Wikidata entity in HUMAN-READABLE form — property names and values resolved to labels, not raw P/Q codes. PREFER OVER get_entity for "what is X\x27s <attribute>", "facts about X", "X\x27s date of birth / capital / population". E.g. Q42 (Douglas Adams) -> {"date of birth":["1952-03-11..."],"occupation":["writer",...],"place of birth":["Cambridge"]}. Also returns lastrevid and modified, the revision these statements were read at, for questions asking about an item\x27s state after its latest edit. Pass "language" (comma/pipe-joined for several) for facts and labels in languages other than English. Pass a Q-id from search_entities.',
    summary: 'The key facts (claims) for one Wikidata entity, in plain form, by Q-id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Wikidata entity Q-id (e.g. "Q42"). Find it with search_entities.' },
        language: {
          type: 'string',
          description: LANGUAGE_DESC,
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'wikidata_recent_changes',
    description:
      'Newest items created or edited on Wikidata right now, from the live MediaWiki recent-changes feed. Answers "which Wikidata item was created most recently", "what QIDs were created today", "what changed on Wikidata in the last hour", "recent edits to Wikidata items". Returns each change newest-first with its Q-id, revision id, previous revision id, UTC timestamp, editing user, edit comment and byte size, plus a cursor for paging further back.',
    summary: 'Recent edits to Wikidata, from its recent-changes feed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          description:
            'Which changes to list: "new" for freshly created items (default), "edit" for edits to existing items, "all" for both.',
          enum: ['new', 'edit', 'all'],
        },
        namespace: {
          type: 'number',
          description:
            'Wikidata namespace: 0 = items/Q-ids (default), 120 = properties/P-ids, 146 = lexemes.',
        },
        limit: {
          type: 'number',
          description: 'Max changes to return (1-50, default 10).',
        },
        since: {
          type: 'string',
          description:
            'Stop at this UTC timestamp, ISO 8601 (e.g. "2026-08-22T00:00:00Z"). Listing runs newest-first back to this point.',
        },
        user: {
          type: 'string',
          description: 'Only changes made by this Wikidata username (e.g. "Dsp13").',
        },
        cursor: {
          type: 'string',
          description:
            'Continue token from a previous call\x27s "cursor" field, to page further back in time.',
        },
      },
    },
  }
];

// ── Shared entity types + fetch helper ───────────────────────────────

type WdEntity = {
  id: string;
  type?: string;
  lastrevid?: number;
  modified?: string;
  pageid?: number;
  missing?: string;
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  aliases?: Record<string, Array<{ value: string }>>;
  claims?: Record<string, Array<{ mainsnak: { property?: string; datavalue?: { type: string; value: unknown } } }>>;
  sitelinks?: Record<string, { site: string; title: string }>;
};

const WD_HEADERS = { Accept: 'application/json', 'User-Agent': 'Pipeworx-Wikidata-MCP/1.0' };

async function wdEntities(ids: string, props: string, languages = 'en') {
  const res = await pwFetch(
    `${API_BASE}?${new URLSearchParams({ action: 'wbgetentities', ids, format: 'json', languages, props })}`,
    { headers: WD_HEADERS },
  );
  if (!res.ok) throw await httpError(res, 'Wikidata API error');
  // wbgetentities answers HTTP 200 with a top-level `error` when it refuses the
  // whole request, so the caller has to read `error` to tell "nothing matched"
  // from "I asked the wrong question". getEntities below depends on this.
  return (await res.json()) as {
    entities?: Record<string, WdEntity>;
    error?: { code?: string; id?: string; info?: string };
  };
}

// Parses the shared `language` argument: a single code, or a comma/pipe-joined
// list for side-by-side multilingual output. `requested` defaults to ["en"]
// when omitted, so existing single-language callers see identical behavior.
// `fetchLangs` always includes "en" and "mul" too — free in the same
// wbgetentities call — so the primary label/description/aliases fields can fall
// back when the entity has no label in the first requested language.
function parseLanguages(languageArg: unknown): { requested: string[]; fetchLangs: string[]; primary: string } {
  const codes = String(languageArg ?? '')
    .split(/[,|]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const requested = codes.length ? codes : ['en'];
  const fetchLangs = Array.from(new Set([...requested, 'en', MUL_LANG]));
  return { requested, fetchLangs, primary: requested[0] };
}

// Wikidata moved language-neutral labels — personal names, most Latin binomials,
// many place names — to the "mul" language code, and wbgetentities then returns
// an EMPTY `en` label map for those items. Q42 (Douglas Adams) is one: asking for
// `languages=en` gives `labels: {}` and a perfectly good English description, so
// the pack reported `label: null` for an item that plainly has a name. That is
// the silent kind — a clean 200 with a null where the answer was. Every singular
// label/description/alias therefore falls back primary -> en -> mul, and "mul" is
// also surfaced under its own key in the side-by-side maps so a caller can see
// where the name came from rather than having it silently attributed to their
// requested language.
const MUL_LANG = 'mul';

function pickValue(map: Record<string, { value: string }> | undefined, primary: string): string | null {
  return map?.[primary]?.value ?? map?.en?.value ?? map?.[MUL_LANG]?.value ?? null;
}

function pickAliases(map: Record<string, Array<{ value: string }>> | undefined, primary: string): string[] {
  return (map?.[primary] ?? map?.en ?? map?.[MUL_LANG] ?? []).map((a) => a.value);
}

// The languages that appear as keys in the side-by-side labels/descriptions maps:
// what the caller asked for, plus "mul" when the entity carries one.
function mapLanguages(requested: string[]): string[] {
  return Array.from(new Set([...requested, MUL_LANG]));
}

// Builds the get_entity/get_entities response shape for one already-fetched
// entity. `requested` controls which languages appear in the `labels` /
// `descriptions` / `aliases_by_language` maps; the singular `label` /
// `description` / `aliases` fields use the primary (first requested) language,
// falling back to English when the entity has none.
function formatEntity(entity: WdEntity, requested: string[], primary: string) {
  const claims: Record<string, unknown[]> = {};
  for (const [prop, statements] of Object.entries(entity.claims ?? {})) {
    claims[prop] = statements.slice(0, 5).map((s) => {
      const dv = s.mainsnak?.datavalue;
      if (!dv) return null;
      if (dv.type === 'wikibase-entityid') return (dv.value as { id: string }).id;
      if (dv.type === 'time') return (dv.value as { time: string }).time;
      if (dv.type === 'quantity') { const v = dv.value as { amount: string; unit: string }; return { amount: v.amount, unit: v.unit }; }
      if (dv.type === 'string' || dv.type === 'url' || dv.type === 'external-id') return dv.value;
      if (dv.type === 'monolingualtext') return (dv.value as { text: string }).text;
      return dv.value;
    });
  }
  const claimKeys = Object.keys(claims).slice(0, 30);
  const limitedClaims: Record<string, unknown[]> = {};
  for (const k of claimKeys) limitedClaims[k] = claims[k];

  const labels: Record<string, string> = {};
  const descriptions: Record<string, string> = {};
  const aliasesByLanguage: Record<string, string[]> = {};
  for (const lang of mapLanguages(requested)) {
    const l = entity.labels?.[lang]?.value;
    if (l) labels[lang] = l;
    const d = entity.descriptions?.[lang]?.value;
    if (d) descriptions[lang] = d;
    const a = entity.aliases?.[lang];
    if (a?.length) aliasesByLanguage[lang] = a.map((x) => x.value);
  }

  const label = pickValue(entity.labels, primary);
  return {
    id: entity.id,
    type: entity.type ?? null,
    lastrevid: entity.lastrevid ?? null,
    modified: entity.modified ?? null,
    revision_url: entity.lastrevid ? `https://www.wikidata.org/w/index.php?oldid=${entity.lastrevid}` : null,
    label,
    // Same value as `label`, under the key the gateway's entity-check detector
    // actually reads (fleet #1846, phase 3b — docs/entity-check-plan.md,
    // workers/gateway/src/entity.ts ENTITY_KEYS). `label` was never on that
    // allowlist, so a get_entity/get_entities answer that plainly named its
    // subject scored `unverifiable` every time — 56 of 168 tools' worth of
    // unverifiable volume on this pack alone, measured 2026-09-10. Duplicating
    // rather than renaming keeps every existing caller's `label` field intact.
    entity_name: label,
    description: pickValue(entity.descriptions, primary),
    aliases: pickAliases(entity.aliases, primary),
    // Side-by-side multilingual view — only the requested languages, so a
    // caller reconciling ka/ru/en records gets all three in one response.
    labels,
    descriptions,
    aliases_by_language: aliasesByLanguage,
    claims: limitedClaims,
    sitelinks_count: Object.keys(entity.sitelinks ?? {}).length,
    wikipedia_en: entity.sitelinks?.enwiki?.title ?? null,
    source_url: `https://www.wikidata.org/wiki/${entity.id}`,
  };
}

async function getFacts(idRaw: string, languageArg: unknown) {
  const qid = String(idRaw ?? '').trim().toUpperCase();
  if (!/^Q\d+$/.test(qid)) throw new Error('Required argument "id" must be a Wikidata Q-id like "Q42". Use search_entities to find it.');
  const { requested, fetchLangs, primary } = parseLanguages(languageArg);
  const data = await wdEntities(qid, 'info|labels|descriptions|claims', fetchLangs.join('|'));
  const ent = data.entities?.[qid];
  if (!ent || ent.missing !== undefined) throw new Error(`Entity not found: ${qid}`);
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
    const ld = await wdEntities(toResolve.slice(i, i + 50).join('|'), 'labels', fetchLangs.join('|'));
    for (const [k, e] of Object.entries(ld.entities ?? {})) {
      const lab = pickValue(e.labels, primary);
      if (lab) labels[k] = lab;
    }
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
  const labelsByLanguage: Record<string, string> = {};
  const descriptionsByLanguage: Record<string, string> = {};
  for (const lang of mapLanguages(requested)) {
    const l = ent.labels?.[lang]?.value; if (l) labelsByLanguage[lang] = l;
    const d = ent.descriptions?.[lang]?.value; if (d) descriptionsByLanguage[lang] = d;
  }
  const factsLabel = pickValue(ent.labels, primary);
  return {
    id: qid,
    label: factsLabel,
    // See formatEntity's `entity_name` above — same fix, same reason (fleet #1846).
    entity_name: factsLabel,
    description: pickValue(ent.descriptions, primary),
    // Side-by-side multilingual view, same pattern as get_entity.
    labels: labelsByLanguage,
    descriptions: descriptionsByLanguage,
    // The revision these statements were read at. A caller asking for an item's
    // state "after its latest edit" needs to pin the answer to an edit; without
    // these two fields the statements are unanchored.
    lastrevid: ent.lastrevid ?? null,
    modified: ent.modified ?? null,
    revision_url: ent.lastrevid ? `https://www.wikidata.org/w/index.php?oldid=${ent.lastrevid}` : null,
    source_url: `https://www.wikidata.org/wiki/${qid}`,
    facts,
  };
}

async function getEntity(idRaw: string, languageArg: unknown) {
  const id = String(idRaw ?? '').trim();
  if (!/^[QP]\d+$/i.test(id)) throw new Error('Required argument "id" must be a Wikidata entity id like "Q42" or "P31".');
  const { requested, fetchLangs, primary } = parseLanguages(languageArg);
  const data = await wdEntities(id.toUpperCase(), 'info|labels|descriptions|aliases|claims|sitelinks', fetchLangs.join('|'));
  const entity = data.entities?.[id.toUpperCase()];
  if (!entity || entity.missing !== undefined) throw new Error(`Entity not found: ${id}`);
  return formatEntity(entity, requested, primary);
}

async function getEntities(idsArg: unknown, languageArg: unknown) {
  let rawIds: string[];
  if (Array.isArray(idsArg)) rawIds = idsArg.map((x) => String(x));
  else if (idsArg != null && String(idsArg).trim() !== '') rawIds = String(idsArg).split(/[,|]/);
  else rawIds = [];

  const cleaned = rawIds.map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!cleaned.length) {
    throw new Error(
      'Required argument "ids" must be a non-empty array or comma/pipe-joined string of Wikidata Q-ids, ' +
      'e.g. ["Q162887","Q1326165"] or "Q162887,Q1326165".',
    );
  }
  const deduped = Array.from(new Set(cleaned));
  const truncated = deduped.length > MAX_BATCH_IDS;
  const capped = deduped.slice(0, MAX_BATCH_IDS);
  const validIds = capped.filter((id) => /^Q\d+$/.test(id));
  const notFound = capped.filter((id) => !/^Q\d+$/.test(id));

  const { requested, fetchLangs, primary } = parseLanguages(languageArg);
  const entities: Record<string, unknown> = {};

  if (validIds.length) {
    // wbgetentities normally marks an unknown-but-well-formed id `missing` and
    // still returns the rest — but for an id OUTSIDE the item-id range (a typo
    // like Q99999999999) it refuses the ENTIRE request with a top-level
    // no-such-entity error and HTTP 200. Read naively that is an empty
    // `entities` map, so one bad id used to report every valid id in the batch
    // as not_found: a clean 200 saying nothing resolved. The error names the
    // offending id, so drop that one and retry. Each pass removes exactly one
    // id, and the cap bounds a pathological batch to a sane number of round
    // trips rather than one per id.
    let pending = [...validIds];
    let data: Awaited<ReturnType<typeof wdEntities>> = {};
    const maxRetries = Math.min(validIds.length, MAX_REFUSED_ID_RETRIES);
    for (let attempt = 0; pending.length; attempt++) {
      data = await wdEntities(pending.join('|'), 'info|labels|descriptions|aliases|claims|sitelinks', fetchLangs.join('|'));
      const refused = data.error?.code === 'no-such-entity' ? String(data.error.id ?? '').trim().toUpperCase() : '';
      if (!refused) break;
      notFound.push(refused);
      const next = pending.filter((q) => q !== refused);
      // Stop rather than spin if the API names an id we did not send, or if we
      // have already spent the retry budget — the ids still pending are reported
      // as not_found below, which is what the last response actually supports.
      if (next.length === pending.length || attempt >= maxRetries) { pending = next; break; }
      pending = next;
    }
    for (const qid of pending) {
      const ent = data.entities?.[qid];
      if (!ent || ent.missing !== undefined) { notFound.push(qid); continue; }
      entities[qid] = formatEntity(ent, requested, primary);
    }
  }

  return {
    requested_count: capped.length,
    resolved_count: Object.keys(entities).length,
    not_found: notFound,
    truncated_at_50: truncated,
    entities,
  };
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
      return getFacts(args.id as string, args.language);
    case 'get_entity':
      return getEntity(args.id as string, args.language);
    case 'get_entities':
      return getEntities(args.ids, args.language);
    case 'wikidata_recent_changes':
      return recentChanges(args);
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

  const res = await pwFetch(`${API_BASE}?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Pipeworx-Wikidata-MCP/1.0' },
  });
  if (!res.ok) throw await httpError(res, 'Wikidata API error');

  const data = (await res.json()) as {
    search: Array<{
      id: string;
      label: string;
      description: string;
      aliases: string[];
      concepturi: string;
    }>;
  };

  const results = (data.search ?? []).map((e) => ({
    id: e.id,
    label: e.label ?? null,
    description: e.description ?? null,
    aliases: e.aliases ?? [],
    uri: e.concepturi ?? null,
  }));
  if (results.length) return { results };

  // `wbsearchentities` is a PREFIX matcher over labels and aliases, not a
  // full-text search, and returning a bare `{results: []}` never said so. One
  // account hit that wall 114 times in two days (69% of its searches) while its
  // `get_entity` calls succeeded — it was searching, getting nothing, and
  // resolving QIDs some other way, with no signal about what to change.
  //
  // Two different failures were hiding behind the same empty array:
  //   1. Descriptive phrases. "Sadmeli village in Ambrolauri Municipality" → 0,
  //      but "Sadmeli" → Q16374680, the exact settlement wanted. Only the caller
  //      can shorten that, so the note has to tell them.
  //   2. Generic concepts. "headrace tunnel" → 0 here, but Wikidata's full-text
  //      index (CirrusSearch) returns Q141147623 and two siblings. That one we
  //      can just do.
  // Verified 2026-08-24: CirrusSearch recovers concept terms and does NOT
  // recover the location phrases, so the fallback and the note each cover a case
  // the other cannot. Neither is a substitute for the other.
  const fallback = await cirrusSearch(query, language, safeLimit).catch(() => []);
  const shortest = query.trim().split(/\s+/)[0];
  return {
    results: fallback,
    ...(fallback.length ? { search_mode: 'full_text_fallback' as const } : {}),
    note:
      `Label search matched nothing. Wikidata's entity search matches a PREFIX of an item's ` +
      `label or alias, so a descriptive phrase will not match even when the item exists — ` +
      `"Sadmeli village in Ambrolauri Municipality" finds nothing while "Sadmeli" finds the ` +
      `settlement.` +
      (fallback.length
        ? ` No label matched, so these ${fallback.length} result(s) come from Wikidata's full-text index instead and may be looser.`
        : ` Full-text search found nothing either. Retry with the shortest distinctive token` +
          (shortest && shortest !== query.trim() ? ` — try "${shortest}".` : `.`) +
          ` If it still returns nothing the item may genuinely not exist on Wikidata yet.`),
  };
}

/**
 * Wikidata's full-text index, used only when label search comes back empty.
 * Same host and same `api.php` the rest of the pack already reaches, keyless.
 * Hydrates the QIDs it returns so the shape matches a normal search result.
 */
async function cirrusSearch(query: string, language: string, limit: number) {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: String(Math.min(20, limit)),
    format: 'json',
  });
  const res = await pwFetch(`${API_BASE}?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Pipeworx-Wikidata-MCP/1.0' },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { query?: { search?: Array<{ title: string }> } };
  const qids = (data.query?.search ?? []).map((s) => s.title).filter((t) => /^[QP]\d+$/.test(t));
  if (!qids.length) return [];
  const ld = await wdEntities(qids.join('|'), 'labels|descriptions|aliases', [language, 'en', MUL_LANG].join('|'));
  return qids.map((id) => {
    const e = ld.entities?.[id] as
      | { labels?: Record<string, { value: string }>; descriptions?: Record<string, { value: string }>; aliases?: Record<string, Array<{ value: string }>> }
      | undefined;
    return {
      id,
      label: pickValue(e?.labels, language),
      description: pickValue(e?.descriptions, language),
      aliases: pickAliases(e?.aliases, language),
      uri: `http://www.wikidata.org/entity/${id}`,
    };
  });
}

/**
 * list=recentchanges on the same keyless api.php endpoint the entity tools use.
 * Newest-first; `rcend` bounds how far back we walk, `rccontinue` pages further.
 */
async function recentChanges(args: Record<string, unknown>) {
  const typeArg = String(args.type ?? 'new').trim().toLowerCase();
  if (!['new', 'edit', 'all'].includes(typeArg)) {
    return {
      found: false,
      reason: 'invalid_type',
      hint: 'Argument "type" must be "new" (newly created items), "edit" (edits to existing items) or "all".',
    };
  }
  const namespace = Number.isFinite(Number(args.namespace)) ? Number(args.namespace) : 0;
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));

  const params = new URLSearchParams({
    action: 'query',
    list: 'recentchanges',
    rcnamespace: String(namespace),
    rclimit: String(limit),
    rcprop: 'title|timestamp|ids|user|comment|sizes|flags',
    rcdir: 'older',
    format: 'json',
  });
  if (typeArg !== 'all') params.set('rctype', typeArg);
  if (args.since) {
    const since = new Date(String(args.since));
    if (Number.isNaN(since.getTime())) {
      return {
        found: false,
        reason: 'invalid_since',
        hint: 'Argument "since" must be an ISO 8601 UTC timestamp, e.g. "2026-08-22T00:00:00Z".',
      };
    }
    params.set('rcend', since.toISOString());
  }
  if (args.user) params.set('rcuser', String(args.user));
  if (args.cursor) params.set('rccontinue', String(args.cursor));

  const res = await pwFetch(`${API_BASE}?${params}`, { headers: WD_HEADERS });
  if (!res.ok) throw await httpError(res, 'Wikidata API error');

  const data = (await res.json()) as {
    continue?: { rccontinue?: string };
    error?: { code?: string; info?: string };
    query?: {
      recentchanges?: Array<{
        type: string;
        ns: number;
        title: string;
        pageid: number;
        revid: number;
        old_revid: number;
        user?: string;
        comment?: string;
        oldlen?: number;
        newlen?: number;
        timestamp: string;
      }>;
    };
  };

  if (data.error) {
    return {
      found: false,
      reason: data.error.code ?? 'wikidata_api_error',
      hint: data.error.info ?? 'Wikidata rejected the recent-changes query. Check "namespace", "since" and "cursor".',
    };
  }

  const rows = data.query?.recentchanges ?? [];
  const changes = rows.map((c) => ({
    id: c.title,
    change_type: c.type,
    namespace: c.ns,
    pageid: c.pageid,
    lastrevid: c.revid,
    previous_revid: c.old_revid || null,
    timestamp: c.timestamp,
    user: c.user ?? null,
    comment: c.comment ?? null,
    size_bytes: c.newlen ?? null,
    size_change_bytes:
      c.newlen != null && c.oldlen != null ? c.newlen - c.oldlen : null,
    url: `https://www.wikidata.org/wiki/${c.title}`,
    revision_url: `https://www.wikidata.org/w/index.php?oldid=${c.revid}`,
  }));

  if (!changes.length) {
    return {
      found: false,
      reason: 'no_changes_in_window',
      hint: args.since
        ? `No ${typeArg} changes in namespace ${namespace} since ${String(args.since)}. Widen "since" or set type to "all".`
        : `No ${typeArg} changes returned for namespace ${namespace}. Namespace 0 is items (Q-ids), 120 is properties, 146 is lexemes.`,
      namespace,
      type: typeArg,
    };
  }

  return {
    found: true,
    type: typeArg,
    namespace,
    count: changes.length,
    // Newest-first, so the first row answers "most recently created/edited".
    most_recent: changes[0].id,
    most_recent_timestamp: changes[0].timestamp,
    changes,
    cursor: data.continue?.rccontinue ?? null,
    source: 'Wikidata MediaWiki API, list=recentchanges',
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
