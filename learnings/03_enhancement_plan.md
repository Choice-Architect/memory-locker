# Enhancement Implementation Plan (v1)

**Goal:** Implement the suggested enhancements for metadata, the Netlify function, and Supabase database interactions as outlined in related learning documents (`05`, `06`, `07`).

---

## Phase 1: Database Preparation (Supabase)

**Objective:** Prepare the database schema and functions for the new metadata and query logic.

1.  **Verify `search_memory_chunks` Function Signature:**
    *   **Action:** Manually inspect the function definition in the Supabase SQL Editor (`Database` -> `Functions` -> `search_memory_chunks`).
    *   **Check:** Confirm the `RETURNS TABLE(...)` clause includes `chunk_index integer`.
    *   **Check:** Confirm the main `SELECT` statement within the function includes `te.chunk_index`.
    *   **Rationale:** Ensures the `chunk_index` (which already exists in the `transcript_embeddings` table per `schema.sql`) is actually returned by the search function for use in the Netlify function.
    *   **Reference:** `learnings/07_supabase_db_suggestions.md`, `sql/schema.sql`.

**Implementation Notes (Apr 8, 2025 - Phase 1):**
*   **Step 1 (Verify Function):** Pending manual verification by user in Supabase SQL Editor.
**Update (Apr 8):** User confirmed function definition retrieved. Function **does not** return `chunk_index`. SQL provided to user to `CREATE OR REPLACE` the function with the necessary modification. Status pending user confirmation of update.
**Update 2 (Apr 8):** `CREATE OR REPLACE` failed due to return type change (Error 42P13). Provided necessary `DROP FUNCTION` followed by `CREATE FUNCTION` sequence to user. Status pending user confirmation of update.
**Update 3 (Apr 8):** User confirmed successful execution of `DROP` and `CREATE`. Function `search_memory_chunks` is now updated.
*   **Step 2 (Apply Indexes):** SQL provided to user for execution. Status pending user confirmation.
    *   **Update (Apr 8):** User confirmed successful execution (no rows returned), indexes are now applied.
    *   **Rationale:** Improve query performance for metadata and date range filtering.

**Phase 1 Status: Completed (Apr 8, 2025)**

2.  **Apply Indexes to `files` Table:**
    *   **Action:** Execute the following SQL commands in the Supabase SQL Editor.
    *   **SQL:**
        ```sql
        -- Index for querying JSONB metadata efficiently (Priority, Keywords, Due Date, Language)
        CREATE INDEX IF NOT EXISTS idx_files_metadata_gin ON public.files USING gin (file_metadata jsonb_path_ops);

        -- Index for filtering by conversation thread ID
        CREATE INDEX IF NOT EXISTS idx_files_thread_id ON public.files (thread_id);

        -- Index for filtering by creation timestamp (Fallback date queries)
        CREATE INDEX IF NOT EXISTS idx_files_created_at ON public.files (created_at);
        ```
    *   **Rationale:** Improve query performance for filtering based on the new metadata fields and creation time, as suggested in `07_supabase_db_suggestions.md`.
    *   **Reference:** `learnings/07_supabase_db_suggestions.md`, `sql/schema.sql`.

---

## Phase 2: API Contract Definition (OpenAPI)

**Objective:** Update the API schema to reflect the new data points exchanged between the GPT and the Netlify function.

1.  **Update OpenAPI Schema (`openapi.json`):**
    *   **Action:** Modify the `components.schemas.ExtractedEntities` definition.
    *   **Add Fields:**
        *   `priority`: Optional integer (1-10) for user-assigned priority.
        *   `conversation_id`: Optional string for conversation linking.
        *   `thread_id`: Optional string for thread linking.
        *   `language`: Optional string enum (`"en"`, `"fr"`, `"ar"`) for detected input language.
    *   **Example Snippet (to be inserted within `ExtractedEntities.properties`):**
        ```json
        "priority": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10,
          "description": "User-assigned priority level (1-10, 10 = highest)",
          "nullable": true
        },
        "conversation_id": {
          "type": "string",
          "description": "Identifier for the ongoing conversation session (if available)",
          "nullable": true
        },
        "thread_id": {
           "type": "string",
           "description": "Identifier for a specific topic thread within a conversation (if available and distinct)",
           "nullable": true
        },
        "language": {
          "type": "string",
          "enum": ["en", "fr", "ar"],
          "description": "Detected language of the query_text (ISO 639-1 code, default 'en')",
          "nullable": true
        }
        ```
    *   **Rationale:** Define the expected structure for the new metadata fields in the API request payload.
    *   **Reference:** `learnings/05_metadata_enhance_suggestions.md`, `openapi.json`.

