# Enhancement Investigations & Implementation Plan (v1.1)

**Goal:** Implement metadata and query enhancements for the Memory Locker system, including a tiered fallback query strategy within the Netlify function, leveraging the strengths of GPT, Netlify, and Supabase. This document consolidates the planning and implementation details for various enhancements.

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
        *   Ensure `dates` uses the `NormalizedDate` schema reference. [Note: This was updated later in Phase 6 to EnhancedNormalizedDate, the schema was updated accordingly]
    *   **Modify `ContextObject` Schema:**
        *   Add `chunk_index?: number;` (nullable integer).
    *   **Status (Apr 8):** Completed. `openapi.json` modified (further refinements in Phase 6).
    *   **Rationale:** Define the expected data structure for new metadata in API requests and responses.

**Phase 2 Status: Completed (Apr 8, 2025)**

---

## Phase 3: Core Logic Implementation (Netlify Function - `memory-action.ts`)

**Objective:** Update the Netlify function to handle new metadata during storage and implement the tiered query logic.

1.  **Update TypeScript Interfaces:**
    *   **Action:** Align interfaces (`ExtractedEntities`, `ContextObject`, `SearchResultItem`, `FallbackResultItem`, etc.) with the updated `openapi.json` schema and database function return types.
    *   **Status (Apr 8):** Completed (further refinements in Phase 6).

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
    *   **Status (Apr 8):** Completed (Date processing updated in Phase 6).

4.  **Implement Tiered Query Logic (`query`/`combined` modes):**
    *   **Orchestration:** Manage the sequence: Vector Search -> Metadata Fallback -> FTS Fallback.
    *   **Step 4.1: Vector Search (Primary Attempt):**
        *   **Action:** Execute `search_memory_chunks` RPC call.
        *   **Enhancements:** Pass extracted filter values (`topics`, `people`, `locations`, `type`, `sentiment`) as arguments to the RPC call. *Date components are NO LONGER passed for filtering.*
        *   **Result:** If results > 0, proceed to Response Formulation (Step 4.4).
        *   **Status:** Partially Complete (RPC call needs update to remove date filter arg). Date filtering implementation (Phase 6) is being reverted.
    *   **Step 4.2: Fallback 1 - Metadata Search:**
        *   **Trigger:** Vector search returns 0 results or errors.
        *   **Action:** Construct and execute a `SELECT` query on the `files` table.
        *   **Filtering:**
            *   Apply filters based on `processedMetadata` against `file_metadata` using JSONB operators (`@>`, `->>`, etc.) for entities like people, locations, topics, priority.
            *   *Date Filtering: Removed.* No component-based filtering is applied.
        *   **Ordering/Limit:** Apply `.order('created_at', { ascending: false })` and `.limit(FALLBACK_MATCH_COUNT)`.
        *   **Result:** If results > 0, store in `retrieved_context`, set `query_source = 'postgres_fallback_metadata'`, proceed to Response Formulation (Step 4.4).
        *   **Status:** Partially Complete (Query needs update to remove date filter). Date filtering implementation (Phase 6) is being reverted.
    *   **Step 4.3: Fallback 2 - Full-Text Search (FTS):**
        *   **Trigger:** Metadata Search (Fallback 1) returns 0 results.
        *   **Action:** Construct and execute an FTS query on the `files` table.
        *   **Details:**
            *   Extract *all* relevant string entities from `processedMetadata` (including `type`, `sentiment`, `language`, `original` from dates, elements from `people`, `locations`, `topics` arrays).
            *   Construct an FTS query string using these entities joined by ` | ` (OR operator).
            *   Perform search using `.textSearch('transcript_tsv', ftsQueryString, { config: 'english', type: 'websearch' })`.
            *   Include `ts_rank_cd(...)` in `SELECT` for relevance.
            *   Order results by `rank DESC`.
            *   *Date Filtering: Removed.* No component-based filtering is applied.
            *   Limit results using `FALLBACK_MATCH_COUNT`.
        *   **Result:** Store results (if any) in `retrieved_context`. Set `query_source` appropriately (`postgres_fallback_text` or `none`). Proceed to Response Formulation (Step 4.4).
        *   **Status:** Partially Complete (Query needs update to remove date filter). Date filtering implementation (Phase 6) is being reverted.
    *   **Step 4.4: Response Formulation:**
        *   **Action:** Map results from whichever step succeeded (Vector, Metadata, FTS) to the `ContextObject` format.
        *   **Details:** Populate `chunk` (full `transcript_text` for fallbacks), `timestamp` (`created_at`), `file_id`, `chunk_index` (if available from vector search), and reconstruct `entities_in_chunk` (using `EnhancedNormalizedDate` for dates) from the retrieved `metadata` or `file_metadata`.
        *   Construct the final `SuccessResponse`.
        *   **Status:** Completed (Date handling updated in Phase 6).

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

## Phase 6: Enhanced Date Handling Implementation

