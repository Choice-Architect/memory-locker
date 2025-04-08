## Memory Locker: Custom GPT Product Development Roadmap

**Goal:** Create a Custom GPT within the official ChatGPT application that allows a user to store and retrieve personal memories, notes, and information using natural language, voice, and potentially file uploads. The GPT will leverage Actions to interact with a Supabase backend via a Netlify Function.

**Core Technologies:**

*   **Frontend:** ChatGPT Interface (Web/iOS)
*   **Orchestration:** OpenAI Custom GPT + Actions
*   **Middleware:** Netlify Functions (TypeScript/Node.js)
*   **Backend:** Supabase (PostgreSQL Database + pgvector Extension)
*   **APIs:** OpenAI API (for Action calls), Supabase API

---

### Phase 1: Foundation & Setup

**Objective:** Prepare the necessary cloud infrastructure, database schema, and local development environment.

1.  **Supabase Project Setup:**
    *   Task: Create a new Supabase project.
    *   Task: Enable the `pgvector` extension.
    *   Task: Secure API keys and project URL.
    *   Deliverable: Active Supabase project.
    *   **Note (Apr 4):** User ID fields initially set to UUID, later changed to TEXT to accommodate GPT user IDs.
2.  **Database Schema Definition:**
    *   Task: Define PostgreSQL table structures (e.g., `memories` renamed to `files`, `transcript_embeddings`, `queries`, etc. based on `schema.sql`). Columns include content, embeddings (`vector(1536)`), timestamps, source, metadata (`JSONB` for file-level in `files`, chunk-level in `transcript_embeddings`).
    *   Task: Define vector storage strategy (1536 dimensions for `text-embedding-3-small`, plan for HNSW index creation after initial setup).
    *   Comment: *Schema largely defined in `schema.sql`. Key decisions made: Use `text-embedding-3-small`. File-level metadata (summary, all entities, including **date/time components**) in `files.file_metadata`. Chunk-level metadata (essentially a copy of file-level metadata plus chunk timestamp) in `transcript_embeddings.metadata`.*
    *   Deliverable: SQL script for schema creation (`schema.sql` updated), documented schema design (partially covered by README and this roadmap).
    *   **Note (Apr 4):** `users.id` and related foreign keys changed from UUID to TEXT post-Phase 1 to handle GPT user ID format. **Subsequently removed entirely.**
3.  **Netlify Project Setup:**
    *   Task: Create a new Netlify site.
    *   Task: Initialize a Git repository for the project.
    *   Task: Configure continuous deployment from the Git repository.
    *   Deliverable: Netlify site linked to a Git repo.
4.  **Netlify Functions Environment:**
    *   Task: Set up a `netlify/functions` directory in the repository.
    *   Task: Initialize a Node.js/TypeScript project within this directory (`package.json`, `tsconfig.json`).
    *   Task: Install necessary dependencies (`@supabase/supabase-js`, TypeScript types).
    *   Deliverable: Basic Netlify Functions project structure.
5.  **Environment Configuration:**
    *   Task: Set up local `.env` file for development secrets (Supabase URL/Key, OpenAI API Key if needed directly in function later).
    *   Task: Configure Netlify build environment variables for production secrets.
    *   Deliverable: Secure configuration management.
6.  **Local Development Setup:**
    *   Task: Ensure Node.js, npm/yarn, Netlify CLI, and optionally Supabase CLI are installed.
    *   Task: Clone the repository.
    *   Deliverable: Functional local development environment.

---

### Phase 2: Core Action Development (Netlify Function)

**Objective:** Build the serverless function that acts as the bridge between the GPT Action and the Supabase database.
**Status:** Completed (Apr 4, 2025)

1.  **API Endpoint Design:**
    *   Task: Define the request/response structure for the Netlify function (e.g., endpoint path `/api/memory-action`).
    *   Task: Define expected input JSON (e.g., `{ query_text: string, extracted_entities: object, user_id?: string, mode: 'store' | 'query' | 'combined' }`).
    *   Task: Define output JSON (e.g., success: `{ retrieved_context: [{chunk: string, timestamp: string, entities_in_chunk: object}], storage_status: string, query_source: string, message_for_gpt?: string, error: null }`, error: `{ error: string }`).
    *   **Decision:** A single action (`memory-action`) will handle different operations via the `mode` parameter, rather than creating multiple separate actions.
    *   **Status:** **Completed**. Final API contract defined in `openapi.json`. **Input no longer includes `user_id`**. Output includes `query_source` enum. `ContextObject` includes `file_id` and `chunk_index`. Input `ExtractedEntities` uses string dates; Output entities use `NormalizedDate` objects.
    *   **Authentication:** Uses `x-api-key` header matched against `ACTION_SECRET_KEY` environment variable.
    *   Deliverable: API contract specification (`openapi.json`).
