# PubMed — Biomedical Literature

The U.S. National Library of Medicine's PubMed. ~37 million biomedical and life-science citations going back to 1781. The canonical biomedical literature database — used by every clinician, researcher, and grant officer. MeSH (Medical Subject Headings) tagging makes structured search powerful. Free, no auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Why this matters for AI agents

For biomedical research, drug efficacy questions, clinical guidelines, or systematic literature review, PubMed is the canonical first stop. Where [Semantic Scholar](/docs/reference/semantic-scholar) is broader but less curated, PubMed is biomedical-focused with MeSH structure that supports precise queries.

Common flows:

- **Topic search.** "Recent papers on GLP-1 agonists for cardiovascular outcomes" → search with MeSH terms or keywords.
- **Specific paper.** PMID lookup → full record (title, abstract, authors, MeSH tags).
- **Author affiliation / contact.** `get_summary`'s `authors[]` stays plain name strings (unchanged); a separate `author_details[]` array, index-aligned with `authors[]`, adds `{name, affiliations[], emails[]}` — `affiliations` is the `<AffiliationInfo><Affiliation>` text verbatim from the efetch XML record, and `emails` is whatever email address(es) a plain regex finds inside that text (empty array when the record carries none — no guessing or enrichment beyond what NCBI indexed). `search_pubmed` still returns bare author name strings only, with no `author_details`; call `get_summary` on its PMIDs for affiliation/contact detail.
- **"Last N years" needs `from_year`/`to_year`, and a precise term needs quotes (fleet #2418).** `search_pubmed` had no date control at all — a "papers from the last two years on X" question could only be answered by relevance ranking, not filtered. Pass `from_year`/`to_year` (four-digit years; same `[pdat]` mechanism `pubmed_evidence_landscape`/`pubmed_publication_trend` already use) to bound it. Separately, an unquoted multi-word technical term (a gene, assay, or biomarker name) is subject to PubMed's automatic term mapping, which can silently broaden it into unrelated MeSH/supplementary-concept synonyms — `cell-free RNA` unquoted pulled in ctDNA papers via "cell free nucleic acids". Wrap a precise term in double quotes (optionally with a `[tiab]` tag, e.g. `"cell-free RNA"[tiab]`) to search for the exact phrase instead. Verified live: `("cell-free RNA"[tiab]) AND 2024:2026[pdat]` returns 182 on-topic results with `query_translation` showing no synonym expansion, versus the unquoted term pulling in ctDNA/"cell free nucleic acids" matches.
- **Author profile.** Papers by a specific author (with disambiguation challenges).
- **Citation tracking.** Cross-reference with [Crossref](/docs/reference/crossref) for DOIs and citation networks.
- **Evidence landscape.** Count clinical trials, randomized trials, systematic reviews, meta-analyses, observational studies, and case reports for one query with `pubmed_evidence_landscape`.
- **Publication momentum.** Use `pubmed_publication_trend` for exact annual PubMed counts across a bounded window.
- **Integrity check.** Use `pubmed_integrity_check` before relying on one PMID to surface NLM-indexed retractions, expressions of concern, errata, updates, and related notices.

## Auth

None. NCBI E-utilities (PubMed's API) is free. Without an API key, calls are throttled to 3/sec; with a free NCBI API key (https://www.ncbi.nlm.nih.gov/account/), 10/sec. Pass via `_apiKey`.

## MeSH terms

PubMed's secret weapon is MeSH (Medical Subject Headings) — a controlled vocabulary applied to every paper by NLM librarians. Allows precise queries:

- `[mh]` exact MeSH heading
- `[majr]` major heading (the paper is *about* this)
- `[ti]` title
- `[au]` author

Example: `glucagon-like peptide-1[mh] AND cardiovascular diseases[majr] AND 2023:2024[dp]` finds papers majoring on cardiovascular outcomes for GLP-1 agonists in 2023-2024.

## Common pitfalls

- **MeSH lag.** Papers get MeSH-indexed weeks to months after publication. Recent papers may not have MeSH yet — fall back to keyword searches for the most current literature.
- **Author disambiguation.** "J Smith" matches thousands of papers. ORCID solves this for newer papers; older literature has irreducible disambiguation. PubMed's "[full author]" search helps.
- **Pre-print vs publication.** PubMed indexes peer-reviewed publications only (mostly). Pre-prints from bioRxiv / medRxiv are NOT in PubMed until the paper is formally published. For cutting-edge work, layer Semantic Scholar.
- **Predatory journals.** Some open-access predatory journals slipped into PubMed before NLM tightened standards. Inclusion in PubMed isn't a quality signal — check journal reputation.
- **Open-access status.** "Free PMC article" links to the full text on PubMed Central. Many papers have abstracts only — note this when promising "the paper says..."
- **Trial registration cross-reference.** Clinical trials are registered separately on [ClinicalTrials.gov](/docs/reference/clinicaltrials). The same study can have multiple PubMed entries (protocol, primary results, secondary analyses). NCT IDs in the abstract help link.
- **Counts are routing signals.** Publication types overlap, the current year may be incomplete, and publication volume does not establish evidence quality, efficacy, independence, or commercial validation.
- **Integrity flags are bounded.** `pubmed_integrity_check` reports relationships indexed by NLM. A citation without a flag has not thereby been independently validated.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "pubmed": {
      "url": "https://gateway.pipeworx.io/pubmed/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/pubmed/mcp` returns the tools in the table
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

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/search_pubmed \
  -H 'Content-Type: application/json' \
  -d '{"query":"\"cell-free RNA\"[tiab]","from_year":2024,"to_year":2026}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/search_pubmed`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-pubmed` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/pubmed/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "pubmed": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-pubmed"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Pubmed data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
