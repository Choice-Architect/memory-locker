# Plan: Enhance Fallback Query Logic and Remove Auto-Keywords

## 1. Goal

*   Eliminate the inefficient `auto_keywords` generation and storage.
*   Implement a tiered fallback query strategy within the Netlify function:
    1.  **Primary:** Vector Search (existing `search_memory_chunks` RPC).
    2.  **Fallback 1:** Metadata Search (filtering `files` table using query entities).
    3.  **Fallback 2:** Full-Text Search (searching `files.transcript_text` using query keywords/text, *only* if Fallback 1 yields no results).
*   Ensure results are consistently ordered by creation time (newest first) by default.
*   Leverage the strengths of each system component (GPT, Netlify, Supabase).

## 2. Phase 1: Cleanup - Remove Auto-Keywords

*   **Netlify Function (`memory-action.ts`):**
    *   **Remove Generation:** Delete the code block within the `store`/`combined` mode responsible for generating `fileMetadata.auto_keywords`.
    *   **Remove Fallback Usage:** Delete the logic within the fallback search (`query`/`combined` mode) that constructs or uses the `keywordMetadataFilter` based on `file_metadata->auto_keywords`. Modify the subsequent `OR` condition logic accordingly.
*   **Database (`files` table):**
    *   No immediate schema change is *required*. Existing rows will still have the `auto_keywords` array in their `file_metadata`.
    *   *Optional (Recommended Long-Term):* Consider running a one-time SQL script in Supabase to remove the `auto_keywords` key from the `file_metadata` JSONB in all existing rows. `UPDATE files SET file_metadata = file_metadata - 'auto_keywords';` (Test thoroughly!).
*   **Database (`transcript_embeddings` table):**
    *   No action needed. New embeddings won't have `auto_keywords` in their metadata once the generation step is removed.

## 3. Phase 2: Implement Tiered Fallback Logic in Netlify Function

*   **Orchestration:** The main `query`/`combined` block in the Netlify function will manage the sequence.
*   **Default Ordering:** All Supabase `SELECT` queries (Fallback 1 and Fallback 2) MUST include `.order('created_at', { ascending: false })`.
*   **Step 3.1: Vector Search (No Change):**
    *   Execute the `search_memory_chunks` RPC call as currently implemented.
    *   If results are found, proceed directly to Response Formulation (Step 3.4).
*   **Step 3.2: Fallback 1 - Metadata Search:**
    *   **Trigger:** Vector search returns 0 results or errors.
    *   **Netlify Logic:**
        *   Construct a `SELECT id, transcript_text, created_at, file_metadata FROM files` query.
        *   Initialize an array for Supabase filter conditions.
        *   **Date Filter:** If `queryDates` (normalized dates from the query) exist, apply the `created_at >= startDate AND created_at < endDate` filter.
        *   **Entity Filters:** If `queryMetadata.people`, `queryMetadata.locations`, or `queryMetadata.topics` arrays exist in the query payload, add filters using appropriate JSONB operators (e.g., `file_metadata->'people' @> '["Tony"]'::jsonb`) to check for containment within the corresponding arrays in the `file_metadata` column.
        *   Combine all applicable filters using `AND`.
        *   Apply the default ordering: `.order('created_at', { ascending: false })`.
        *   Apply limit: `.limit(FALLBACK_MATCH_COUNT)`.
    *   **Supabase Execution:** Netlify executes the constructed query against the `files` table.
    *   **Netlify Logic:** If results > 0 are returned, store them in `retrieved_context`, set `query_source = 'postgres_fallback_metadata'`, and proceed to Response Formulation (Step 3.4).
*   **Step 3.3: Fallback 2 - Full-Text Search:**
    *   **Trigger:** Fallback 1 (Metadata Search) returns 0 results.
    *   **Netlify Logic:**
        *   Construct a new `SELECT id, transcript_text, created_at, file_metadata FROM files` query.
        *   Initialize filter conditions.
        *   **Date Filter:** Re-apply the same `created_at` range filter used in Fallback 1, if applicable.
        *   **Text Filter:** Identify key terms from the original `payload.query_text` (e.g., using entities from `queryMetadata`, or basic keyword extraction). For each term, add an `ILIKE` filter: `transcript_text.ilike.%term%`. Combine all term filters using `AND`.
        *   Apply the default ordering: `.order('created_at', { ascending: false })`.
        *   Apply limit: `.limit(FALLBACK_MATCH_COUNT)`.
    *   **Supabase Execution:** Netlify executes the query against the `files` table.
    *   **Netlify Logic:** Store results (if any) in `retrieved_context`. Set `query_source` appropriately (`postgres_fallback_text` if results found, `none` if still nothing). Proceed to Response Formulation (Step 3.4).
*   **Step 3.4: Response Formulation:**
    *   **Netlify Logic:** Map the Supabase results (from whichever step succeeded) to the `ContextObject` format. Include the `file_metadata` from the results in the `entities_in_chunk` field of the `ContextObject`. Construct the final `SuccessResponse`.
    *   **GPT Role:** Receives the `SuccessResponse`. Uses `retrieved_context` and `entities_in_chunk` to synthesize the final answer.

## 4. Phase 3: Database Optimizations (Supabase)

*   To ensure performance:
    *   **Metadata Index:** Create a GIN index on `files.file_metadata`. `CREATE INDEX idx_gin_files_metadata ON files USING GIN (file_metadata);`
    *   **Timestamp Index:** Ensure B-tree index exists on `files.created_at`.
    *   **Text Search Index:** Create a GIN index using `pg_trgm` for `ILIKE` on `files.transcript_text`. `CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE INDEX idx_gin_trgm_files_transcript ON files USING GIN (transcript_text gin_trgm_ops);`

## 5. Component Responsibilities Summary

*   **GPT:** Initial query NLU, entity extraction (query), final response synthesis.
*   **Netlify:** Orchestration (Vector -> Metadata -> Text), query date normalization, Supabase query construction (fallbacks), response formatting.
*   **Supabase:** Data storage, vector search (RPC), indexed SQL execution (metadata/text fallbacks), ordering.

## 6. Testing

*   Test query scenarios triggering each fallback stage.
*   Verify correct ordering and filtering.
*   Monitor query performance. 