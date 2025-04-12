## Memory Locker: Custom GPT Product Development Roadmap (v1.8.0)

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
4.  **Netlify Functions Environment:** Set up `netlify/functions` directory with Node.js/TypeScript project. Dependencies (`@supabase/supabase-js`, `openai`, `date-fns`, `chrono-node`, etc.) installed.
5.  **Environment Configuration:** Established secure management of secrets via Netlify build variables and local `.env` files.
6.  **Local Development Setup:** Ensured necessary tools (Node.js, Netlify CLI, etc.) were available.
7.  **Database Indexing:** Applied necessary performance indexes (HNSW for vectors, GIN for JSONB metadata including date components, GIN for FTS, B-tree for timestamps) as defined in `sql/schema.sql`.
8.  **Database Functions:** Updated `search_memory_chunks` function to return `chunk_index` and `similarity`.

---

### Phase 2: Core Action Development (Netlify Function - Completed Pre-v1.7)

**Objective:** Built the `memory-action` serverless function (`memory-action.ts`) bridging the GPT Action and Supabase, including initial Storage and Query logic.

1.  **API Endpoint Design:** Defined a single endpoint (`/.netlify/functions/memory-action`) using POST, managed by the `mode` parameter (`store`, `query`, `combined`). API contract specified in `openapi.json`. Authentication uses `x-api-key`.
2.  **Supabase Integration:** Implemented client initialization and secure connection using environment variables and the service role key (bypassing RLS).
3.  **Core Function Logic (Pre-v1.7):**
    *   **Storage (`store`/`combined`):**
        *   Generated `text-embedding-3-small` embeddings for text chunks.
        *   Stored file info and `file_metadata` in the `files` table.
        *   Stored chunks, embeddings, `chunk_index`, and chunk-level `metadata` in `transcript_embeddings`.
        *   **Date Handling (Iterative Refinement):** Initial versions used `chrono-node` and increasingly complex pattern-matching (`date-fns`) in `parseDateStringToEnhanced` to extract structured date components (`year`, `month`, `day`, `period`, etc.). This approach faced persistent challenges with reliability and edge cases (Ref: v1.4, v1.5, v1.6 plans/analyses).
    *   **Query (`query`/`combined`):** Foundational logic for retrieving stored memories was established. *(Note: The specific retrieval and ranking strategy was significantly redesigned in Phase 5 - see Item 5 below for the current plan)*.
4.  **Error Handling & Logging:** Implemented try/catch blocks, basic logging.
5.  **Deployment & Initial Testing:** Function deployed and tested.

---

### Phase 3: Custom GPT Configuration & Action Schema (v1.7.1 Update Completed)

**Objective:** Configured the Custom GPT, including instructions and Action definition.

1.  **Custom GPT Creation:** Created GPT shell (name, description, etc.).
2.  **Instruction Authoring (`learnings/02_gpt_instructions.md`):** Defined persona, purpose, behavior. Key instructions included entity extraction.
    *   **v1.7 Update Completed:** Modified instructions to ask the GPT to provide *both* original date strings and normalized `"Month DD, YYYY"` versions where possible, using the *start date* for ranges/seasons. (Ref: `learnings/02_enhancement_plan.md` v1.7.1).
3.  **Action Schema Definition (`openapi.json`):** Created OpenAPI spec.
    *   **v1.7.1 Update Completed:** Modified the `entities.dates` input schema to accept `string | {original: string, normalized?: string}`. Updated the `EnhancedNormalizedDate` *response/storage* schema to only include date components (`year`, `month`, `day`, `day_of_week`, `week_number`) plus `period`. Removed specific time components (`time_hour`, `time_minute`, `time_second`), `original`, and `note`. (Ref: `learnings/02_enhancement_plan.md` v1.7.1).
4.  **Action Configuration:** Configured API key authentication.

---

### Phase 4: Integration Testing & Refinement (Completed Pre-v1.7)

**Objective:** Tested the end-to-end flow and refined implementation based on results.

1.  **End-to-End Testing:** Performed various tests.
2.  **Refinement & Bug Fixing:** Addressed initial issues.

---

### Phase 5: Enhancements & Optimization (v1.8.0 - Completed)

