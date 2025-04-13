# Memory Locker: Historical Fix Log & v1.8 Architecture Shift

## Background Summary (Pre-v1.8 "Upstream Splitting")

Initial attempts to fix query retrieval issues after v1.8.0 focused on resolving SQL errors in the Full-Text Search (FTS) implementation. Syntax errors (`PGRST100`) and PostgreSQL logical errors (`42809 WITHIN GROUP`) were addressed by refactoring the FTS query to use a dedicated RPC function (`fts_search_files`).

However, subsequent testing (`test-3-results.csv`) revealed that while the RPC executed without error, it consistently returned zero results. Concurrently, vector search performance remained unreliable, and specific issues were identified:

*   **Overly Strict Filtering:** Metadata fields used as filters in the initial SQL queries prevented relevant results from being returned due to slight mismatches.
*   **Combined Mode Pollution:** The `combined` mode query logic was incorrectly using entities from the entire input, contaminating the search filters.

Further analysis led to a fundamental shift in strategy: instead of using metadata for strict initial filtering, the database retrieval (Vector & FTS) should be broad, based only on core similarity/text match. Metadata should be used *exclusively* within the middleware's re-ranking step to augment relevance, using techniques like stemming.

Additionally, the handling of combined user intents (store + query) was identified as a source of complexity and potential error in the middleware. The ideal solution is to delegate this intent splitting to the upstream Custom GPT.

---

## v1.8 Architectural Decision: "Upstream Splitting" (April 13, 2025)

Based on the challenges identified above (primarily ineffective FTS and problematic combined mode/metadata filtering), a new architecture was adopted:

1.  **GPT Handles Intent:** The Custom GPT was instructed to identify combined `store` and `query` intents in user messages and make separate, sequential calls to the action (`store` first, then `query`).
2.  **`combined` Mode Removed:** The `combined` mode was completely removed from the OpenAPI schema and the Netlify function's logic, simplifying the middleware significantly.
3.  **Simplified Database Retrieval:** Both the vector search (`search_memory_chunks`) and FTS (`fts_search_files`) SQL functions were simplified to perform *only* their core search operation (vector similarity or text match against the full query text). All metadata filtering parameters and logic were removed from these database functions.
4.  **Middleware Re-ranking for Augmentation:** The responsibility for leveraging metadata shifted entirely to the `rerankResults` function within the Netlify middleware. This function now:
    *   Receives broadly retrieved results from concurrent Vector and FTS searches.
    *   Combines these results using Reciprocal Rank Fusion (RRF).
    *   Applies boosts based on metadata overlap (people, locations, topics using **stemming**), date component matching, and other factors, using the defined `ENTITY_WEIGHTS`.
5.  **Enhanced Logging:** Detailed logging was added throughout the query process in the middleware to facilitate future debugging and performance tuning.

**Rationale:** This "Upstream Splitting" approach leverages the GPT's strengths for intent parsing, drastically simplifies the middleware and database logic, ensures a broad initial retrieval of potentially relevant candidates, and centralizes the sophisticated relevance augmentation logic within the re-ranking step.

**(Note:** Add relevant commit hash(es) here when available: __________) 