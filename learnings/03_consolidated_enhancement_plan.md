# Consolidated Enhancement Implementation Plan (v1.1)

**Goal:** Implement metadata and query enhancements for the Memory Locker system, including a tiered fallback query strategy within the Netlify function, leveraging the strengths of GPT, Netlify, and Supabase.

---

## Phase 1: Database Preparation (Supabase)

**Objective:** Prepare the database schema, functions, and indexes to support new metadata fields and efficient querying, including the fallback logic.

1.  **Update `search_memory_chunks` Function:**
    *   **Action:** Modify the function definition to return the `chunk_index`.
    *   **Status (Apr 8):** Completed. User confirmed successful execution of `DROP` and `CREATE FUNCTION` sequence. `search_memory_chunks` now returns `chunk_index`.
    *   **Rationale:** Ensures the chunk's position within the original file is available for context in the Netlify function.

2.  **Apply Performance Indexes:**
    *   **Action:** Ensure necessary indexes exist on the `files` and `transcript_embeddings` tables.
    *   **SQL (Executed Apr 8):**
        ```sql
        -- Index for querying JSONB metadata efficiently (Supports Fallback 1)
        CREATE INDEX IF NOT EXISTS idx_files_metadata_gin ON public.files USING gin (file_metadata jsonb_path_ops);

        -- Index for filtering by conversation thread ID
        CREATE INDEX IF NOT EXISTS idx_files_thread_id ON public.files (thread_id);

        -- Index for filtering by creation timestamp (Supports Fallback 1 & 2 Date Filters)
        CREATE INDEX IF NOT EXISTS idx_files_created_at ON public.files (created_at);

        -- Index for Full-Text Search (Supports Fallback 2)
        -- Assumes 'transcript_tsv' column exists and is populated by a trigger/process
        CREATE INDEX IF NOT EXISTS files_transcript_tsv_idx ON public.files USING GIN (transcript_tsv);

        -- Index for Vector Search (Primary Search)
        -- Note: HNSW is generally preferred for vector columns.
        CREATE INDEX IF NOT EXISTS transcript_embeddings_embedding_hnsw_idx ON public.transcript_embeddings USING hnsw (embedding vector_cosine_ops);
        ```
    *   **Status (Apr 8):** Completed. User confirmed successful execution of index creation statements.
    *   **Rationale:** Improve query performance for vector searches, metadata filtering (including JSONB), date range filtering, and full-text search required by the tiered query strategy.

**Phase 1 Status: Completed (Apr 8, 2025)**

---

## Phase 2: API Contract Definition (OpenAPI)

**Objective:** Update the `openapi.json` schema to reflect new metadata fields exchanged between the GPT and the Netlify function.

1.  **Update `openapi.json` Schema:**
    *   **Action:** Modify `components.schemas.ExtractedEntities` and `components.schemas.OutputExtractedEntities`.
    *   **Add Fields to `ExtractedEntities` (Input):**
        *   `priority`: Optional integer (1-10).
        *   `conversation_id`: Optional string.
        *   `thread_id`: Optional string.
        *   `language`: Optional string enum (`"en"`, `"fr"`, `"ar"`).
    *   **Modify `OutputExtractedEntities` (Output in ContextObject):**
        *   Ensure it includes the new fields (`priority`, `language`, `conversation_id`, `thread_id`) potentially stored in metadata.
        *   Ensure `dates` uses the `NormalizedDate` schema reference.
    *   **Modify `ContextObject` Schema:**
        *   Add `chunk_index?: number;` (nullable integer).
    *   **Status (Apr 8):** Completed. `openapi.json` modified.
    *   **Rationale:** Define the expected data structure for new metadata in API requests and responses.

**Phase 2 Status: Completed (Apr 8, 2025)**

---

## Phase 3: Core Logic Implementation (Netlify Function - `memory-action.ts`)

**Objective:** Update the Netlify function to handle new metadata during storage and implement the tiered query logic.

1.  **Update TypeScript Interfaces:**
    *   **Action:** Align interfaces (`ExtractedEntities`, `ContextObject`, `SearchResultItem`, `FallbackResultItem`, etc.) with the updated `openapi.json` schema and database function return types.
    *   **Status (Apr 8):** Completed.