**Objective:** Improve date handling reliability (v1.7.1) and enhance query relevance through hybrid search and weighted re-ranking (v1.8.0).

1.  **(Obsolete) Previous Date Refactoring Attempts:** Versions older than v1.7 involved iterative refinement of pattern-matching within the Netlify function, which proved complex and incomplete. v1.7.1 adopts a new hybrid approach.

2.  **(Obsolete) Relevance Boosting (v1.3 - Superseded):** The original relevance boosting from v1.3, which relied solely on hierarchical date/period matching after vector search, has been superseded by the v1.8 hybrid search and weighted re-ranking approach.

3.  **Non-Date Entity Extraction (Completed & Stable):**
    *   **Status:** Stable baseline. No changes made.

4.  **Refactor Date Parsing (Hybrid Approach - v1.7.1 - Completed):**
    *   **Goal:** Achieved reliable date/time component extraction by leveraging upstream GPT normalization and targeted Netlify function logic.
    *   **Approach (v1.7.1 - Hybrid):** (Ref: `learnings/02_enhancement_plan.md` v1.8)
        1.  **GPT Task (Completed):** Updated GPT instructions (`02_gpt_instructions.md`) to request normalized `\"Month DD, YYYY\"` dates alongside original strings when possible.
        2.  **Schema Update (Completed):** Updated `openapi.json` to handle the new input date format and the simplified `EnhancedNormalizedDate` output format (only date components + `period`).
        3.  **Netlify Function (`memory-action.ts`) (Completed):**
            *   Refactored date processing to prioritize parsing the GPT-provided `normalized` date (`\"Month DD, YYYY\"`) using `date-fns` (`parseNormalizedDate`).
            *   **Simplified** `extractTimeInfo` to use only keyword matching (on original string) to extract the `period` ('Morning', 'Afternoon', etc.). **Removed** parsing of specific hours/minutes/seconds.
            *   Implemented a new, clean function (`parseOriginalStringDate`) using only `date-fns` to attempt parsing dates the GPT couldn't normalize.
            *   Ensured only structured date components (`year`, `month`, `day`, `day_of_week`, `week_number`) and the extracted `period` are stored in metadata.
    *   **Rationale:** Simplifies the main parsing path, focuses Netlify logic on specific tasks, maintains components needed for query relevance, accepts limitations for ambiguous dates not normalized by GPT.
    *   **Status:** **Completed (v1.7.1).**

5.  **Enhance Query Retrieval & Ranking (v1.8.0 - Completed):**
    *   **Goal:** Improved query relevance by implementing true hybrid retrieval and weighted re-ranking.
    *   **Approach (v1.8.0 - Hybrid):** (Ref: `learnings/02_enhancement_plan.md` v1.8 for full details)
        1.  **Concurrent Search (Completed):** Implemented concurrent Vector Search (`executeVectorSearch`) and FTS search (`executeFtsSearch` on `files` table) using `Promise.allSettled`.
        2.  **RRF Combination (Completed):** Combined results using Reciprocal Rank Fusion (`applyRRF` function) with `k = 60`.
        3.  **Weighted Re-ranking (Completed):** Refined `rerankResults` function:
            *   Used normalized RRF score (min-max scaled) as the base `initial_score`.
            *   Implemented additive, granular metadata boosts using `ENTITY_WEIGHTS` constant.
            *   Calculated `final_score = Math.min(1.0, initial_score + metadata_boost_score)`.
        4.  **Schema/Instructions Update (Completed):** Updated `openapi.json` and `gpt_instructions.md` to use simplified `query_source` ('hybrid', 'none', 'error') and general response phrasing.
        5.  **Tuning (Pending):** Initial constants (`RRF_K`, `ENTITY_WEIGHTS`) set. Future tuning planned based on evaluation.
    *   **Rationale:** Leverages both semantic and keyword search upfront via RRF, then applies granular, weighted, metadata-focused re-ranking for improved precision in the journaling context.
    *   **Status:** **Completed (v1.8.0).**

6.  **Future Considerations (Backlog):**
    *   Evaluation and tuning of RRF `k` and `ENTITY_WEIGHTS`.

---

### Phase 6: Testing & Launch (Pending)

1.  **Final Checks:** Perform regression testing after v1.8.0 implementation, review security configurations, evaluate query performance.

--- 