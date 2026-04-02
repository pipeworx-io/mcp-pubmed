/**
 * PubMed MCP — wraps the NCBI E-utilities API (biomedical literature, free, no auth)
 *
 * Tools:
 * - search_pubmed: search PubMed articles by keyword or query
 * - get_summary: get metadata summaries for one or more PubMed IDs
 * - get_abstract: get the full abstract text for a single article
 */

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
}

const BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

// -- API Response Types --

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

// -- Helpers --

/**
 * Extract abstract text from PubMed XML (efetch response).
 * PubMed returns AbstractText elements which may be plain or have Label attributes.
 */
function parseAbstractFromXml(xml: string): string | null {
  const abstractMatches = xml.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g);
  if (!abstractMatches || abstractMatches.length === 0) return null;

  return abstractMatches
    .map((block) => {
      const labelMatch = block.match(/Label="([^"]+)"/);
      const label = labelMatch ? `${labelMatch[1]}: ` : '';
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

// -- Tool Definitions --

const tools: McpToolExport['tools'] = [
  {
    name: 'search_pubmed',
    description:
      'Search the PubMed biomedical literature database by keyword, author, or MeSH term. Returns a list of PubMed IDs that can be used with get_summary or get_abstract.',
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
      'Get metadata summaries for one or more PubMed articles by their PubMed IDs. Returns title, authors, journal, publication date, and DOI.',
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
      'Get the full abstract text for a single PubMed article by its PubMed ID. Returns structured abstract with section labels when available.',
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
];

// -- Tool Implementations --

async function searchPubmed(query: string, limit: number) {
  const retmax = Math.min(100, Math.max(1, limit));
  const params = new URLSearchParams({
    db: 'pubmed',
    term: query,
    retmode: 'json',
    retmax: String(retmax),
  });

  const res = await fetch(`${BASE}/esearch.fcgi?${params}`);
  if (!res.ok) throw new Error(`PubMed search error: ${res.status}`);

  const data = (await res.json()) as ESearchResult;
  const r = data.esearchresult;

  return {
    total: parseInt(r.count, 10),
    returned: r.idlist.length,
    query_translation: r.querytranslation ?? null,
    pmids: r.idlist,
  };
}

async function getSummary(ids: string) {
  const params = new URLSearchParams({
    db: 'pubmed',
    id: ids,
    retmode: 'json',
  });

  const res = await fetch(`${BASE}/esummary.fcgi?${params}`);
  if (!res.ok) throw new Error(`PubMed summary error: ${res.status}`);

  const data = (await res.json()) as ESummaryResult;
  const uids = data.result.uids ?? [];

  if (uids.length === 0) {
    throw new Error(`No PubMed summaries found for IDs: ${ids}`);
  }

  return {
    articles: uids.map((uid) => {
      const article = data.result[uid] as ESummaryArticle;
      return mapSummary(article);
    }),
  };
}

async function getAbstract(id: string) {
  const params = new URLSearchParams({
    db: 'pubmed',
    id,
    retmode: 'xml',
  });

  const res = await fetch(`${BASE}/efetch.fcgi?${params}`);
  if (!res.ok) throw new Error(`PubMed fetch error: ${res.status}`);

  const xml = await res.text();

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

// -- Dispatcher --

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_pubmed':
      return searchPubmed(args.query as string, (args.limit as number) ?? 10);
    case 'get_summary':
      return getSummary(args.ids as string);
    case 'get_abstract':
      return getAbstract(args.id as string);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool } satisfies McpToolExport;