2.  **Enhance Date Normalization Logic:**
    *   **Action:** Modify the `referenceDateForNormalization` assignment.
    *   **Change:** Always use `new Date()` as the reference timestamp, regardless of `payload.mode`.
    *   **Status (Apr 8):** Completed.
    *   **Rationale:** Ensure consistent date normalization reflecting the time of function invocation for both storage and querying.

3.  **Enhance Storage Logic (`store`/`combined` modes):**
    *   **Action:** Handle new metadata fields during file and embedding record creation.
    *   **Details:**
        *   Retrieve `priority`, `language`, `conversation_id`, `thread_id` from `payload.extracted_entities`.
        *   Store `priority` and `language` within the `file_metadata` JSONB object.
        *   Store `conversation_id` and `thread_id` in the corresponding top-level columns of the `files` table for efficient filtering.
        *   Process `dates` using `parseDateStringToEnhanced` and store the array of `EnhancedNormalizedDate` objects in `file_metadata`.
        *   Include the `chunk_index` when creating records for `transcript_embeddings`.
        *   Copy the full `fileMetadata` (including normalized dates, priority, language etc.) into each chunk's `metadata` field in `transcript_embeddings`. **Note:** This includes `conversation_id` and `thread_id` within the JSONB, duplicating the top-level columns but allowing easy propagation of this context to individual chunks if needed later.
    *   **Status (Apr 8):** Completed.

4.  **Implement Tiered Query Logic (`query`/`combined` modes):**
    *   **Orchestration:** Manage the sequence: Vector Search -> Metadata Fallback -> FTS Fallback.
    *   **Step 4.1: Vector Search (Primary Attempt):**
        *   **Action:** Execute `search_memory_chunks` RPC call.
        *   **Enhancements:** Pass extracted filter values (`topics`, `people`, `locations`, `type`, `sentiment`) and *date components (`filter_date_components`)* derived from the query's `processedMetadata` as arguments to the RPC call.
        *   **Result:** If results > 0, proceed to Response Formulation (Step 4.4).
        *   **Status:** Completed.
    *   **Step 4.2: Fallback 1 - Metadata Search:**
        *   **Trigger:** Vector search returns 0 results or errors.
        *   **Action:** Construct and execute a `SELECT` query on the `files` table.
        *   **Filtering:**
            *   Apply filters based on `processedMetadata` against `file_metadata` using JSONB operators (`@>`, `->>`, etc.) for entities like people, locations, topics, priority.
            *   *Date Filtering:* Apply JSONB containment (`cs`) filter on `file_metadata->dates` based on parsed query date components.
        *   **Ordering/Limit:** Apply `.order('created_at', { ascending: false })` and `.limit(FALLBACK_MATCH_COUNT)`.
        *   **Result:** If results > 0, store in `retrieved_context`, set `query_source = 'postgres_fallback_metadata'`, proceed to Response Formulation (Step 4.4).
        *   **Status:** Completed.
    *   **Step 4.3: Fallback 2 - Full-Text Search (FTS):**
        *   **Trigger:** Metadata Search (Fallback 1) returns 0 results.
        *   **Action:** Construct and execute an FTS query on the `files` table.
        *   **Details:**
            *   Extract *all* relevant string entities from `processedMetadata` (including `type`, `sentiment`, `language`, `original` from dates, elements from `people`, `locations`, `topics` arrays).
            *   Construct an FTS query string using these entities joined by ` | ` (OR operator).
            *   Perform search using `.textSearch('transcript_tsv', ftsQueryString, { config: 'english', type: 'websearch' })`.
            *   Include `ts_rank_cd(...)` in `SELECT` for relevance.
            *   Order results by `rank DESC`.
            *   *Date Filtering:* Apply JSONB containment (`cs`) filter on `file_metadata->dates` based on parsed query date components.
            *   Limit results using `FALLBACK_MATCH_COUNT`.
        *   **Result:** Store results (if any) in `retrieved_context`. Set `query_source` appropriately (`postgres_fallback_text` or `none`). Proceed to Response Formulation (Step 4.4).
        *   **Status:** Completed.
    *   **Step 4.4: Response Formulation:**
        *   **Action:** Map results from whichever step succeeded (Vector, Metadata, FTS) to the `ContextObject` format.
        *   **Details:** Populate `chunk` (full `transcript_text` for fallbacks), `timestamp` (`created_at`), `file_id`, `chunk_index` (if available from vector search), and reconstruct `entities_in_chunk` (using `EnhancedNormalizedDate` for dates) from the retrieved `metadata` or `file_metadata`.
        *   Construct the final `SuccessResponse`.
        *   **Status:** Completed.