2.  **Supabase Integration:**
    *   Task: Implement Supabase client initialization within the function using environment variables.
    *   Task: Implement secure handling of Supabase credentials.
    *   Deliverable: Function capable of connecting to Supabase.
3.  **Database Logic Implementation:**
    *   Task: Implement function(s) for querying memories:
        *   Primary: Vector similarity search on `transcript_embeddings` (`search_memory_chunks` RPC) using `text-embedding-3-small` (1536 dimensions) with a cosine similarity `match_threshold` (currently `0.5`) and `match_count` (currently `5`).
        *   Fallback: Structured query on `files` table when vector search returns no results. Filters based on exact match of normalized dates in `file_metadata` and/or `ILIKE` search using **stemmed** topics against `transcript_text`. Uses `@stdlib/nlp-porter-stemmer`. Limits results (currently `10`).
    *   Task: Implement function(s) for storing/upserting data:
        *   Generate `text-embedding-3-small` (1536 dimensions) embeddings within the function using OpenAI API.
        *   Store/update file-level info and **processed metadata (including extracted date/time components)** in `files` table.
        *   Store chunks (`CHUNK_SIZE=1000`, `CHUNK_OVERLAP=200`), embeddings, and **chunk-level metadata (copy of file-level metadata + timestamp)** in `transcript_embeddings`.
        *   **Implement date/time component extraction:** Use logic (e.g., `date-fns` or similar) to parse various date/time formats from the input text. Extract numerical components (`year`, `month`, `day`, `hour`, `minute`, `second`, `day_of_week`) and optional timezone information. Normalize relative terms (e.g., "today", "next week") into components based on the function's invocation timestamp. Store results within a structured `dates` array in `file_metadata`, like `[{ original: "...", components: { year: ..., month: ..., ... } }]`. Allow partial extraction (e.g., date without time).
    *   Task: Combine query and storage logic based on the input `mode` or inferred intent, using Supabase service role key (bypassing RLS). **`user_id` logic removed.**
    *   Comment: *Embeddings generated in the function using `text-embedding-3-small`. Sequential search (vector filter -> table filter fallback). Differentiated metadata storage confirmed (chunk metadata mirrors file metadata). Date handling updated to component extraction.*
    *   Deliverable: Core database interaction logic within the function (`memory-action.ts`).
