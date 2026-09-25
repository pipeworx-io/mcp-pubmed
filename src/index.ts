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
 * PubMed MCP — wraps the NCBI E-utilities API (biomedical literature, free, no auth)
 *
 * Tools:
 * - search_pubmed: search PubMed articles by keyword or query
 * - get_summary: get metadata summaries for one or more PubMed IDs; authors[]
 *   stays plain name strings, with author_details[] adding per-author
 *   affiliations[] and emails[] parsed from efetch XML
 * - get_abstract: get the full abstract text for a single article
 */


const BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

// NCBI E-utilities polite pool. Identified traffic (tool + email) is throttled
// far less aggressively than anonymous — the top pubmed error is
// upstream_throttled (159/48h on the shared CF egress). tool+email go on every
// request; api_key (optional, from _apiKey / a platform key) lifts the rate
// limit from 3 to 10 req/sec. NCBI_KEY is set at the top of callTool.
const NCBI_TOOL = 'pipeworx-mcp';
const NCBI_EMAIL = 'ops@pipeworx.io';
let NCBI_KEY: string | undefined;
function withNcbiParams(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  let extra = `tool=${NCBI_TOOL}&email=${encodeURIComponent(NCBI_EMAIL)}`;
  if (NCBI_KEY) extra += `&api_key=${encodeURIComponent(NCBI_KEY)}`;
  return `${url}${sep}${extra}`;
}

// ── API Response Types ────────────────────────────────────────────────

type ESearchResult = {
  esearchresult: {
    count: string;
    retmax: string;
    retstart: string;
    idlist: string[];
    querytranslation?: string;
  };
};

type ESummaryAuthor = {
  name: string;
  authtype: string;
};

type ESummaryArticle = {
  uid: string;
  pubdate: string;
  epubdate: string;
  source: string;
  authors: ESummaryAuthor[];
  lastauthor: string;
  title: string;
  sorttitle: string;
  volume: string;
  issue: string;
  pages: string;
  lang: string[];
  issn: string;
  essn: string;
  pubtype: string[];
  articleids: Array<{ idtype: string; idtypen: number; value: string }>;
  fulljournalname: string;
  sortpubdate: string;
  pmcrefcount: string;
};

type ESummaryResult = {
  result: {
    uids: string[];
    [pmid: string]: ESummaryArticle | string[];
  };
};

type EvidenceBucket = {
  key: string;
  label: string;
  filter: string;
};

const EVIDENCE_BUCKETS: EvidenceBucket[] = [
  { key: 'clinical_trials', label: 'Clinical Trial', filter: 'clinical trial[pt]' },
  { key: 'randomized_trials', label: 'Randomized Controlled Trial', filter: 'randomized controlled trial[pt]' },
  { key: 'systematic_reviews', label: 'Systematic Review', filter: 'systematic review[pt]' },
  { key: 'meta_analyses', label: 'Meta-Analysis', filter: 'meta-analysis[pt]' },
  { key: 'observational_studies', label: 'Observational Study', filter: 'observational study[pt]' },
  { key: 'case_reports', label: 'Case Reports', filter: 'case reports[pt]' },
];

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Extract abstract text from PubMed XML (efetch response).
 * PubMed returns AbstractText elements which may be plain or have Label attributes.
 */
function parseAbstractFromXml(xml: string): string | null {
  // Collect all AbstractText content, stripping XML tags
  const abstractMatches = xml.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g);
  if (!abstractMatches || abstractMatches.length === 0) return null;

  return abstractMatches
    .map((block) => {
      // Extract Label attribute if present
      const labelMatch = block.match(/Label="([^"]+)"/);
      const label = labelMatch ? `${labelMatch[1]}: ` : '';
      // Strip all tags and decode common XML entities
      const text = block
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
      return label + text;
    })
    .filter(Boolean)
    .join(' ');
}

function getDoi(article: ESummaryArticle): string | null {
  const doiEntry = article.articleids?.find((a) => a.idtype === 'doi');
  return doiEntry?.value ?? null;
}

// fleet #1836: esummary (used by mapSummary below) carries author NAMES only —
// no affiliation, no email. NCBI efetch XML carries <AffiliationInfo><Affiliation>
// per <Author>, and a corresponding-author email frequently appears inside that
// affiliation string rather than as its own field. get_summary is the only
// consumer of this — search_pubmed/get_related_articles/get_citations keep the
// bare esummary author strings unchanged, exactly as asked.
type EfetchAuthorAffil = {
  name: string;
  affiliations: string[];
  emails: string[];
};

// Plain regex only — no resolving, guessing, or enriching an address that
// isn't literally present in the affiliation text.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
function extractEmails(text: string): string[] {
  const matches = text.match(EMAIL_RE);
  return matches ? [...new Set(matches)] : [];
}

function parseAuthorAffiliationsFromArticleXml(articleXml: string): EfetchAuthorAffil[] {
  const authorListMatch = articleXml.match(/<AuthorList[^>]*>([\s\S]*?)<\/AuthorList>/);
  if (!authorListMatch) return [];
  const authorBlocks = authorListMatch[1].match(/<Author[^>]*>([\s\S]*?)<\/Author>/g) ?? [];
  return authorBlocks.map((block) => {
    const lastName = block.match(/<LastName>([\s\S]*?)<\/LastName>/)?.[1];
    const foreName = block.match(/<ForeName>([\s\S]*?)<\/ForeName>/)?.[1];
    const initials = block.match(/<Initials>([\s\S]*?)<\/Initials>/)?.[1];
    const collective = block.match(/<CollectiveName>([\s\S]*?)<\/CollectiveName>/)?.[1];
    const name = collective
      ? decodeXml(collective)
      : [lastName, foreName ?? initials].filter(Boolean).map((s) => decodeXml(s as string)).join(' ').trim();
    // A single author can carry more than one <AffiliationInfo> — keep every
    // affiliation string verbatim (after stripping XML entities/tags), in order.
    const affiliations = [...block.matchAll(/<Affiliation>([\s\S]*?)<\/Affiliation>/g)]
      .map((m) => decodeXml(m[1]));
    const emails = [...new Set(affiliations.flatMap(extractEmails))];
    return { name, affiliations, emails };
  });
}