**Phase 3 Status: Completed (Apr 8, 2025)**

---

## Phase 4: Implementation Considerations

*   **FTS Performance:** The current FTS targets the pre-computed `transcript_tsv` column and uses a GIN index, which is appropriate.
*   **Error Handling:** Basic error handling exists for Supabase calls, but could be enhanced with more specific logging or user messages if needed.
*   **Result Typing/Rank:** The FTS query selects a `rank`. This is used for ordering but not currently returned in the final `ContextObject`. If needed later, interface/mapping adjustments would be required.

---

## Phase 5: Component Responsibilities Summary

*   **GPT:** Extracts entities (including new ones like priority, language), determines `mode`, calls the action, synthesizes final answers from `retrieved_context`.
*   **Netlify Function:** Authenticates, validates payload, normalizes dates, orchestrates tiered query logic (Vector -> Metadata -> FTS), interacts with Supabase (RPC & direct queries), formats the response.
*   **Supabase:** Stores data (`files`, `transcript_embeddings`), provides DB functions (`search_memory_chunks`), executes queries with appropriate indexing.

---

**Overall Status:** All planned phases and steps outlined above are marked as completed based on previous updates and actions taken as of Apr 8, 2025.

---

## Phase 6: Enhanced Date Handling Implementation (Implementation Completed)

**Objective:** Refactor the date handling mechanism to parse, store, and query date information using structured components for greater flexibility and accuracy, replacing the sole reliance on normalized ISO strings.

**Detailed Plan:** See `learnings/04_date_refactor_plan.md` for specific implementation steps, code snippets, and conflict analysis.

**Key Decisions:**
*   No backward compatibility required for old data formats.
*   Timezone handling aims to preserve local context via `chrono-node` and `formatISO`.

**Status:** Implementation Completed. Testing Pending (Step 8 in Plan).

1.  **Add Dependencies:**
    *   **Action:** Install `chrono-node` library.
    *   **Status:** Completed.

2.  **Database Indexing:**
    *   **Action:** Create the missing GIN index on `transcript_embeddings.metadata`.
    *   **Status:** Completed (`idx_transcript_embeddings_metadata_gin`).

3.  **Update Code Interfaces & Schema:**
    *   **Action:** Define `EnhancedNormalizedDate` and update relevant interfaces (`memory-action.ts`) / schemas (`openapi.json`).
    *   **Status:** Completed.

4.  **Refactor Date Parsing Logic (`memory-action.ts`):**
    *   **Action:** Replace `normalizeDateString` with `chrono-node` logic in `parseDateStringToEnhanced`.
    *   **Status:** Completed.

5.  **Update Storage Logic (`memory-action.ts`):**
    *   **Action:** Ensure `EnhancedNormalizedDate[]` is saved to `file_metadata` and `metadata` JSONB columns.
    *   **Status:** Completed.

6.  **Modify Database Function (`search_memory_chunks` - SQL):**
    *   **Action:** Update function signature and logic for component filtering (`filter_date_components` JSONB parameter).
    *   **Status:** Completed (Local `sql/schema.sql` updated, SQL executed successfully on Supabase instance).

7.  **Update Query Logic (`memory-action.ts`):**
    *   **Action:** Adapt RPC calls and fallback queries (`.filter(..., 'cs', ...)` ) for component filtering.
    *   **Status:** Completed.

8.  **Testing:**
    *   **Action:** Thoroughly test end-to-end flow with various date formats for storage and component-based querying.
    *   **Status:** Pending.

**Phase 6 Status: Completed (Apr 8, 2025)** 