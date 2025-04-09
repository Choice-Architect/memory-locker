# Enhanced Date Handling Implementation Plan & Snippets (v1.0)

**Objective:** Refactor the date handling mechanism in `memory-action.ts` and `sql/schema.sql` to use `chrono-node` for parsing, store structured `EnhancedNormalizedDate` objects, and enable querying based on date components.

---

## Implementation Steps

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

*   **Action:** Updated the `search_memory_chunks` SQL function signature and filtering logic for date components.
*   **Status:** Completed (Local `sql/schema.sql` updated, SQL executed successfully on Supabase instance).
*   **Execution Detail:** Executed `DROP FUNCTION IF EXISTS...` for the old signature. Executed `CREATE OR REPLACE FUNCTION...` with the new signature including the `filter_date_components JSONB` parameter and the `EXISTS(...)` clause for component filtering in the `WHERE` condition.

### Step 7: Update Query Logic (`memory-action.ts`)

*   **Action:** Adapted function calls and fallback queries in `memory-action.ts` to use date components.
*   **Status:** Completed.
*   **Execution Detail:**
    1.  **RPC Call:** Modified the `supabase.rpc('search_memory_chunks', ...)` call to use named parameters matching the new SQL function, removing old date range parameters and adding `filter_date_components`.
    2.  **Fallback Filters (Metadata & FTS):** Removed existing `.gte()`/`.lt()` filters on `created_at`. Added the `.filter('file_metadata->dates', 'cs', JSON.stringify([finalDateComponentsFilter]))` condition (where applicable) to both Metadata and FTS fallback query builders.
    3.  **Result Mapping:** Verified mapping logic for vector and fallback results correctly accesses and types `dates` as `EnhancedNormalizedDate[]`.
*   **Attention Point (Fallback Filtering):** The `.filter('...', 'cs', ...)` method needs thorough testing to confirm its reliability for matching date components within the JSONB array. Alternatives (like a dedicated RPC or different JSONB operators) might be necessary if issues arise.

### Step 8: Testing

*   **Action:** Thoroughly test end-to-end flow with various date formats for storage and querying.
*   **Status:** Pending.
*   **Execution Detail (Planned):** ... (Keep existing testing details)

---

## Next: Analysis & Conflict Identification

Compare the proposed snippets and logic above against the actual current code (`memory-action.ts`, `openapi.json`, `sql/schema.sql`) to identify specific conflicts and areas needing careful merging/replacement, keeping in mind that only the new data format needs to be supported. 