// Batched efetch (retmode=xml) keyed by PMID, so get_summary's existing
// up-to-~200-id batch stays one extra upstream call, not one per id.
// Best-effort: if efetch fails, get_summary still returns its esummary-derived
// core fields rather than failing the whole call over an enrichment field.
async function fetchAffiliationsByPmid(idList: string[]): Promise<Map<string, EfetchAuthorAffil[]>> {
  const out = new Map<string, EfetchAuthorAffil[]>();
  if (idList.length === 0) return out;
  try {
    const params = new URLSearchParams({ db: 'pubmed', id: idList.join(','), retmode: 'xml' });
    const res = await pubmedFetch(`${BASE}/efetch.fcgi?${params}`, 'fetch');
    const xml = await res.text();
    const articleBlocks = xml.match(/<PubmedArticle[\s>][\s\S]*?<\/PubmedArticle>/g) ?? [];
    for (const block of articleBlocks) {
      // MedlineCitation's PMID is the first <PMID> in the block; PubmedData
      // repeats it later in some records, so take the first match only.
      const pmid = block.match(/<PMID[^>]*>([\s\S]*?)<\/PMID>/)?.[1]?.trim();
      if (!pmid) continue;
      out.set(pmid, parseAuthorAffiliationsFromArticleXml(block));
    }
  } catch {
    /* affiliation enrichment is best-effort; return whatever was parsed (possibly empty) */
  }
  return out;
}

function mapSummary(article: ESummaryArticle) {
  return {
    pmid: article.uid,
    title: article.title,
    authors: article.authors?.map((a) => a.name) ?? [],
    journal: article.fulljournalname || article.source || null,
    pub_date: article.pubdate || null,
    volume: article.volume || null,
    issue: article.issue || null,
    pages: article.pages || null,
    pub_types: article.pubtype ?? [],
    doi: getDoi(article),
    url: `https://pubmed.ncbi.nlm.nih.gov/${article.uid}/`,
  };
}