4.  **Error Handling & Logging:**
    *   Task: Implement robust try/catch blocks for API calls and database operations.
    *   Task: Implement meaningful logging (e.g., using Netlify's function logs).
    *   Task: Define consistent error responses to be sent back to the GPT Action.
    *   Deliverable: Resilient function with basic observability.
5.  **Initial Deployment:**
    *   Task: Deploy the first version of the function to Netlify.
    *   Task: Test the function endpoint directly (e.g., using `curl` or Postman) with sample data.
    *   Deliverable: Deployed and testable Netlify function endpoint URL.
    *   **Status:** Completed. Function tested successfully for store, query, and combined modes via `curl` on the confirmed endpoint (`/.netlify/functions/memory-action`).

---

### Phase 3: Custom GPT Configuration & Action Schema

**Objective:** Configure the Custom GPT in the ChatGPT interface, including its instructions and the Action definition.
**Status:** Completed (Apr 4, 2025)

1.  **Custom GPT Creation:**
    *   Task: Create a new GPT via the ChatGPT UI.
    *   Task: Define name, description, and conversation starters.
    *   Deliverable: Basic Custom GPT shell.
    *   **Note:** User completed this task.
2.  **Instruction Authoring:**
    *   Task: Write detailed instructions defining the GPT's persona, purpose, and behavior.
    *   Task: Specify *when* and *why* to call the `Memory Action`.
    *   Task: Detail *how* to extract entities (names, dates, locations, concepts, events). Provide examples.
    *   Task: Specify the *format* for data sent to the Action (matching the Netlify function's expected input).
    *   Task: Explain how to use the `retrieved_context` from the Action's response.
    *   Task: Explain how to communicate `storage_status` or `error` messages back to the user appropriately.
    *   Comment: *Requires detailed thought on the entity extraction strategy and how you want the GPT to behave.*
    *   Deliverable: Comprehensive GPT instructions.
    *   **Note:** Completed. Instructions refined to include "store by default" logic, dictation handling, and inferred metadata (`type`, `sentiment`). Final version saved in `learnings/09_gpt_instructions.md`.
3.  **Action Schema Definition (OpenAPI):**
    *   Task: Create an OpenAPI v3 specification document (`openapi.yaml` or JSON).
    *   Task: Define the server URL (pointing to the deployed Netlify function).
    *   Task: Define the path (`/api/memory-action`), method (POST), and operation ID.
    *   Task: Define the request body schema (content type `application/json`, matching function input).
    *   Task: Define response schemas (e.g., 200 OK with success payload, error responses).
    *   Task: Define authentication requirements (likely API Key passed in header, managed by OpenAI).
    *   Deliverable: Valid OpenAPI specification file.
    *   **Note:** Completed. Path confirmed as `/.netlify/functions/memory-action`. Switched from initial YAML approach to JSON due to parsing issues. Required OpenAPI version `3.1.0`. Final schema saved in `openapi.json`.
4.  **Action Configuration:**
    *   Task: Add the OpenAPI schema to the Custom GPT configuration.
    *   Task: Configure authentication (set up API key if required by the Netlify function).
    *   Task: Test the schema validation within the GPT editor.
    *   Deliverable: Configured Action within the Custom GPT.
    *   **Note:** Completed. Action configured using `openapi.json` schema. Authentication set to API Key using `x-api-key` header, value set to `ACTION_SECRET_KEY`. Schema validated successfully in editor.

---

### Phase 4: Integration Testing & Iteration (Est. 2-3 weeks)

**Objective:** Test the end-to-end flow from ChatGPT input to Supabase storage/retrieval and back, refining as needed.
**Status (Apr 7, 2025 - Updated):**
*   Successfully implemented and tested basic `store` operations via the GPT panel.
*   Resolved initial `query` failures by lowering `VECTOR_MATCH_THRESHOLD` to `0.5`.
*   Implemented fallback search logic in the Netlify function using `ILIKE` on `files.transcript_text` (filtered by stemmed topics or full text) and basic date filtering based on normalized dates.
*   Implemented date normalization using `date-fns`.
*   Implemented stemming of topic keywords for fallback search using `@stdlib/nlp-porter-stemmer`.
*   Removed `user_id` dependency throughout the stack.
*   Re-enabled RLS in 'default deny' mode (bypassed by service key).
*   Core functionality (`store`, `query` via vector search, `query` via original keyword/date fallback) is working.
*   **Refined Date Handling:** Replaced single ISO string normalization with extraction of numerical date/time components (`year`, `month`, `day`, `hour`, etc.) stored in `file_metadata.dates`. Relative dates are normalized to components at store time. Query logic adapted.
*   **Phase 4 is considered complete.**

**Note (Apr 4, 2025):** Encountered foreign key constraint errors related to `user_id` during initial testing. Decided to refactor to remove `user_id` entirely for the single-user scope. Refactoring involved schema changes (removing `users` table, `user_id` columns, RLS policies), Netlify function updates, OpenAPI schema modification, and GPT instruction adjustments. **Subsequently (Apr 4), RLS was re-enabled on all tables without specific ALLOW policies ('default deny') as a defense-in-depth measure, as the Netlify function uses the `service_role` key which bypasses RLS anyway.**

**Status (Apr 5, 2025 - Updated):**
*   Successfully implemented and tested basic `store` operations via the GPT panel. User ID refactoring completed. RLS re-enabled in 'default deny' mode (bypassed by service key).
*   Encountered consistent failures with `query` operations due to vector search threshold being too high (0.75).
*   **Resolved query issue** by lowering `VECTOR_MATCH_THRESHOLD` to `0.5`.
*   Debugging involved confirming Netlify->Supabase connection, ruling out RLS, verifying index/data, and identifying SQL Editor input truncation as a red herring for direct vector literal tests. The core issue was the high threshold. Direct DB connection issues via `psql` were resolved using the Shared Pooler hostname. See `04_query_retrieval_issue.md` for full history.

**Status (Apr 6, 2025 - Updated):**
*   Implemented fallback search using `ILIKE` on `files.transcript_text`. Refined to use an `.or()` filter based on **stemmed** topics extracted by the GPT (e.g., `payload.extracted_entities.topics`) using `@stdlib/nlp-porter-stemmer`. Also added basic date filtering.
*   Implemented date normalization.
*   **Date Handling Strategy:** Implemented date normalization using `date-fns` within the Netlify function. The `normalizeDateString` function attempts to parse various user inputs (e.g., "tomorrow", "next Friday at 3 PM", "2024-07-20") relative to a reference date. It outputs a structured `NormalizedDate` object: `{ original: string, normalized: string | null, note?: string }`. The `normalized` field holds the date/time in ISO 8601 format if successful, otherwise it's `null`. The `note` field provides context on failures (e.g., vague input, parsing error). These `NormalizedDate` objects are stored in the `files.file_metadata.dates` JSONB array. This allows storing both the user's original term and the standardized ISO string for querying.
*   **Vector Store:** Populated `transcript_embeddings` table.
*   **Priority:** Added support for user-assigned priority (1-10) stored in `files.file_metadata`. GPT instructions updated.
*   **Language:** Added support for detecting language (en, fr, ar), storing in `files.file_metadata.language`. GPT instructions updated. **Note: Query filtering by language is NOT implemented.**
*   **Conversation/Thread Linking:** Added columns `conversation_id`, `thread_id` to `files` table and fields to API/function. GPT instructions updated to extract if available (experimental).
*   **Chunk Index:** `transcript_embeddings.chunk_index` is now stored and returned by `search_memory_chunks` function, included in `ContextObject`.
*   **Enhanced Vector Search Filtering:** `search_memory_chunks` RPC call now utilizes metadata filters (topics, people, dates, type, sentiment).
*   **Enhanced Fallback Search Filtering:** Fallback search now filters by `files.created_at` based on query dates, and filters `file_metadata` for priority. **Note: Filtering by language and due date was removed/not implemented.**
*   **Database Indexes:** Added GIN index on `files.file_metadata`, and indexes on `files.thread_id` and `files.created_at`.
*   **Phase 4 is considered functionally complete.**

1.  **End-to-End Testing:**
    *   Task: Interact with the Custom GPT in the ChatGPT preview or main interface.
    *   Task: Test various scenarios:
        *   Simple storage ("Remember that John Doe's birthday is July 15th").
        *   Simple query ("When is John Doe's birthday?").
        *   Complex query requiring retrieval + reasoning ("What did I discuss about Project X last week?").
        *   Queries relying on fallback search (keywords, dates).
        *   Voice inputs.
        *   File inputs (if included).
        *   Edge cases and potential ambiguities (e.g., unparseable dates).
    *   Task: Verify data persistence and retrieval accuracy in Supabase.
    *   Task: Monitor Netlify function logs for errors or unexpected behavior.
    *   Deliverable: Test plan, execution results, bug/issue list.
2.  **Refinement Cycle:**
    *   Task: Update GPT instructions based on observed behavior (e.g., improve entity extraction, clarify Action usage).
    *   Task: Modify Action schema if API contract needs adjustment.
    *   Task: Update Netlify function logic to fix bugs, improve queries (e.g., date range matching), or handle edge cases found during testing.
    *   Task: Redeploy function and re-test.
    *   **Note:** Ensure any remaining temporary debug logging is removed from the Netlify function before moving to Phase 5.
    *   Deliverable: Improved GPT instructions, refined Action schema, updated Netlify function code.

**Sub-Tasks for Iteration (Completed in Phase 4):**
*   Implement Fallback Search Logic: Add functionality to `memory-action` to query the `files` table (text search, metadata filtering) when vector search yields no results.
    *   **Update (Apr 6):** Implemented initial fallback using `ILIKE` on `files.transcript_text` (filtered by stemmed topics or full text) and basic exact-match date filtering. Uses `@stdlib/nlp-porter-stemmer`.
*   Implement Date Normalization: Add robust date parsing/normalization.
    *   **Update (Apr 8):** Implemented using `date-fns` and `normalizeDateString` function. Refined to handle more formats (specific dates/times, weekdays, months), reject vague terms, and provide failure notes in the response.

---

### Phase 5: Enhancements & Optimization (Ongoing)

**Objective:** Improve the quality, performance, and feature set beyond the core functionality.

**Update (Apr 8, 2025 - Previous):** Implemented several metadata and filtering enhancements:
*   **Priority:** Added support for user-assigned priority (1-10) stored in `files.file_metadata`. GPT instructions updated.
*   **Due Date:** *Removed* dedicated due date handling in favor of general date normalization within the `dates` array.
*   **Language:** Added support for detecting language (en, fr, ar), storing in `files.file_metadata.language`. GPT instructions updated. **Note: Query filtering by language is NOT implemented.**
*   **Conversation/Thread Linking:** Added columns `conversation_id`, `thread_id` to `files` table and fields to API/function. GPT instructions updated to extract if available (experimental).
*   **Chunk Index:** `transcript_embeddings.chunk_index` is now stored and returned by `search_memory_chunks` function, included in `ContextObject`.
*   **Enhanced Vector Search Filtering:** `search_memory_chunks` RPC call now utilizes metadata filters (topics, people, dates, type, sentiment).
*   **Enhanced Fallback Search Filtering:** Fallback search now filters by `files.created_at` based on query dates, and filters `file_metadata` for priority. **Note: Filtering by language and due date was removed/not implemented.**
*   **Database Indexes:** Added GIN index on `files.file_metadata`, and indexes on `files.thread_id` and `files.created_at`.

**Update (Apr 9, 2025 - Fallback Refinement):**
*   **Auto-Keywords Removed:** Eliminated the generation and storage of `auto_keywords` in `file_metadata` and `transcript_embeddings.metadata`.
*   **Tiered Fallback Implemented:** Refactored the query fallback logic in the Netlify function (`memory-action.ts`) into a sequential process:
    1.  **Vector Search:** (Primary) Uses `search_memory_chunks` RPC with metadata filters.
    2.  **Metadata Fallback:** (If Vector fails) Queries `files` table, filtering by `created_at` range and using JSONB operators (`@>` contains, `->>` equals) on `file_metadata` fields (people, locations, topics, priority). **Note: Filtering by language is NOT implemented.**
    3.  **Text Fallback:** (If Metadata fails) Performs a full-text search on `files.transcript_text` using **all entities** extracted from the current query. Ranks results based on relevance (most matching entities) and returns the top matches. **Does not search the raw query text.**
*   **Query Source Tracking:** Updated the `query_source` in the response to indicate the specific fallback method used (`postgres_fallback_metadata`, `postgres_fallback_text`).
*   **Database Index Requirements:** Confirmed/added necessary indexes in Supabase to support the new fallback queries:
    *   GIN index on `files.file_metadata` (using `jsonb_path_ops` recommended).
    *   B-tree index on `files.created_at`.
    *   **Text Search Index:** FTS implemented using a GIN index (`files_transcript_tsv_idx`) on a dedicated `tsvector` column (`transcript_tsv`) in the `files` table. (Removed old `pg_trgm` index).
    *   HNSW index on `transcript_embeddings.embedding` for vector search.

1.  **Advanced Retrieval:** Implement more sophisticated search strategies (e.g., hybrid search, filtering by metadata, time-based decay).
2.  **Context Management:** Improve how the GPT handles multi-turn conversations related to memories.
3.  **File Handling:** Fully implement robust file analysis, metadata extraction, and storage (if not part of the initial scope).
4.  **User Feedback Mechanism:** Consider ways to allow users to correct the GPT's memory or understanding.
5.  **Performance Optimization:** Optimize Netlify function cold starts, database query performance.
6.  **Enhanced Logging/Monitoring:** Integrate more advanced logging or monitoring tools.

---

### Phase 6: Documentation & Launch

**Objective:** Finalize documentation and prepare for wider use (if applicable).
**Note (Apr 7, 2025):** Need to ensure documentation reflects the removal of the `user_id` dependency and the re-enabling of RLS in 'default deny' mode.

1.  **Documentation:**
    *   Task: Clean up and finalize documentation for the OpenAPI schema.
    *   Task: Document the Netlify function's logic, setup, and environment variables.
    *   Task: Document the final Custom GPT instructions and configuration decisions.
    *   Deliverable: Project documentation package.
2.  **Final Checks:**
    *   Task: Perform final regression testing.
    *   Task: Review security configurations (API keys, database access rules).
    *   Deliverable: Pre-launch checklist passed.
3.  **Launch/Sharing:**
    *   Task: Publish the Custom GPT (options: private, link-sharing, GPT Store).
    *   Deliverable: Accessible Custom GPT.

---