**Implementation Notes (Apr 8, 2025 - Phase 2):**
*   **Step 1 (Update Schema):** Completed. `openapi.json` modified to include new optional fields in `ExtractedEntities`.

**Phase 2 Status: Completed (Apr 8, 2025)**

---

## Phase 3: Core Logic Implementation (Netlify Function)

**Objective:** Update the `memory-action.ts` function to handle the new metadata during storage and utilize it during querying.

1.  **Modify `memory-action.ts`:**
    *   **Update TypeScript Interfaces:**
        *   Add the new optional fields (`priority?`, `conversation_id?`, `thread_id?`, `language?`) to the `ExtractedEntities` interface.
        *   Add `chunk_index?: number;` to the `ContextObject` interface.
    *   **Enhance Storage Logic (`store`/`combined` modes):**
        *   Retrieve `priority`, `language`, `conversation_id`, `thread_id` from `payload.extracted_entities`.
        *   Retrieve any date/time strings identified by the GPT (including those previously considered `due_date`).
        *   Process these date/time strings using the component extraction logic (parsing to `year`, `month`, `day`, etc.) and store the results in the `fileMetadata.dates` array (structure: `{ original: string, normalized: string | null, note?: string }`). Relative dates are normalized to ISO strings.
        *   Store `priority` and `language` directly in `fileMetadata`.
        *   Add `conversation_id` and `thread_id` to the main `fileInsertData` object for the `files` table insert (map to `files.conversation_id` and `files.thread_id` columns).
        *   Ensure the `chunk_index` (loop variable `index`) is included in the `embeddingRecords` object creation before inserting into `transcript_embeddings`. **Verification:** Check if `chunk_index: index` is already being added; `schema.sql` shows the column exists.
    *   **Enhance Query Logic (`query`/`combined` modes):**
        *   **Vector Search Call:**
            *   Extract potential filter values (`topics`, `people`, `locations`, `type`, `sentiment`) from `queryMetadata`.
            *   Normalize date strings in `queryMetadata.dates` to get `start_date` and `end_date` ISO strings.
            *   Pass these values as arguments to the `supabase.rpc('search_memory_chunks', { ..., filter_topics: topics, filter_people: people, filter_date_start: startDateISO, filter_date_end: endDateISO, ... })` call.
        *   **Fallback Search Logic:**
            *   **`created_at` Filter:** If `queryMetadata` contains normalized dates, calculate `startDateISO` and `endDateISO`. Add `.gte('created_at', startDateISO)` and `.lt('created_at', endDateISO)` filters to the `fallbackQuery`.
            *   **Metadata Date Filter:**
                *   Modify the fallback query to filter based on the `normalized` ISO dates stored in the `file_metadata->'dates'` array. This might involve JSONB operators to check if *any* date object in the array falls within the `startDateISO` / `endDateISO` range derived from the query.
    *   **Populate `chunk_index` in Results:** When mapping `searchResults` or `fallbackResults` to `ContextObject`, ensure the `chunk_index` field is populated if available from the data returned by Supabase.
    *   **Rationale:** Implement the core logic changes needed to store, process, and query using the new metadata fields and improve search relevance/filtering.
    *   **Reference:** `learnings/05_metadata_enhance_suggestions.md`, `learnings/06_netlify_function_suggestions.md`, `memory-action.ts`.

**Implementation Notes (Apr 8, 2025 - Phase 3):**
*   **Step 1 (Interfaces):** Completed. `ExtractedEntities` and `ContextObject` updated.
*   **Step 2 (Storage Logic):** Completed. Handling for `priority`, `language`, `conversation_id`, `thread_id`, and `chunk_index` added. The `normalizeDateString` function handles date processing into the `{original, normalized, note?}` structure within the `dates` array.
*   **Step 3 (Query Logic):** Completed. Vector search (`search_memory_chunks`) and fallback query filters updated for dates (`created_at`, metadata->'dates'->>'normalized'), priority, people, locations, topics. **Text fallback logic to be revised for FTS entity search.**
*   **Step 4 (Result Mapping):** Completed. `