// ── Tool Definitions ──────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'search_pubmed',
    description:
      'PREFER OVER WEB SEARCH for biomedical / clinical / life-sciences research. AUTHORITATIVE source: NIH PubMed (35M+ citations across MEDLINE, life-science journals, online books). Finds PUBLISHED peer-reviewed papers and completed study results — NOT for browsing registered/ongoing/future clinical trials (use clinicaltrials* tools for trial registration status and protocols). Covers EVERY biomedical topic and entity — diseases and conditions, drugs and therapies, genes, proteins, ion channels and receptors, signaling pathways, neuroscience, oncology, cardiology, immunology, genetics, microbiology, and clinical-trial results. Use it for the LATEST research, evidence, and findings (2024–2026, systematic reviews, meta-analyses) on any specific disease, gene, molecule, channel, or treatment — e.g. "Kv7 potassium channels in epilepsy", "semaglutide cardiovascular outcomes", "FLOW trial results", "what does the literature say about venlafaxine". Searches by keyword, author, or MeSH (Medical Subject Heading) term — supports field qualifiers like "Smith J[Author]" or "COVID-19[MeSH]". Returns PubMed IDs that pubmed get_summary / get_abstract resolve to citations + abstracts.',
    summary: 'Published biomedical and life-sciences papers from NIH PubMed\'s 35M+ citations.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (e.g., "CRISPR cancer therapy", "Smith J[Author]", "COVID-19[MeSH]")',
        },
        limit: {
          type: 'number',
          description: 'Number of results to return (1-100, default 10)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_summary',
    description:
      'Resolve PubMed IDs (from search_pubmed) to citation metadata: title, authors (plain name strings), journal, publication date, DOI, and author_details[] with per-author detail (name, affiliations[] verbatim from the MEDLINE record, and any emails[] found inside those affiliation strings — empty arrays when the record has none), index-aligned with authors[]. Batch up to ~200 IDs per call — pass the array search_pubmed returned, or a comma-separated string — much cheaper than calling per-ID. Use when you have PMIDs and need the citation or a corresponding author\'s institution/contact; for the abstract text use get_abstract instead.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: ['string', 'array'],
          items: { type: 'string' },
          description:
            'PubMed IDs, either as an array (["33579999","34567890"] — what search_pubmed returns) '
            + 'or as a comma-separated string ("33579999,34567890").',
        },
      },
      required: ['ids'],
    },
  },
  {
    name: 'get_abstract',
    description:
      'Full abstract text for one PubMed article by ID. Returns the abstract with structured sections (background, methods, results, conclusions) when the journal published it that way, otherwise the unstructured abstract. Use when summarizing a single paper or answering "what does paper X actually say". For batch citation metadata use get_summary; for finding papers use search_pubmed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'A single PubMed ID (e.g., "33579999"). `pmid` is accepted as a synonym.',
        },
        pmid: {
          type: 'string',
          description: 'Synonym for `id` — the other PMID-taking tools in this pack spell it this way.',
        },
      },
      // Deliberately no `required`. This tool spelled its argument `id` while
      // get_related_articles, get_citations and get_full_text all spell the
      // same value `pmid`, so a caller who learned the pack from any sibling
      // sent `pmid` here and got nothing back. Restoring `required: ['id']`
      // silently re-breaks that: the gateway checks declared required args
      // BEFORE calling the pack, so the rescue in callTool never runs and the
      // call is rejected at the door. normalizePubmedId still rejects an
      // absent value as `user_error`, so nothing is lost by dropping it.
    },
  },
  {
    // fleet #1329: bare `get_related_articles` carries no source and sits
    // unattributable next to every other pack's "related" tool. The gateway
    // only auto-namespaces on a cross-pack COLLISION (see NAME_PACKS in
    // workers/gateway/src/index.ts) and this name is unique, so it was left
    // bare — backwards, since a unique-but-generic name is exactly the one a
    // model can't attribute to PubMed. `pubmed_get_related_articles` below is
    // now the model-facing name; this bare entry is a permanent alias kept
    // registered (same handler, same schema) because it carries live traffic
    // — do not remove it.
    name: 'get_related_articles',
    description:
      'DEPRECATED ALIAS for pubmed_get_related_articles — identical behavior, kept for existing callers. New callers should use pubmed_get_related_articles.',
    inputSchema: {
      type: 'object',
      properties: {
        pmid: { type: 'string', description: 'A single PubMed ID to find neighbors for (e.g., "24025838")' },
        limit: { type: 'number', description: 'Number of related articles to return (1-50, default 10)' },
      },
      required: ['pmid'],
    },
  },
  {
    name: 'pubmed_get_related_articles',
    description:
      "Find papers SIMILAR to a given article — NIH PubMed's own computed 'related articles' (pubmed_pubmed neighbors), ranked by relevance using shared terms/MeSH/citations. Pass one PMID; returns the top related papers with full citation metadata (title, authors, journal, date, DOI). Use for \"more papers like this\", building a reading list from a seed paper, or broadening a literature search beyond keyword matches. Distinct from pubmed_get_citations (which finds papers that cite this one).",
    inputSchema: {
      type: 'object',
      properties: {
        pmid: { type: 'string', description: 'A single PubMed ID to find neighbors for (e.g., "24025838")' },
        limit: { type: 'number', description: 'Number of related articles to return (1-50, default 10)' },
      },
      required: ['pmid'],
    },
  },
  {
    // Same fleet #1329 alias pattern as get_related_articles above.
    name: 'get_citations',
    description:
      'DEPRECATED ALIAS for pubmed_get_citations — identical behavior, kept for existing callers. New callers should use pubmed_get_citations.',
    inputSchema: {
      type: 'object',
      properties: {
        pmid: { type: 'string', description: 'A single PubMed ID to find citing papers for (e.g., "24025838")' },
        limit: { type: 'number', description: 'Number of citing papers to return (1-50, default 10)' },
      },
      required: ['pmid'],
    },
  },
  {
    name: 'pubmed_get_citations',
    description:
      'Find papers that CITE a given article — forward citation search. Pass one PMID; returns citing papers (most recent first) with full citation metadata. Use for "who cited this", "has this finding been replicated or challenged", or tracking a paper\'s downstream impact. NOTE: coverage is the PubMed Central citation graph (open-access + participating publishers), so the count is a FLOOR, not the paper\'s total citation count (for that, a tool like Semantic Scholar / OpenAlex covers more). Distinct from pubmed_get_related_articles (similar papers, not citing papers).',
    inputSchema: {
      type: 'object',
      properties: {
        pmid: { type: 'string', description: 'A single PubMed ID to find citing papers for (e.g., "24025838")' },
        limit: { type: 'number', description: 'Number of citing papers to return (1-50, default 10)' },
      },
      required: ['pmid'],
    },
  },
  {
    // Same fleet #1329 alias pattern. get_full_text is the headline reason to
    // want PubMed Central and the sharpest case in the task: it WORKS (verified
    // live, pmid 32205204 -> 19,146 chars, has_full_text true) but no model can
    // tell a tool named `get_full_text` is PMC. Kept registered so the 12
    // calls/30d already using this name keep working.
    name: 'get_full_text',
    description:
      'DEPRECATED ALIAS for pubmed_get_full_text — identical behavior, kept for existing callers. New callers should use pubmed_get_full_text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pmid: { type: 'string', description: 'PubMed ID (e.g. "34265844") or a PMC id ("PMC8371605").' },
      },
      required: ['pmid'],
    },
  },
  {
    name: 'pubmed_get_full_text',
    description:
      'Fetch the FULL TEXT of a biomedical paper from PubMed Central (the open-access subset) by PubMed ID. PREFER OVER get_abstract when you need methods/results/discussion, not just the abstract — "read the full paper", "what methods did <PMID> use", "extract details from the paper". Resolves the PMID to its PMC id and returns the article body text (capped ~40k chars). Only open-access articles are in PMC — returns has_full_text:false (use get_abstract) otherwise.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pmid: { type: 'string', description: 'PubMed ID (e.g. "34265844") or a PMC id ("PMC8371605").' },
      },
      required: ['pmid'],
    },
  },
  {
    name: 'pubmed_evidence_landscape',
    description:
      'Profile the composition of a biomedical evidence base by counting PubMed publication types for a topic: clinical trials, randomized trials, systematic reviews, meta-analyses, observational studies, and case reports. Use for evidence diligence and questions like "what kinds of studies exist on this target or therapy?" Counts are publication-index signals, not efficacy, quality, independence, or clinical-success judgments.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'PubMed topic query, including field qualifiers when useful.' },
        from_year: { type: 'number', description: 'Optional first publication year (four digits).' },
        to_year: { type: 'number', description: 'Optional last publication year (four digits).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'pubmed_publication_trend',
    description:
      'Count PubMed publications by year for a biomedical topic. Use for publication momentum, emerging-target activity, or whether a field is accelerating or cooling. Returns exact PubMed search counts for up to 10 calendar years; volume can reflect indexing and terminology changes and is not evidence quality or commercial validation.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'PubMed topic query, including field qualifiers when useful.' },
        from_year: { type: 'number', description: 'First year, default five years before to_year.' },
        to_year: { type: 'number', description: 'Last year, default current UTC year.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'pubmed_integrity_check',
    description:
      'Check one PubMed citation for NLM-indexed retraction, expression-of-concern, erratum, update, duplicate-publication, and republished-article links. Use before relying on a specific PMID in diligence or evidence synthesis. Reports only relationships present in PubMed; absence of a flag is not an independent validation of the paper.',
    inputSchema: {
      type: 'object',
      properties: {
        pmid: { type: 'string', description: 'A single numeric PubMed ID.' },
      },
      required: ['pmid'],
    },
  }
];

// ── Tool Implementations ──────────────────────────────────────────────

// In-pack retry on 5xx + timeout. Production analytics 2026-06-09 caught
// `PubMed search error: 500` x4/day — sporadic CF-to-CF flakes from
// eutils.ncbi.nlm.nih.gov, same shape as the FRED 520 pattern that fred's
// fredFetch already handles. 3 attempts with exponential backoff
// (250ms, 1000ms); upstream_down envelope on exhaustion so the gateway
// classifier routes correctly and ask_pipeworx fans out to sibling
// bibliometric packs (openalex, crossref, semantic-scholar).
const PUBMED_RETRY_DELAYS_MS = [250, 1000];
const PUBMED_PER_ATTEMPT_TIMEOUT_MS = 8000;
async function pubmedFetch(url: string, label: 'search' | 'summary' | 'fetch', attempt = 1): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), PUBMED_PER_ATTEMPT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(withNcbiParams(url), { signal: controller.signal });
  } catch (e) {
    clearTimeout(t);
    if ((e as Error)?.name === 'AbortError') {
      if (attempt <= PUBMED_RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, PUBMED_RETRY_DELAYS_MS[attempt - 1]));
        return pubmedFetch(url, label, attempt + 1);
      }
      throw new Error(`upstream_down: PubMed ${label} timeout — eutils.ncbi.nlm.nih.gov did not respond within ${PUBMED_PER_ATTEMPT_TIMEOUT_MS}ms on any of ${attempt} attempts.`);
    }
    throw e;
  }
  clearTimeout(t);
  // Retry on 429 (NCBI rate limit — the top pubmed error) AND 5xx flakes. A 429
  // needs a real pause, so back off 2× longer than the 5xx-flake path.
  const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
  if (retryable && attempt <= PUBMED_RETRY_DELAYS_MS.length) {
    const base = PUBMED_RETRY_DELAYS_MS[attempt - 1];
    await new Promise((r) => setTimeout(r, res.status === 429 ? base * 2 : base));
    return pubmedFetch(url, label, attempt + 1);
  }
  if (!res.ok) {
    const attemptNote = attempt > 1 ? ` (after ${attempt} attempts)` : '';
    const prefix = res.status >= 500 ? 'upstream_down: ' : '';
    throw new Error(`${prefix}PubMed ${label} error: ${res.status}${attemptNote}`);
  }
  return res;
}

