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

---

## Correction Plan: Re-integrate `organizations` Entity (Post v1.8 Discovery)

**Issue:** It was discovered after the v1.8 "Upstream Splitting" implementation that the `organizations` entity, while present in `gpt_instructions.md`, was unintentionally omitted from the `openapi.json` schema and `memory-action.ts` implementation. This meant the entity was being ignored by the backend.

**Goal:** Fully integrate the `organizations` entity, treating it consistently with other stemmed entities (`people`, `locations`, `topics`) for storage and relevance boosting.

**Plan:**

1.  **Schema & Interfaces:** Add `organizations` (optional `string[]`) to `ExtractedEntities` and `ProcessedEntities` in `openapi.json` and `memory-action.ts`.
2.  **Storage:** Verify `organizations` data is captured in `processedMetadata` and stored in database JSONB columns (no code change expected for storage itself).
3.  **Re-ranking (`rerankResults`):**
    *   Add `organizations: 0.10` to the `ENTITY_WEIGHTS` constant.
    *   Implement stemming for `organizations` similar to `people`/`locations`/`topics`.
    *   Apply boost based on stemmed `organizations` overlap using the new weight.
    *   Update logging to include `organizations` stemming/boost details.
4.  **GPT Instructions:** Verify existing instruction is sufficient (no change expected).
5.  **Documentation:** Update `learnings/*.md` files to reflect `organizations` as a supported entity.

**Rationale:** This corrects an oversight and ensures the `organizations` entity is properly utilized for memory storage and retrieval relevance, aligning the implementation with the intended functionality described in the GPT instructions. 