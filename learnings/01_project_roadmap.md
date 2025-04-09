## Memory Locker: Custom GPT Product Development Roadmap (v1.1)

**Goal:** Create a Custom GPT within the official ChatGPT application that allows a user to store and retrieve personal memories, notes, and information using natural language, voice, and potentially file uploads. The GPT will leverage Actions to interact with a Supabase backend via a Netlify Function.

**Core Technologies:**

*   **Frontend:** ChatGPT Interface (Web/iOS)
*   **Orchestration:** OpenAI Custom GPT + Actions
*   **Middleware:** Netlify Functions (TypeScript/Node.js)
*   **Backend:** Supabase (PostgreSQL Database + pgvector Extension)
*   **APIs:** OpenAI API (for Action calls), Supabase API

**Note on Updates:** *When requesting updates to learning documents, the expectation is a thorough alignment of all relevant details (descriptions, logic summaries, statuses, etc.) across all related files (`01_project_roadmap.md`, `03_consolidated_enhancement_plan.md`, `04_date_refactor_plan.md`, etc.) to reflect the current state accurately, not just marking items as complete.*

---

### Phase 1: Foundation & Setup (Completed)

**Objective:** Prepared the necessary cloud infrastructure, database schema, and local development environment.

1.  **Supabase Project Setup:** Created project, enabled `pgvector`, secured keys.
2.  **Database Schema Definition:** Defined PostgreSQL tables (`files`, `transcript_embeddings`, etc.) in `sql/schema.sql`. Key aspects:
    *   `files.file_metadata` (JSONB) stores file-level entities.
    *   `transcript_embeddings.metadata` (JSONB) stores chunk-level entities (mirroring file-level).
    *   `transcript_embeddings.embedding` uses `vector(1536)` for `text-embedding-3-small`.
    *   `files.transcript_tsv` (`tsvector`) added for FTS.
    *   User-specific identification (`user_id`) was initially considered and then removed.
3.  **Netlify Project Setup:** Created site, linked Git repository, configured deployment.
4.  **Netlify Functions Environment:** Set up `netlify/functions` directory with Node.js/TypeScript project. Dependencies (`@supabase/supabase-js`, `openai`, `date-fns`, etc.) installed.
5.  **Environment Configuration:** Established secure management of secrets via Netlify build variables and local `.env` files.
6.  **Local Development Setup:** Ensured necessary tools (Node.js, Netlify CLI, etc.) were available.
7.  **Database Indexing:** Applied necessary performance indexes (HNSW for vectors, GIN for JSONB metadata, GIN for FTS, B-tree for timestamps) as defined in `sql/schema.sql`.
8.  **Database Functions:** Updated `search_memory_chunks` function to return `chunk_index`.

---

### Phase 2: Core Action Development (Netlify Function - Completed)

**Objective:** Built the `memory-action` serverless function (`memory-action.ts`) bridging the GPT Action and Supabase.

1.  **API Endpoint Design:** Defined a single endpoint (`/.netlify/functions/memory-action`) using POST, managed by the `mode` parameter (`store`, `query`, `combined`). API contract specified in `openapi.json`. Authentication uses `x-api-key`.
2.  **Supabase Integration:** Implemented client initialization and secure connection using environment variables and the service role key (bypassing RLS).
3.  **Core Function Logic:**
    *   **Storage (`store`/`combined`):**
        *   Generates `text-embedding-3-small` embeddings for text chunks (`CHUNK_SIZE=1000`, `CHUNK_OVERLAP=200`).
        *   Stores file info and `file_metadata` in the `files` table. Metadata includes extracted entities like `priority`, `language`, and `dates` (as `EnhancedNormalizedDate` objects after refactor).
        *   `conversation_id` and `thread_id` are stored in top-level columns on the `files` table for efficient filtering.
        *   Stores chunks, embeddings, `chunk_index`, and chunk-level `metadata` (mirroring `file_metadata`) in `transcript_embeddings`. **Note:** Chunk metadata redundantly includes `conversation_id`/`thread_id` from `file_metadata` for potential future chunk-specific context needs.
    *   **Date Handling (Current Implementation - Post Refactor):**
        *   Uses `chrono-node` library within `parseDateStringToEnhanced` function to parse various date/time formats relative to the current timestamp.
        *   Outputs `EnhancedNormalizedDate` objects containing components (year, month, day, hour, etc.) and potentially a normalized ISO string.
        *   These `EnhancedNormalizedDate` objects are stored in the `dates` array within metadata JSONB columns (`files.file_metadata` and `transcript_embeddings.metadata`).
    *   **Query (`query`/`combined`) - Revised Strategy v1.2:**
        *   Implements a **Simplified Query Strategy with Re-ranking**:
            1.  **Primary - Vector Search:** Calls `search_memory_chunks` RPC, passing query embedding. Retrieves top `VECTOR_MATCH_COUNT` (e.g., 15) candidates based on similarity. Optional metadata filters (topics, people, etc.) can be passed but likely omitted for broad initial retrieval. *Date components are NOT used for filtering here.*
            2.  **Fallback - Full-Text Search (FTS):** If Vector Search fails, queries `files` table using `textSearch` against `transcript_tsv` column, using entities from the query. *Crucially, includes conditional `created_at` filtering:* If the Netlify function derives a specific past date range from the query, a `WHERE created_at BETWEEN ...` clause is added. Retrieves top `FALLBACK_MATCH_COUNT` (e.g., 20) candidates ranked by FTS relevance (`ts_rank_cd`).
            3.  **Application-Layer Re-ranking:** After initial retrieval (Vector or FTS), the Netlify function performs re-ranking. It calculates a `final_score` for each candidate based on its `initial_score` (similarity or fixed score for FTS) plus a `metadata_boost_score` (sum of +0.05 for each overlapping metadata entity: people, locations, topics, type, sentiment, dates). The top `FINAL_MATCH_COUNT` (e.g., 5) results based on `final_score` are selected.
        *   The source of the result (`vector_store`, `postgres_fallback_text`, `none`) is tracked in the response (`query_source`).
