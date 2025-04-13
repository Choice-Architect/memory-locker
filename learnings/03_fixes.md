# Memory Locker: Fix Log & Current FTS Plan

## Background: v1.8 Architecture Shift ("Upstream Splitting")

*(Summary: Previous attempts to fix FTS query errors pre-v1.8 led to a fundamental architecture change. See `01_project_roadmap.md` & `02_enhancement_plan.md` for full history.)*

Based on challenges with query filtering and combined intent handling, the v1.8 architecture ("Upstream Splitting") was adopted:

1.  **GPT Handles Intent:** The Custom GPT was instructed to make separate `store` and `query` calls.
2.  **`combined` Mode Removed:** Simplified the OpenAPI schema and middleware logic.
3.  **Simplified Database Retrieval:** SQL functions (`search_memory_chunks`, `fts_search_files`) were simplified to perform only core search (vector similarity or text match), removing metadata filters.
4.  **Middleware Re-ranking for Augmentation:** `rerankResults` in the middleware became solely responsible for applying boosts based on metadata (using stemming) after combining Vector and FTS results via RRF.

**Rationale:** This approach leverages the GPT's strengths, simplifies middleware/DB logic, ensures broad initial retrieval, and centralizes relevance augmentation in the re-ranking step.

---

## Completed Fix: `organizations` Entity Integration (Post v1.8 Discovery)

**Issue:** The `organizations` entity was unintentionally omitted from the backend implementation despite being in GPT instructions.
**Fix:** Fully integrated `organizations` into schema, interfaces, storage mapping, and re-ranking (`rerankResults` using stemming and `ENTITY_WEIGHTS`).
**Status:** Implemented, documented, and verified working in initial tests (`testing/tests-results-4.csv`).

---

## Current Plan: FTS Relevance Logic Correction (Post v1.8.1)

**Issue:** Further analysis revealed a fundamental mismatch between the FTS implementation goal and its behavior. The use of `websearch_to_tsquery` (producing `&`-connected queries) combined with the strict `@@` match operator in the `WHERE` clause demands that *all* significant terms from the user query must be present in the document's `tsvector` for it to be considered a match. This "all-or-nothing" approach incorrectly discards documents with relevant partial matches, failing to identify documents based on *shared common terms* as intended.

**Goal:** Modify the FTS logic to return documents containing *any* of the significant query terms and rank them based on relevance (term frequency, proximity, number of matching terms), aligning with standard search expectations.

**Revised Plan:**

1.  **[ ] Modify `fts_search_files` SQL Function:**
    *   Remove the strict `WHERE f.transcript_tsv @@ websearch_to_tsquery(...)` clause.
    *   Add a rank-based filtering clause, e.g., `WHERE ts_rank(f.transcript_tsv, websearch_to_tsquery('english', query_string)) > 0.01`. This threshold ensures a baseline level of relevance and allows documents with partial term matches to be included.
    *   Retain `ORDER BY rank DESC` and `LIMIT match_count` to return the top-ranked results.
2.  **[ ] Apply Changes:** Update the function definition in `sql/schema.sql` locally and apply the `CREATE OR REPLACE FUNCTION` statement in the Supabase SQL Editor.
3.  **[ ] Re-Test:** Re-run previous FTS test cases (e.g., Q1) to verify that the function now returns relevant rows, including those with partial matches.
4.  **[ ] Integrate & Tune:** Once FTS returns ranked results correctly, proceed with broader testing and tuning of RRF/weights as previously planned.

**Rationale:** Shifting from strict `@@` matching to rank-based filtering allows the FTS component to function as intended – identifying potentially relevant documents based on shared keywords and letting the ranking mechanism determine the best matches. This fixes the core logical flaw where partially relevant documents were being incorrectly excluded. 