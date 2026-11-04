---
"cannoli-plugin": patch
"@deablabs/cannoli-core": patch
---

Runs now apply the "LLM call concurrency limit (pLimit)" setting (default 50). Before, the plugin never passed it to runs, so up to 1000 model calls could run at once; large parallel canvases may now run slower. Streaming calls count against the limit too.
