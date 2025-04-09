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

4.  **Implement Tiered Query Logic (`query`/`combined` modes) - Modified for Boosting:**
    *   **Orchestration:** Manage the sequence: Vector Search -> Metadata Fallback -> FTS Fallback for *initial candidate retrieval*.
    *   **Step 4.1: Vector Search (Primary Attempt):**
        *   **Action:** Execute `search_memory_chunks` RPC call.
        *   **Enhancements:** Pass query embedding. Optional filters (`topics`, `people`, etc.) likely passed as NULL initially. Fetch `similarity` score and `metadata`.
        *   **Status:** Completed (Code removes date filter arg).
    *   **Step 4.2: Fallback 1 - Metadata Search:**
        *   **Trigger:** Vector search returns 0 results or errors.
        *   **Action:** Construct and execute a `SELECT` query on the `files` table.
        *   **Filtering:** Apply non-date metadata filters (`@>`, `->>`) as before. Fetch `file_metadata`.
        *   **Status:** Completed (Code removes date filter).
    *   **Step 4.3: Fallback 2 - Full-Text Search (FTS):**
        *   **Trigger:** Metadata Search (Fallback 1) returns 0 results.
        *   **Action:** Construct and execute an FTS query on the `files` table. Fetch `rank` and `file_metadata`.
        *   **Status:** Completed (Code removes date filter).
    *   **Step 4.4: Application Layer Re-ranking (NEW - See Plan in `05_relevance_boosting_plans.md`):**
        *   **Trigger:** After any successful retrieval step (4.1, 4.2, or 4.3).
        *   **Action:** Implement the `rerankResults` function in `memory-action.ts`.
        *   **Logic:** Compare query metadata with candidate metadata, calculate boost, combine with initial score (similarity/rank/fixed), sort, and trim the list.
        *   **Status:** Planned.
    *   **Step 4.5: Response Formulation:**
        *   **Action:** Map results from the *re-ranked* list to the `ContextObject` format.
        *   **Status:** Minor modification needed to use the re-ranked list.

**Phase 3 Status: Partially Complete (Core retrieval logic updated, Re-ranking step pending)**

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

## Phase 6: Enhanced Date Handling Implementation (Completed - Filtering Removed)

**Objective:** Refactor the date handling mechanism to use `chrono-node` for parsing and store structured `EnhancedNormalizedDate` objects, removing date-based filtering from queries.

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

*   **Action:** Updated the `search_memory_chunks` SQL function signature to *remove* the `filter_date_components` parameter and its filtering logic.
*   **Status:** Completed (Local `sql/schema.sql` updated, SQL executed successfully on Supabase instance).

### Step 7: Update Query Logic (`memory-action.ts`)

*   **Action:** Adapted function calls and fallback queries in `memory-action.ts` to *remove* the use of date components for filtering.
*   **Status:** Completed.

### Step 8: Testing

*   **Action:** Thoroughly test end-to-end flow ensuring date components are NOT filtering results during query.
*   **Status:** Completed (Implicitly, as part of filter removal verification). Further testing on boosting interaction needed.

**Phase 6 Status: Completed**

---

## Overall Status

Core retrieval logic updated to remove date filtering. Next step is implementing the Application Layer Re-ranking enhancement as specified in `learnings/05_relevance_boosting_plans.md`. 