**Objective:** Refactor the date handling mechanism in `memory-action.ts` and `sql/schema.sql` to use `chrono-node` for parsing, store structured `EnhancedNormalizedDate` objects, and enable querying based on date components.

**Key Decisions:**
*   No backward compatibility required for old data formats.
*   Timezone handling aims to preserve local context via `chrono-node` and `formatISO`.

**Implementation Steps:**

### Step 1: Add Dependencies (Already Completed)

*   **Action:** `chrono-node` was previously installed.
*   **Status:** Completed.

### Step 2: Database Indexing (Already Completed)

*   **Action:** GIN index on `transcript_embeddings.metadata` was confirmed present in `sql/schema.sql`.
*   **Status:** Completed (`idx_transcript_embeddings_metadata_gin`).

### Step 3: Update Code Interfaces & Schema (`memory-action.ts`, `openapi.json`)

*   **Action:** Defined `EnhancedNormalizedDate` and updated related interfaces (`ProcessedEntities`, `ContextObject`, `SearchResultItem`, `FallbackResultItem` in `.ts`) and schemas (`EnhancedNormalizedDate`, `OutputProcessedEntities` in `openapi.json`). Removed outdated `NormalizedDate` and `OutputExtractedEntities` schemas from `openapi.json`.
*   **Status:** Completed.
*   **Execution Detail:** Verified `EnhancedNormalizedDate` interface/schema structure. Updated `OutputProcessedEntities` schema to reference `EnhancedNormalizedDate`. Confirmed `ContextObject` references `OutputProcessedEntities`. Verified input `ExtractedEntities` schema uses `string[]` for dates.

### Step 4: Refactor Date Parsing Logic (`memory-action.ts`)

*   **Action:** Replaced the `normalizeDateString` function with `parseDateStringToEnhanced` using `chrono-node`. Updated the main handler to call the new function.
*   **Status:** Completed.
*   **Execution Detail:** Added `chrono-node` import. Removed old `normalizeDateString` function. Added `parseDateStringToEnhanced` function. Updated `.map()` call within the handler to use the new function for date processing.

### Step 5: Update Storage Logic (`memory-action.ts`)

*   **Action:** Ensured the array of `EnhancedNormalizedDate` objects is correctly saved to `file_metadata` (in `files` table) and `metadata` (in `transcript_embeddings` table) JSONB columns.
*   **Status:** Completed.
*   **Execution Detail:** Verified that `processedMetadata.dates` (containing `EnhancedNormalizedDate[]`) is assigned to `fileMetadata.dates`. Confirmed `fileMetadata` is used when inserting into the `files` table. Confirmed `fileMetadata` is spread into `chunkMetadata` when preparing `transcript_embeddings` records.

### Step 6: Modify Database Function (`search_memory_chunks` - SQL)

*   **Action:** Updated the `search_memory_chunks` SQL function signature to accept `filter_date_components` BUT removed the date component filtering logic from its `WHERE` clause.
*   **Status:** Completed (Local `sql/schema.sql` updated, SQL executed successfully on Supabase instance).
*   **Execution Detail:** Executed `DROP FUNCTION IF EXISTS...` for the old signature. Executed `CREATE OR REPLACE FUNCTION...` with the `filter_date_components JSONB` parameter present but *commented out or removed the `EXISTS(...)` clause for component filtering in the `WHERE` condition*.

### Step 7: Update Query Logic (`memory-action.ts`)

*   **Action:** Adapted function calls and fallback queries in `memory-action.ts` to *remove* the use of date components for filtering.
*   **Status:** Pending Code Change.
*   **Execution Detail (Required Changes):**
    1.  **RPC Call:** Modify the `supabase.rpc('search_memory_chunks', ...)` call to *remove* the `filter_date_components` argument.
    2.  **Fallback Filters (Metadata & FTS):** Remove the `.filter('file_metadata->dates', 'cs', ...)` condition from both Metadata and FTS fallback query builders.
    3.  **Result Mapping:** No change needed here, logic already handles `EnhancedNormalizedDate[]`.
*   **Attention Point (Fallback Filtering):** N/A as date filter is removed.

### Step 8: Testing

*   **Action:** Thoroughly test end-to-end flow ensuring date components are NOT filtering results during query.
*   **Status:** Pending (Requires code changes from Step 7 first).
*   **Execution Detail (Planned):** Focus on verifying that queries with specific date components *do not* exclude results lacking those components. Confirm fallbacks trigger correctly based on semantic/metadata results, independent of dates. Test storage and retrieval of `EnhancedNormalizedDate` objects are still correct.

**Phase 6 Status: Partially Reverted (SQL function updated, Netlify function pending update), Testing Pending**

---

## Overall Status

Enhancement implementation is partially complete. The Date Handling refactor (Phase 6) has been partially reverted: the database function no longer filters by date components, but the corresponding changes in the Netlify function (`memory-action.ts`) to remove the date filtering logic are **pending**. 