async function searchPubmed(query: string, limit: number) {
  const retmax = Math.min(100, Math.max(1, limit));
  const params = new URLSearchParams({
    db: 'pubmed',
    term: query,
    retmode: 'json',
    retmax: String(retmax),
  });

  const res = await pubmedFetch(`${BASE}/esearch.fcgi?${params}`, 'search');

  const data = (await res.json()) as ESearchResult;
  const r = data.esearchresult;

  // Enrich with citation metadata in one esummary call so results are usable on
  // their own — title, authors, journal, date — instead of bare PMIDs the caller
  // has to resolve separately (which the router often doesn't, leaving the answer
  // with no titles/dates). Falls back to pmids-only if the summary call fails.
  let articles: Awaited<ReturnType<typeof summarizeIds>> = [];
  if (r.idlist.length > 0) {
    try {
      articles = await summarizeIds(r.idlist);
    } catch {
      /* keep pmids-only result */
    }
  }

  return {
    total: parseInt(r.count, 10),
    returned: r.idlist.length,
    query_translation: r.querytranslation ?? null,
    pmids: r.idlist,
    articles,
  };
}

function normalizeYear(raw: unknown, fallback: number, label: string): number {
  if (raw == null) return fallback;
  const year = Number(raw);
  if (!Number.isInteger(year) || year < 1800 || year > 2200) {
    throw new Error(`user_error: ${label} must be a four-digit year.`);
  }
  return year;
}

function dateQualifiedQuery(query: string, fromYear?: number, toYear?: number): string {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) throw new Error('user_error: query is required.');
  if (fromYear == null && toYear == null) return trimmed;
  const from = fromYear ?? 1800;
  const to = toYear ?? new Date().getUTCFullYear();
  if (from > to) throw new Error('user_error: from_year must be less than or equal to to_year.');
  return `(${trimmed}) AND ${from}:${to}[pdat]`;
}

async function pubmedCount(query: string): Promise<number> {
  const params = new URLSearchParams({ db: 'pubmed', term: query, retmode: 'json', retmax: '0' });
  const res = await pubmedFetch(`${BASE}/esearch.fcgi?${params}`, 'search');
  const data = (await res.json()) as ESearchResult;
  const count = Number(data.esearchresult.count);
  if (!Number.isFinite(count)) throw new Error('upstream_down: PubMed returned an invalid count.');
  return count;
}

