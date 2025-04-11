## Memory Locker: Custom GPT Product Development Roadmap (v1.5)

**Goal:** Create a Custom GPT within the official ChatGPT application that allows a user to store and retrieve personal memories, notes, and information using natural language, voice, and potentially file uploads. The GPT will leverage Actions to interact with a Supabase backend via a Netlify Function.

**Core Technologies:**

*   **Frontend:** ChatGPT Interface (Web/iOS)
*   **Orchestration:** OpenAI Custom GPT + Actions
*   **Middleware:** Netlify Functions (TypeScript/Node.js)
*   **Backend:** Supabase (PostgreSQL Database + pgvector Extension)
*   **APIs:** OpenAI API (for Action calls), Supabase API

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
        *   Stores file info and `file_metadata` in the `files` table. Metadata includes extracted entities like `priority`, `language`, and `dates`.
        *   `conversation_id` and `thread_id` are stored in top-level columns on the `files` table for efficient filtering.
        *   Stores chunks, embeddings, `chunk_index`, and chunk-level `metadata` (mirroring `file_metadata`) in `transcript_embeddings`.
    *   **Date Handling (Previous Implementation):**
        *   Initial versions used `chrono-node` and complex post-processing to attempt extraction of date components (`year`, `month`, `day`, etc.) into `EnhancedNormalizedDate` objects stored in metadata. This approach proved unreliable and introduced regressions (Ref: `learnings/05_test_observations_v1.4.md`).
    *   **Query (`query`/`combined`) - (Implemented v1.3):**
        *   Implements a **Simplified Query Strategy with Application-Layer Re-ranking**:
            1.  **Primary Retrieval - Vector Search:** Calls `search_memory_chunks` RPC with query embedding. Assume RPC returns `similarity`. Retrieves top `VECTOR_MATCH_COUNT` (15) candidates.
            2.  **Fallback Retrieval - FTS:** If Vector Search fails or returns no results, queries the `files` table using `textSearch` against `transcript_tsv` (using `'english'` config and query entities *excluding language*). Select the `ts_rank_cd` score as `rank`. Retrieves top `FALLBACK_MATCH_COUNT` (20) candidates.
            3.  **Mapping & Truncation:** Map results to `ContextObject`s, preserving `similarity` (from vector) or `rank` (from FTS). Truncate FTS `chunk` text to 3000 chars.
            4.  **Application-Layer Re-ranking:** After retrieval and mapping, the Netlify function (`memory-action.ts`) re-ranks the candidates using `rerankResults`.
                *   Calculates `initial_score` based on `similarity` (vector) or `rank` (FTS).
                *   Calculates `metadata_boost_score` by summing increments for overlapping metadata (`people`, `locations`, `topics`, `type`, `sentiment`; *language excluded*; `+0.05` each) and adding a hierarchical boost for date matching (Day +0.05, Month +0.03, Year +0.01) based on stored date components. For FTS results, adds an additional `+0.10` if the candidate's `timestamp` falls within a past date range derived from the query.
                *   Calculates `final_score = min(1.0, initial_score + metadata_boost_score)`.
            5.  **Final Selection:** The top `FINAL_MATCH_COUNT` (5) results based on `final_score` are selected and returned.
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
    *   Extract `priority`, `language`. (Note: Extraction of `conversation_id`, `thread_id` from user input was disabled due to backend constraints).
    *   Handle responses (synthesize context, acknowledge storage/errors).
3.  **Action Schema Definition (`openapi.json`):** Created OpenAPI v3.1.0 spec defining the server URL, path, method, request body (`ExtractedEntities`), response (`SuccessResponse` containing `ContextObject`s referencing `EnhancedNormalizedDate` for output dates), and API key authentication (`x-api-key`). Schema reflects `EnhancedNormalizedDate` structure (including `week_number`, potentially excluding `normalized`).
4.  **Action Configuration:** Added schema to GPT config, configured API key authentication. Schema validated in editor.

---

### Phase 4: Integration Testing & Refinement (Completed)

**Objective:** Tested the end-to-end flow and refined implementation based on results.

1.  **End-to-End Testing:** Performed various tests (store, query, complex scenarios, fallbacks) via the ChatGPT interface.
2.  **Refinement & Bug Fixing:** Addressed initial issues found during integration.

---

### Phase 5: Enhancements & Optimization (Ongoing)

**Objective:** Improve quality, performance, and features beyond the current core functionality.

1.  **(Obsolete) Refactor Date Handling (Original Attempt):** Previous attempts (culminating in plan v1.4) involved complex post-processing of `chrono-node` results to extract structured components. This proved unreliable and introduced regressions.

2.  **Implement Relevance Boosting (Application Layer) (Completed v1.3):**
    *   **Goal:** Improve relevance ranking of query results using stored metadata, vector similarity, FTS rank, and date matching *after* initial broad retrieval.
    *   **Approach:** Implemented the re-ranking logic within the Netlify function (`memory-action.ts`), incorporating similarity/rank scores and boosting based on metadata/date component overlap. (Details in Phase 2 & `learnings/02_enhancement_plan.md`).
    *   **Rationale:** Leverages both semantic similarity and text relevance scores, provides flexible metadata/date-driven ranking (excluding language), including hierarchical date matching, and simplifies query logic.
    *   **Status:** Completed. Relies on accurate date components from the storage process.

3.  **Non-Date Entity Extraction (`store` mode) (Completed & Stable):**
    *   **Goal:** Confirm reliable extraction of non-date entities.
    *   **Findings:** Extraction of `people`, `locations`, `topics`, `type`, `sentiment`, `language`, `priority`, `organizations` meets requirements.
    *   **Status:** Stable baseline.

4.  **Refactor Date Parsing (`store` mode) (v1.5 - Completed):**
    *   **Goal:** Reliably extract accurate date/time **components** (year, month, day, week_number, period, etc.) for storage in metadata, resolving issues from previous attempts.
    *   **Approach (Pattern-Driven):** Refactored `parseDateStringToEnhanced` in `memory-action.ts` to:
        1.  Strip defined qualifiers.
        2.  Use `chrono-node` primarily to identify the date text phrase.
        3.  Use pattern matching (regex/string checks) on the identified phrase.
        4.  Based on the pattern, use `date-fns` directly to calculate components.
        5.  Populate only the reliably calculated components into `EnhancedNormalizedDate`.
        6.  Remove the generation of the `normalized` ISO string.
    *   (Full details in `learnings/02_enhancement_plan.md`, v1.5 section).
    *   **Rationale:** Created a more robust and maintainable date component extraction system focused on the primary goal, avoiding complex interpretation of `chrono-node` internals and removing unused `normalized` string logic.
    *   **Status:** **Completed.**

5.  **Future Considerations (Backlog):**
    *   Advanced Retrieval (Hybrid search, time decay, more sophisticated boosting).

---

### Phase 6: Documentation & Launch (Pending)

1.  **Final Checks:** Perform regression testing, review security configurations.

--- 