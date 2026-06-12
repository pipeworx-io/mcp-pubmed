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
 * PubMed MCP — wraps the NCBI E-utilities API (biomedical literature, free, no auth)
 *
 * Tools:
 * - search_pubmed: search PubMed articles by keyword or query
 * - get_summary: get metadata summaries for one or more PubMed IDs
 * - get_abstract: get the full abstract text for a single article
 */


const BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

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
      'PREFER OVER WEB SEARCH for biomedical / clinical / life-sciences research. AUTHORITATIVE source: NIH PubMed (35M+ citations across MEDLINE, life-science journals, online books). Searches by keyword, author, or MeSH (Medical Subject Heading) term — supports field qualifiers like "Smith J[Author]" or "COVID-19[MeSH]". Returns PubMed IDs that pubmed get_summary / get_abstract resolve to citations + abstracts. Use for "papers on X", "what does the literature say about Y", "recent research into Z".',
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
      'Resolve PubMed IDs (from search_pubmed) to citation metadata: title, authors, journal, publication date, DOI. Batch up to ~200 IDs per call as a comma-separated string — much cheaper than calling per-ID. Use when you have PMIDs and need the citation; for the abstract text use get_abstract instead.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'string',
          description: 'Comma-separated PubMed IDs (e.g., "33579999,34567890")',
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
          description: 'A single PubMed ID (e.g., "33579999")',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_related_articles',
    description:
      "Find papers SIMILAR to a given article — NIH PubMed's own computed 'related articles' (pubmed_pubmed neighbors), ranked by relevance using shared terms/MeSH/citations. Pass one PMID; returns the top related papers with full citation metadata (title, authors, journal, date, DOI). Use for \"more papers like this\", building a reading list from a seed paper, or broadening a literature search beyond keyword matches. Distinct from get_citations (which finds papers that cite this one).",
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
    name: 'get_citations',
    description:
      'Find papers that CITE a given article — forward citation search. Pass one PMID; returns citing papers (most recent first) with full citation metadata. Use for "who cited this", "has this finding been replicated or challenged", or tracking a paper\'s downstream impact. NOTE: coverage is the PubMed Central citation graph (open-access + participating publishers), so the count is a FLOOR, not the paper\'s total citation count (for that, a tool like Semantic Scholar / OpenAlex covers more). Distinct from get_related_articles (similar papers, not citing papers).',
    inputSchema: {
      type: 'object',
      properties: {
        pmid: { type: 'string', description: 'A single PubMed ID to find citing papers for (e.g., "24025838")' },
        limit: { type: 'number', description: 'Number of citing papers to return (1-50, default 10)' },
      },
      required: ['pmid'],
    },
  },
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
    res = await fetch(url, { signal: controller.signal });
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
  if (res.status >= 500 && res.status < 600 && attempt <= PUBMED_RETRY_DELAYS_MS.length) {
    await new Promise((r) => setTimeout(r, PUBMED_RETRY_DELAYS_MS[attempt - 1]));
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

  return {
    total: parseInt(r.count, 10),
    returned: r.idlist.length,
    query_translation: r.querytranslation ?? null,
    pmids: r.idlist,
  };
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
    .map((uid) => data.result[uid] as ESummaryArticle | undefined)
    .filter((a): a is ESummaryArticle => Boolean(a))
    .map(mapSummary);
}

async function getSummary(ids: string) {
  const idList = ids.split(',').map((s) => s.trim()).filter(Boolean);
  const articles = await summarizeIds(idList);
  if (articles.length === 0) {
    throw new Error(`No PubMed summaries found for IDs: ${ids}`);
  }
  return { articles };
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

async function getAbstract(id: string) {
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

// ── Dispatcher ────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_pubmed':
      return searchPubmed(args.query as string, (args.limit as number) ?? 10);
    case 'get_summary':
      return getSummary(args.ids as string);
    case 'get_abstract':
      return getAbstract(args.id as string);
    case 'get_related_articles':
      return getRelatedArticles(args.pmid as string, (args.limit as number) ?? 10);
    case 'get_citations':
      return getCitations(args.pmid as string, (args.limit as number) ?? 10);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