async function evidenceLandscape(queryRaw: unknown, fromRaw: unknown, toRaw: unknown) {
  const currentYear = new Date().getUTCFullYear();
  const fromYear = fromRaw == null ? undefined : normalizeYear(fromRaw, currentYear, 'from_year');
  const toYear = toRaw == null ? undefined : normalizeYear(toRaw, currentYear, 'to_year');
  const query = dateQualifiedQuery(String(queryRaw ?? ''), fromYear, toYear);
  const total = await pubmedCount(query);
  const buckets: Array<{ key: string; label: string; count: number; share_of_total: number | null }> = [];
  // Keep requests sequential: NCBI's unauthenticated polite pool is 3 requests/sec.
  for (const bucket of EVIDENCE_BUCKETS) {
    const count = await pubmedCount(`(${query}) AND ${bucket.filter}`);
    buckets.push({
      key: bucket.key,
      label: bucket.label,
      count,
      share_of_total: total > 0 ? Number((count / total).toFixed(4)) : null,
    });
  }
  return {
    query: String(queryRaw).trim(),
    publication_year_range: fromYear == null && toYear == null ? null : { from: fromYear ?? 1800, to: toYear ?? currentYear },
    total_publications: total,
    evidence_types: buckets,
    scope_note: 'Publication types overlap, so bucket counts and shares are not additive. Counts describe PubMed indexing, not study quality, efficacy, independence, or clinical success.',
  };
}

async function publicationTrend(queryRaw: unknown, fromRaw: unknown, toRaw: unknown) {
  const currentYear = new Date().getUTCFullYear();
  const toYear = normalizeYear(toRaw, currentYear, 'to_year');
  const fromYear = normalizeYear(fromRaw, toYear - 5, 'from_year');
  if (fromYear > toYear) throw new Error('user_error: from_year must be less than or equal to to_year.');
  if (toYear - fromYear > 9) throw new Error('user_error: publication trend is limited to 10 calendar years per call.');
  const baseQuery = String(queryRaw ?? '').trim();
  if (!baseQuery) throw new Error('user_error: query is required.');
  const years: Array<{ year: number; publications: number }> = [];
  for (let year = fromYear; year <= toYear; year += 1) {
    years.push({ year, publications: await pubmedCount(`(${baseQuery}) AND ${year}[pdat]`) });
  }
  const first = years[0]?.publications ?? 0;
  const last = years.at(-1)?.publications ?? 0;
  return {
    query: baseQuery,
    from_year: fromYear,
    to_year: toYear,
    years,
    change_first_to_last: last - first,
    percent_change_first_to_last: first > 0 ? Number((((last - first) / first) * 100).toFixed(1)) : null,
    scope_note: 'The current year may be incomplete. Counts can change with indexing and terminology and do not measure evidence quality or commercial validation.',
  };
}

function decodeXml(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // fleet #1836: NCBI efetch XML routinely carries non-ASCII author/affiliation
    // text (accented names, institutions) as numeric character references —
    // e.g. "Associa&#xe7;&#xe3;o" for "Associação" — which the 5 named-entity
    // replacements above never touched. Left undecoded, an affiliation string
    // is not "verbatim" text, it's still XML-escaped. Decode hex/decimal forms
    // after the named ones so a literal "&#38;"-style escape of "&" round-trips
    // correctly rather than double-unescaping.
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .trim();
}

