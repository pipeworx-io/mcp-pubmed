# PubMed — Biomedical Literature

The U.S. National Library of Medicine's PubMed. ~37 million biomedical and life-science citations going back to 1781. The canonical biomedical literature database — used by every clinician, researcher, and grant officer. MeSH (Medical Subject Headings) tagging makes structured search powerful. Free, no auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Why this matters for AI agents

For biomedical research, drug efficacy questions, clinical guidelines, or systematic literature review, PubMed is the canonical first stop. Where [Semantic Scholar](/docs/reference/semantic-scholar) is broader but less curated, PubMed is biomedical-focused with MeSH structure that supports precise queries.

Common flows:

- **Topic search.** "Recent papers on GLP-1 agonists for cardiovascular outcomes" → search with MeSH terms or keywords.
- **Specific paper.** PMID lookup → full record (title, abstract, authors, MeSH tags).
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

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

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
