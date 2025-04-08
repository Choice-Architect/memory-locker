# Plan: Enhance Fallback Query Logic

## 1. Goal

*   Implement a tiered fallback query strategy within the Netlify function:
    1.  **Primary:** Vector Search (existing `search_memory_chunks` RPC).
    2.  **Fallback 1:** Metadata Search (filtering `files` table using query entities).
    3.  **Fallback 2:** Full-Text Search (searching `files.transcript_text` using query keywords/text, *only* if Fallback 1 yields no results).
*   Ensure results are consistently ordered by creation time (newest first) by default.
*   Leverage the strengths of each system component (GPT, Netlify, Supabase).

## 2. Implement Tiered Fallback Logic in Netlify Function

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
        *   **Filter Application:**
            *   **Date Filter:** If `queryDates` (NormalizedDate objects from the query) exist, calculate `startDateISO` and `endDateISO` from the `normalized` fields. Filter the `files` table using `created_at >= startDateISO AND created_at < endDateISO` (adjusted for end of day).
            *   **Metadata Entity Filters:** Apply JSONB operators (`@>`, `->>`, etc.) to filter based on `queryMetadata` (people, locations, topics, priority, etc.) against the `file_metadata` column.
        *   Combine all applicable filters using `AND`.
        *   Apply the default ordering: `.order('created_at', { ascending: false })`.
        *   Apply limit: `.limit(FALLBACK_MATCH_COUNT)`.
    *   **Supabase Execution:** Netlify executes the constructed query against the `files` table.
    *   **Netlify Logic:** If results > 0 are returned, store them in `retrieved_context`, set `query_source = 'postgres_fallback_metadata'`, and proceed to Response Formulation (Step 3.4).
*   **Step 3.3: Fallback 2 - Full-Text Search:**
    *   **Trigger:** Fallback 1 (Metadata Search) returns 0 results.
    *   **Netlify Logic:**
        *   **Text Search (If Metadata Search returns 0 results):**
            *   Extract all string-based entities from `payload.extracted_entities`.
            *   Construct a Full-Text Search query (`tsquery`) using these entities.
            *   Query `files` table using `to_tsvector('english', transcript_text) @@ to_tsquery('english', '<entity1> & <entity2> | <entity3> ...')`.
            *   Use `ts_rank` or `ts_rank_cd` in the `SELECT` clause to calculate relevance.
            *   Order results by relevance (`ts_rank DESC`).
            *   Limit results using `FALLBACK_MATCH_COUNT`.
            *   Set `query_source = 'postgres_fallback_text'`.
    *   **Supabase Execution:** Netlify executes the query against the `files` table.
    *   **Netlify Logic:** Store results (if any) in `retrieved_context`. Set `query_source` appropriately (`postgres_fallback_text` if results found, `none` if still nothing). Proceed to Response Formulation.
*   **Response Formulation:**
    *   **Netlify Logic:** Map the Supabase results (from whichever step succeeded) to the `ContextObject` format. Include the `file_metadata` from the results in the `entities_in_chunk` field of the `ContextObject`. Construct the final `SuccessResponse`.
    *   **GPT Role:** Receives the `SuccessResponse`. Uses `retrieved_context` and `entities_in_chunk` to synthesize the final answer.

## 3. Database Considerations (Supabase)

*   To ensure performance:
    *   **Metadata Index:** Ensure the GIN index on `files.file_metadata` exists (using `jsonb_path_ops`).
    *   **Timestamp Index:** Ensure B-tree index exists on `files.created_at`.
    *   **Text Search Index (FTS):** For the planned FTS approach, creating a GIN index on a dedicated `tsvector` column for `files.transcript_text` is highly recommended for performance.

## 4. Component Responsibilities Summary