function parseIntegrityXml(xml: string, pmid: string) {
  const publicationTypes = [...xml.matchAll(/<PublicationType[^>]*>([\s\S]*?)<\/PublicationType>/g)]
    .map((match) => decodeXml(match[1]));
  const relationships = [...xml.matchAll(/<CommentsCorrections\s+RefType="([^"]+)"[^>]*>([\s\S]*?)<\/CommentsCorrections>/g)]
    .map((match) => {
      const body = match[2];
      const relatedPmid = body.match(/<PMID[^>]*>([^<]+)<\/PMID>/)?.[1]?.trim() ?? null;
      const source = body.match(/<RefSource>([\s\S]*?)<\/RefSource>/)?.[1];
      return {
        type: match[1],
        related_pmid: relatedPmid,
        citation: source ? decodeXml(source) : null,
        url: relatedPmid ? `https://pubmed.ncbi.nlm.nih.gov/${relatedPmid}/` : null,
      };
    });
  // PubMed's CommentsCorrections RefTypes are DIRECTIONAL, and collapsing that
  // direction is the difference between "this paper was retracted" and "this
  // paper IS the retraction notice". Verified against live records: PMID 9500320
  // (Wakefield 1998) carries PublicationType "Retracted Publication" plus
  // RetractionIn and ExpressionOfConcernIn — genuinely compromised. PMID 20137807
  // carries "Retraction Notice" and RetractionOf — an authoritative correction
  // record, not a tainted paper. Matching /retract/ against both flagged them
  // identically, and a diligence caller reading one boolean would have discarded
  // the notice along with the paper it retracts.
  //
  // Severity is separated for the same reason: an erratum or a superseded
  // Cochrane update is routine housekeeping, and grouping it with retraction
  // turns ordinary corrections into an integrity alarm.
  const norm = (value: string) => value.replace(/[^a-z]/gi, '').toLowerCase();
  const SERIOUS_ABOUT_THIS = /^(retractionin|expressionofconcernin)$/;
  const CORRECTION_ABOUT_THIS = /^(erratumin|updatein|duplicatepublicationin|republishedin)$/;
  const THIS_IS_THE_NOTICE = /^(retractionof|expressionofconcernfor|erratumfor|updateof|duplicatepublicationfor|republishedfrom)$/;

  const classify = (refType: string) => {
    const key = norm(refType);
    if (SERIOUS_ABOUT_THIS.test(key)) return 'retracted_or_concern';
    if (CORRECTION_ABOUT_THIS.test(key)) return 'corrected_or_updated';
    if (THIS_IS_THE_NOTICE.test(key)) return 'this_record_is_the_notice';
    return null;
  };

  const classified = relationships
    .map((item) => ({ ...item, integrity_role: classify(item.type) }))
    .filter((item) => item.integrity_role !== null);

  // "Retracted Publication" means this article was retracted; "Retraction Notice"
  // means it is the notice. Both contain "retract".
  const retractedType = publicationTypes.some((t) => norm(t) === 'retractedpublication');
  const isNoticeType = publicationTypes.some((t) => /^(retractionnotice|publishederratum|expressionofconcern)$/.test(norm(t)));

  const retractedOrConcern = retractedType || classified.some((c) => c.integrity_role === 'retracted_or_concern');
  const correctedOnly = !retractedOrConcern && classified.some((c) => c.integrity_role === 'corrected_or_updated');

  return {
    pmid,
    publication_types: publicationTypes,
    // The headline answer a caller acts on: was THIS article retracted or placed
    // under an expression of concern.
    retracted_or_concern: retractedOrConcern,
    corrected_or_updated: correctedOnly,
    is_itself_a_correction_notice: isNoticeType || classified.some((c) => c.integrity_role === 'this_record_is_the_notice'),
    status: retractedOrConcern ? 'retracted_or_concern'
      : correctedOnly ? 'corrected_or_updated'
        : isNoticeType ? 'this_record_is_a_correction_notice'
          : 'no_indexed_notice',
    flagged_publication_types: publicationTypes.filter((t) => /retract|erratum|expressionofconcern/i.test(norm(t))),
    relationships: classified,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    scope_note: 'Reports NLM-indexed citation relationships only, and they are directional: retracted_or_concern is about THIS article, while is_itself_a_correction_notice means this record is the notice about another one. An erratum or a superseded update is routine and is not a retraction. No flag is not an independent validation of the article.',
  };
}

async function integrityCheck(pmidRaw: unknown) {
  const pmid = normalizePubmedId(pmidRaw);
  if (!/^\d+$/.test(pmid)) throw new Error('user_error: pubmed_integrity_check requires a numeric PMID.');
  const params = new URLSearchParams({ db: 'pubmed', id: pmid, retmode: 'xml' });
  const res = await pubmedFetch(`${BASE}/efetch.fcgi?${params}`, 'fetch');
  const xml = await res.text();
  if (!/<PubmedArticle[\s>]/.test(xml)) throw new Error(`No PubMed record found for PMID: ${pmid}`);
  return parseIntegrityXml(xml, pmid);
}

// Resolve a list of PMIDs to mapped citation summaries (esummary batch).
// Preserves the order of `idList` (esummary's result.uids order isn't
// guaranteed to match), so relevance/recency ranking from elink survives.
async function summarizeIds(idList: string[]) {
  if (idList.length === 0) return [];
  const params = new URLSearchParams({ db: 'pubmed', id: idList.join(','), retmode: 'json' });
  const res = await pubmedFetch(`${BASE}/esummary.fcgi?${params}`, 'summary');
  const data = (await res.json()) as ESummaryResult;
  return idList
    .map((uid) => data.result[uid] as (ESummaryArticle & { error?: string }) | undefined)
    // A PMID that does not exist still comes back as an OBJECT carrying an
    // `error` string, so Boolean() is not enough to reject it — drop anything
    // NCBI has flagged, and anything with no title, which is the same shell by
    // another route.
    .filter((a): a is ESummaryArticle & { error?: string } => a !== undefined && !a.error && Boolean(a.title))
    .map(mapSummary);
}

