## Memory Locker: Custom GPT Product Development Roadmap (v1.2)

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
    *   **Query (`query`/`combined`) - Strategy v1.3 (Pending Implementation):**
        *   Implements a **Simplified Query Strategy with Application-Layer Re-ranking**:
            1.  **Primary Retrieval - Vector Search:** Calls `search_memory_chunks` RPC with query embedding. Assume RPC returns `similarity`. Retrieves top `VECTOR_MATCH_COUNT` (15) candidates.
            2.  **Fallback Retrieval - FTS:** If Vector Search fails or returns no results, queries the `files` table using `textSearch` against `transcript_tsv` (using `'english'` config and query entities *excluding language*). Select the `ts_rank_cd` score as `rank`. Retrieves top `FALLBACK_MATCH_COUNT` (20) candidates.
            3.  **Mapping & Truncation:** Map results to `ContextObject`s, preserving `similarity` (from vector) or `rank` (from FTS). Truncate FTS `chunk` text to 3000 chars.
            4.  **Application-Layer Re-ranking:** After retrieval and mapping, the Netlify function (`memory-action.ts`) re-ranks the candidates using `rerankResults`.
                *   Calculates `initial_score` based on `similarity` (vector) or `rank` (FTS).
                *   Calculates `metadata_boost_score` by summing increments for overlapping metadata (`people`, `locations`, `topics`, `type`, `sentiment`, `dates` presence; *language excluded*; `+0.05` each). For FTS results, adds an additional `+0.10` if the candidate's `timestamp` falls within a past date range derived from the query.
                *   Calculates `final_score = min(1.0, initial_score + metadata_boost_score)`.
            5.  **Final Selection:** The top `FINAL_MATCH_COUNT` (5) results based on `final_score` are selected and returned.
        *   The source of the result (`vector_store`, `postgres_fallback_text`, `none`) is tracked in the response (`query_source`).
        *   **Note:** Date parsing notes from `chrono-node` are no longer included in the response `message_for_gpt`.
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
3.  **Action Schema Definition (`openapi.json`):** Created OpenAPI v3.1.0 spec defining the server URL, path, method, request body (`ExtractedEntities` for input dates), response (`SuccessResponse` containing `ContextObject`s, which in turn use `OutputProcessedEntities` referencing `EnhancedNormalizedDate` for output dates), and API key authentication (`x-api-key`).
4.  **Action Configuration:** Added schema to GPT config, configured API key authentication. Schema validated in editor.

---

### Phase 4: Integration Testing & Refinement (Completed)

**Objective:** Tested the end-to-end flow and refined implementation based on results.

1.  **End-to-End Testing:** Performed various tests (store, query, complex scenarios, fallbacks) via the ChatGPT interface.
2.  **Refinement & Bug Fixing:** *(Details to be populated after testing v1.2 implementation)*

---

### Phase 5: Enhancements & Optimization (Ongoing)

**Objective:** Improve quality, performance, and features beyond the current core functionality.

1.  **Refactor Date Handling (Completed - Filtering Removed):** 
    *   **Goal:** Modify date handling to parse and store structured date/time components.
    *   **Approach:** Integrated `chrono-node`, defined `EnhancedNormalizedDate`, updated storage logic. SQL function and Netlify function query logic were updated to *remove* date component filtering during initial retrieval.
    *   **Rationale:** Retains detailed date information for relevance boosting during re-ranking rather than strict pre-filtering.
    *   **Status:** Completed.

2.  **Implement Relevance Boosting (Application Layer) (Next Step - Plan v1.3):**
    *   **Goal:** Improve relevance ranking of query results using stored metadata, vector similarity, FTS rank, and date matching *after* initial broad retrieval, following the simplified fallback and re-ranking strategy (v1.3).
    *   **Approach:** Implement the logic detailed in **`learnings/02_enhancement_plan.md`** (v1.3) within the Netlify function (`memory-action.ts`). Key implementation tasks include:
        *   Updating constants (`VECTOR_MATCH_COUNT=15`, `FALLBACK_MATCH_COUNT=20`, `FINAL_MATCH_COUNT=5`).
        *   Updating relevant TypeScript interfaces (`SearchResultItem`, `FallbackResultItem`, `ContextObject`).
        *   Ensuring FTS query selects `rank` and does not pre-filter by date.
        *   Updating mapping logic to preserve scores (`similarity`, `rank`) and truncate FTS chunks.
        *   Implementing the enhanced `rerankResults` function: calculate `initial_score` (similarity or rank), `metadata_boost_score` (additive, +0.05 per overlap type excluding language, +0.10 for FTS date range match), and `final_score`.
        *   Integrating the `rerankResults` call after initial retrieval.
        *   Removing date parsing note logic from the final response.
    *   **Rationale:** Leverages both semantic similarity and text relevance scores, provides flexible metadata/date-driven ranking (excluding language), and simplifies query logic.
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