4.  **Error Handling & Logging:** Implemented try/catch blocks, basic Netlify function logging, and consistent error responses.
5.  **Deployment & Initial Testing:** Function deployed and tested via endpoint.

---

### Phase 3: Custom GPT Configuration & Action Schema (Completed)

**Objective:** Configured the Custom GPT in the ChatGPT interface, including instructions and the Action definition.

1.  **Custom GPT Creation:** Created GPT shell (name, description, etc.).
2.  **Instruction Authoring (`learnings/02_gpt_instructions.md`):** Defined persona, purpose, behavior. Key instructions:
    *   Use `memory-action` for all interactions.
    *   Default to `store` mode unless explicitly querying.
    *   Handle dictation by rewriting internally before storing.
    *   Extract standard entities (`people`, `dates` as strings, `locations`, etc.).
    *   Infer `type` and `sentiment`.
    *   Extract `priority`, `language`, `conversation_id`, `thread_id`.
    *   Handle responses (synthesize context, acknowledge storage/errors).
3.  **Action Schema Definition (`openapi.json`):** Created OpenAPI v3.1.0 spec defining the server URL, path, method, request/response schemas (including `NormalizedDate` in output), and API key authentication (`x-api-key`).
4.  **Action Configuration:** Added schema to GPT config, configured API key authentication. Schema validated in editor.

---

### Phase 4: Integration Testing & Refinement (Completed)

**Objective:** Tested the end-to-end flow and refined implementation based on results.

1.  **End-to-End Testing:** Performed various tests (store, query, complex scenarios, fallbacks) via the ChatGPT interface.
2.  **Refinement & Bug Fixing:**
    *   Adjusted `VECTOR_MATCH_THRESHOLD` for better query recall.
    *   Implemented and refined the tiered fallback search logic.
    *   Implemented and refined date normalization logic (*originally `normalizeDateString`, now `parseDateStringToEnhanced` with `chrono-node`*).
    *   Refactored to remove `user_id` dependency.
    *   Added and tested metadata enhancements (priority, language, etc.) and filtering.
    *   Ensured `chunk_index` propagation.
    *   Addressed various bugs and inconsistencies identified during testing.

---

### Phase 5: Enhancements & Optimization (Ongoing)

**Objective:** Improve quality, performance, and features beyond the current core functionality.

1.  **Refactor Date Handling (Completed - Filtering Removed):** 
    *   **Goal:** Modify date handling to parse and store structured date/time components.
    *   **Approach:** Integrated `chrono-node`, defined `EnhancedNormalizedDate`, updated storage logic. SQL function and Netlify function query logic were updated to *remove* date component filtering.
    *   **Rationale:** Retains detailed date information *for potential post-retrieval processing* (like relevance boosting) rather than strict filtering.
    *   **Status:** Completed.

2.  **Implement Relevance Boosting (Application Layer) (Next Step - Plan v1.2):**
    *   **Goal:** Improve relevance ranking of query results using stored metadata *after* initial broad retrieval, using the simplified fallback.
    *   **Approach:** Implement re-ranking logic within the Netlify function (`memory-action.ts`) based on **Plan v1.2 in `learnings/03_relevance_boosting_plans.md`**. This involves:
        *   Removing the metadata fallback tier.
        *   Implementing conditional `created_at` filtering in the FTS fallback.
        *   Retrieving a larger candidate set (e.g., 15/20).
        *   Implementing the `rerankResults` function with purely additive scoring (`final_score = initial_score + metadata_boost_score`).
        *   Calculating `metadata_boost_score` based on entity overlap (+0.05 per type).
        *   Returning the top K (e.g., 5) results.
    *   **Rationale:** Simplifies fallback logic while providing flexible metadata-driven ranking and correct time-based filtering.
    *   **Status:** Planned.

3.  **Future Considerations (Backlog):**
    *   Advanced Retrieval (Hybrid search, time decay, more sophisticated boosting).

---

### Phase 6: Documentation & Launch (Pending)

**Objective:** Finalize documentation and prepare for wider use.

1.  **Documentation:** Finalize OpenAPI comments, document Netlify function logic/setup, review GPT instructions.
2.  **Final Checks:** Perform regression testing, review security configurations.
3.  **Launch/Sharing:** Publish the Custom GPT (Private/Link/Store).

--- 