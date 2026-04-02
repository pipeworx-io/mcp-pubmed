# mcp-pubmed

MCP server for [PubMed](https://pubmed.ncbi.nlm.nih.gov/) biomedical literature search via NCBI E-utilities. Free, no auth required.

## Tools

| Tool | Description |
|------|-------------|
| `search_pubmed` | Search articles by keyword, author, or MeSH term |
| `get_summary` | Get metadata summaries for one or more PubMed IDs |
| `get_abstract` | Get the full abstract text for a single article |

## Quickstart (Pipeworx Gateway)

```bash
curl -X POST https://gateway.pipeworx.io/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "pubmed_search_pubmed",
      "arguments": { "query": "CRISPR cancer therapy" }
    },
    "id": 1
  }'
```

## License

MIT