// `ids` accepts BOTH shapes on purpose. search_pubmed hands back an array of
// pmids and passing it straight through is the obvious next call, but this
// tool shipped declaring a comma-separated string and the dispatcher cast to
// one — so the array form died LOUD on `ids.split is not a function` for
// every caller who did the obvious thing (fleet #1837). Accepting both is
// cheaper than teaching every caller which spelling this one tool wants.
function normalizeIds(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : [raw];
  return parts
    // A single element may itself be a comma list, and a pmid may arrive as a
    // number, so split and stringify rather than assuming either.
    .flatMap((p) => String(p ?? '').split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

async function getSummary(raw: unknown) {
  const idList = normalizeIds(raw);
  if (idList.length === 0) {
    // user_error: an empty list is a caller mistake, not a PubMed outage.
    throw new Error(
      'user_error: get_summary needs at least one PubMed ID, and none were supplied. '
      + 'Pass an array (["33579999","34567890"]) or a comma-separated string '
      + '("33579999,34567890"). Find real PMIDs with pubmed search_pubmed.',
    );
  }
  const articles = await summarizeIds(idList);
  if (articles.length === 0) {
    // user_error: a wrong PMID is a caller mistake. Without the prefix every
    // invented id books as a pubmed outage on the Problem Tools list.
    throw new Error(
      `user_error: No PubMed record exists for ID${idList.length > 1 ? 's' : ''}: ${idList.join(',')}. `
      + 'PubMed returned no document summary for them, so there is nothing to report — '
      + 'these are not articles with sparse metadata. Find real PMIDs with pubmed search_pubmed.',
    );
  }
  // fleet #1836 enriched authors[] with affiliations/emails by turning it
  // into an array of objects — that silently broke every caller reading
  // authors[i] as a bare name string (214 external calls/90d, fleet #1857).
  // Fix: authors[] stays string[] exactly as it always was; the enrichment
  // moves to a new author_details[] field instead. Index-aligned against
  // esummary's author order (both come from the same MEDLINE AuthorList)
  // rather than matched by name, since esummary and efetch spell names
  // differently ("Smith JA" vs LastName/ForeName). A record with no
  // AffiliationInfo, or a failed efetch, yields affiliations: [] / emails: []
  // — that empty array is correct, not an error.
  const affilByPmid = await fetchAffiliationsByPmid(articles.map((a) => a.pmid));
  const enriched = articles.map((article) => {
    const efetchAuthors = affilByPmid.get(article.pmid) ?? [];
    return {
      ...article,
      author_details: article.authors.map((name, i) => ({
        name,
        affiliations: efetchAuthors[i]?.affiliations ?? [],
        emails: efetchAuthors[i]?.emails ?? [],
      })),
    };
  });
  return { articles: enriched };
}

// elink neighbor/citation lookup. NCBI occasionally emits raw control
// characters in the JSON body (seen in pubmed_pubmed_citedin), which break
// res.json() — read as text and strip C0 controls before parsing. Returns
// the ranked PMID list for the requested linkname (relevance for neighbors,
// recency for citedin), with the query PMID itself removed.
async function elinkPmids(pmid: string, linkname: string): Promise<string[]> {
  const params = new URLSearchParams({
    dbfrom: 'pubmed',
    db: 'pubmed',
    id: pmid,
    linkname,
    retmode: 'json',
  });
  const res = await pubmedFetch(`${BASE}/elink.fcgi?${params}`, 'fetch');
  const raw = (await res.text()).replace(/[\u0000-\u001f]/g, ' ');
  const data = JSON.parse(raw) as {
    linksets?: { linksetdbs?: { linkname: string; links: string[] }[] }[];
  };
  const dbs = data.linksets?.[0]?.linksetdbs ?? [];
  const match = dbs.find((d) => d.linkname === linkname) ?? dbs[0];
  const links = match?.links ?? [];
  return links.filter((id) => id !== pmid);
}

async function getRelatedArticles(pmid: string, limit: number) {
  const count = Math.min(50, Math.max(1, limit));
  const ids = (await elinkPmids(pmid, 'pubmed_pubmed')).slice(0, count);
  const articles = await summarizeIds(ids);
  return {
    pmid,
    relation: 'related (computed neighbors, relevance-ranked)',
    total_related: ids.length,
    articles,
  };
}

async function getCitations(pmid: string, limit: number) {
  const count = Math.min(50, Math.max(1, limit));
  const all = await elinkPmids(pmid, 'pubmed_pubmed_citedin');
  const articles = await summarizeIds(all.slice(0, count));
  return {
    pmid,
    relation: 'cited-by (PubMed Central citation graph; count is a floor)',
    total_citing_in_pmc: all.length,
    articles,
  };
}

// Normalize what the caller handed us before it reaches efetch. Without this,
// anything non-numeric — a title, a DOI, a gene name, whatever the router
// guessed — went straight into the query string and came back as a bare
// `PubMed fetch error: 400`, which the classifier books as OUR bug. That was
// 14 of this tool's 31 calls in 24h (2026-08-02), the largest single error
// source on the platform that day, and every one was really a caller passing
// the wrong kind of string.
//
// `getFullText` below has normalized since it was written; `get_abstract` is
// the one that never got it. Accepts the two forms NCBI accepts — a bare PMID
// and a `PMC`-prefixed id — and takes the first of a comma-separated list,
// which is already the observable behaviour: efetch returns every record but
// the XML parser only ever read the first.
function normalizePubmedId(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (/^pmc/i.test(s)) {
    const digits = s.replace(/[^0-9]/g, '');
    if (digits) return `PMC${digits}`;
  }
  const first = s.split(/[,\s]+/)[0] ?? '';
  const digits = first.replace(/[^0-9]/g, '');
  if (digits) return digits;
  throw new Error(
    `user_error: "${s}" is not a PubMed ID. Pass a numeric PMID like "34265844", ` +
    `or a PubMed Central id like "PMC8752811". To find the PMID for an article, ` +
    `search for it first with search_pubmed({query}).`,
  );
}

async function getAbstract(idRaw: string) {
  const id = normalizePubmedId(idRaw);
  const params = new URLSearchParams({
    db: 'pubmed',
    id,
    retmode: 'xml',
  });

  const res = await pubmedFetch(`${BASE}/efetch.fcgi?${params}`, 'fetch');

  const xml = await res.text();

  // Extract article title from XML for context
  const titleMatch = xml.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/);
  const title = titleMatch
    ? titleMatch[1].replace(/<[^>]+>/g, '').trim()
    : null;

  const abstract = parseAbstractFromXml(xml);

  if (!abstract) {
    throw new Error(`No abstract found for PubMed ID: ${id}`);
  }

  return {
    pmid: id,
    title,
    abstract,
    url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
  };
}

/**
 * Resolve a PMID to the PMC id OF THAT ARTICLE — and nothing else.
 *
 * `elink?dbfrom=pubmed&db=pmc` returns MORE THAN ONE linkset, and they mean
 * opposite things:
 *   pubmed_pmc      — this article, in PubMed Central. What we want.
 *   pubmed_pmc_refs — articles in PMC that CITE this one. Other people's papers.
 *
 * **Both carry `dbto: "pmc"`.** So matching on `dbto`, as this did, matches the
 * citing list just as happily as the article — and when the article is NOT in
 * open-access PMC, which is the common case, `pubmed_pmc` is absent and
 * `pubmed_pmc_refs` is the only linkset returned. The old code then took
 * `links[0]`: the first paper that happens to cite yours.
 *
 * MEASURED 2026-09-21 on the PMID from feedback #126. PMID 26213327 is
 * "Interstitial 5-ALA photodynamic therapy and glioblastoma: Preclinical model
 * development and preliminary results." NCBI returns exactly one linkset for
 * it, `pubmed_pmc_refs`, 19 links, the first being 13407687 — and this tool
 * returned PMC13407687, "5-ALA Photodynamic Therapy Induces Competing Death and
 * Survival Pathways in Glioblastoma Cells", with `has_full_text: true`.
 *
 * A different paper. Same field, adjacent topic, plausible title, served as a
 * clean 200 under the caller's own PMID. Nothing in the response said it was
 * someone else's article, and no health panel we own can see this class — it is
 * a success by every measure we log. That is the whole reason it is worth this
 * much comment: the failure was invisible and the answer was confident.
 *
 * So: match `linkname`, which is the field that actually distinguishes them,
 * and NEVER fall back to another linkset. No full text is a correct answer;
 * somebody else's full text is not.
 */
async function resolvePmcid(pmid: string): Promise<string | null> {
  const params = new URLSearchParams({ dbfrom: 'pubmed', db: 'pmc', id: pmid, retmode: 'json' });
  const res = await pubmedFetch(`${BASE}/elink.fcgi?${params}`, 'fetch');
  const raw = (await res.text()).replace(/[\u0000-\u001f]/g, ' ');
  try {
    const d = JSON.parse(raw) as {
      linksets?: Array<{ linksetdbs?: Array<{ dbto?: string; linkname?: string; links?: Array<string | number> }> }>;
    };
    const dbs = d.linksets?.[0]?.linksetdbs ?? [];
    const self = dbs.find((x) => x.linkname === 'pubmed_pmc');
    const link = self?.links?.[0];
    return link != null ? String(link) : null;
  } catch { return null; }
}

async function getFullText(idRaw: string) {
  const raw = String(idRaw ?? '').trim();
  if (!raw) throw new Error('Required argument "pmid" is missing (a PubMed ID like "34265844").');
  let pmid: string | null = null;
  let pmcid: string | null = null;
  if (/^pmc/i.test(raw)) { pmcid = raw.replace(/[^0-9]/g, ''); }
  else { pmid = raw.replace(/[^0-9]/g, ''); pmcid = await resolvePmcid(pmid); }
  if (!pmcid) {
    return { pmid, pmcid: null, has_full_text: false, message: 'No open-access full text in PubMed Central for this article. Use get_abstract for the abstract.', url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : null };
  }
  const params = new URLSearchParams({ db: 'pmc', id: pmcid, rettype: 'xml' });
  const res = await pubmedFetch(`${BASE}/efetch.fcgi?${params}`, 'fetch');
  const xml = await res.text();
  const titleMatch = xml.match(/<article-title[ >]([\s\S]*?)<\/article-title>/);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : null;
  const bodyMatch = xml.match(/<body[ >][\s\S]*?<\/body>/);
  const text = bodyMatch ? bodyMatch[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (!text) {
    return { pmid, pmcid: `PMC${pmcid}`, has_full_text: false, message: 'PMC record found but no extractable body text (may be PDF-only or restricted).' };
  }
  const CAP = 40000;
  const truncated = text.length > CAP;
  return { pmid, pmcid: `PMC${pmcid}`, has_full_text: true, title, char_count: text.length, truncated, full_text: truncated ? text.slice(0, CAP) : text, source: 'PubMed Central (open access)' };
}

// ── Dispatcher ────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  // Platform/BYO NCBI api_key (optional): 10 req/sec instead of 3, far fewer 429s.
  NCBI_KEY = typeof args._apiKey === 'string' && args._apiKey.trim() ? args._apiKey.trim() : undefined;
  delete args._apiKey;
  switch (name) {
    case 'search_pubmed':
      return searchPubmed(args.query as string, (args.limit as number) ?? 10);
    case 'get_summary':
      return getSummary(args.ids);
    case 'get_abstract':
      // `id ?? pmid`: four of this pack's six tools call the same value `pmid`,
      // and callers reasonably carry that spelling over. Every such call used
      // to interpolate `undefined` into the efetch URL and come back as
      // `PubMed fetch error: 400` — 14 in one hour on 2026-08-03. 3097a369
      // made that failure legible; it did not make the call work.
      return getAbstract((args.id ?? args.pmid) as string);
    // fleet #1329: pubmed_get_related_articles / pubmed_get_citations /
    // pubmed_get_full_text are the new model-facing (source-carrying) names;
    // the bare get_* names are permanent deprecated aliases to the same
    // handler, kept because they carry live traffic. Never diverge the two —
    // one function per pair, dispatched from both names.
    case 'get_related_articles':
    case 'pubmed_get_related_articles':
      return getRelatedArticles(args.pmid as string, (args.limit as number) ?? 10);
    case 'get_full_text':
    case 'pubmed_get_full_text':
      return getFullText(args.pmid as string);
    case 'get_citations':
    case 'pubmed_get_citations':
      return getCitations(args.pmid as string, (args.limit as number) ?? 10);
    case 'pubmed_evidence_landscape':
      return evidenceLandscape(args.query, args.from_year, args.to_year);
    case 'pubmed_publication_trend':
      return publicationTrend(args.query, args.from_year, args.to_year);
    case 'pubmed_integrity_check':
      return integrityCheck(args.pmid);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
