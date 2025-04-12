## Memory Locker: Custom GPT Product Development Roadmap (v1.7)

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
    *   **Query (`query`/`combined`) (v1.3 Implementation):**
        *   Implemented a **Simplified Query Strategy with Application-Layer Re-ranking**:
            1.  Primary Retrieval (Vector Search) via `search_memory_chunks` (Top 15).
            2.  Fallback Retrieval (FTS) via `files` table (Top 20).
            3.  Mapping & Truncation of results.
            4.  Application-Layer Re-ranking (`rerankResults`) using `initial_score` (similarity/rank) plus `metadata_boost_score` (metadata overlap, hierarchical date matching based on stored components, past date boost for FTS).
            5.  Final Selection (Top 5).
4.  **Error Handling & Logging:** Implemented try/catch blocks, basic logging.
5.  **Deployment & Initial Testing:** Function deployed and tested.

---

### Phase 3: Custom GPT Configuration & Action Schema (Requires v1.7 Update)

**Objective:** Configured the Custom GPT, including instructions and Action definition.

1.  **Custom GPT Creation:** Created GPT shell (name, description, etc.).
2.  **Instruction Authoring (`learnings/02_gpt_instructions.md`):** Defined persona, purpose, behavior. Key instructions included entity extraction.
    *   **v1.7 Update Needed:** Modify instructions to ask the GPT to provide *both* original date strings and normalized `"Month DD, YYYY"` versions where possible (e.g., `"April 15, 2025"`), using the *start date* for ranges/seasons. (Ref: `learnings/02_enhancement_plan.md` v1.7).
3.  **Action Schema Definition (`openapi.json`):** Created OpenAPI spec.
    *   **v1.7 Update Needed:** Modify the `entities.dates` schema to accept `string | {original: string, normalized?: string}` (where `normalized` is a string like `"Month DD, YYYY"`). Update `EnhancedNormalizedDate` in the response to only include components (no `original`, no `note`). (Ref: `learnings/02_enhancement_plan.md` v1.7).
4.  **Action Configuration:** Configured API key authentication.

---

### Phase 4: Integration Testing & Refinement (Completed Pre-v1.7)

**Objective:** Tested the end-to-end flow and refined implementation based on results.

1.  **End-to-End Testing:** Performed various tests.
2.  **Refinement & Bug Fixing:** Addressed initial issues.

---

### Phase 5: Enhancements & Optimization (v1.7 - Current)

**Objective:** Improve date handling reliability and maintain query relevance.

1.  **(Obsolete) Previous Date Refactoring Attempts:** Versions older than v1.7 involved iterative refinement of pattern-matching within the Netlify function, which proved complex and incomplete. v1.7 adopts a new hybrid approach.

2.  **Implement Relevance Boosting (Completed v1.3):**
    *   **Status:** Implemented and remains the core query strategy. Relies on accurately stored date components. We should revise the weighting when we work on query mode again.

3.  **Non-Date Entity Extraction (Completed & Stable):**
    *   **Status:** Stable baseline. We should not implement changes to the store mode that would alter the way non-date entities are processed currently.

4.  **Refactor Date Parsing (Hybrid Approach - v1.7):**
    *   **Goal:** Achieve reliable date/time component extraction by leveraging upstream GPT normalization and targeted Netlify function logic.
    *   **Approach (v1.7 - Hybrid):** (Ref: `learnings/02_enhancement_plan.md` v1.7)
        1.  **GPT Task:** Update GPT instructions (`02_gpt_instructions.md`) to request normalized `"Month DD, YYYY"` dates alongside original strings when possible.
        2.  **Schema Update:** Update `openapi.json` to handle the new input/output date formats.
        3.  **Netlify Function (`memory-action.ts`):**
            *   Refactor date processing to prioritize parsing the GPT-provided `normalized` date (`"Month DD, YYYY"`) using `date-fns` (`parseNormalizedDate`).
            *   Implement separate, focused logic (`extractTimeInfo`) using regex/`chrono-node` (time only) to extract time information (period, HH:MM) from the `original` string.
            *   Implement a new, clean function (`parseOriginalStringDate`) using only `date-fns` to attempt parsing dates the GPT couldn't normalize. This replaces complex legacy logic.
            *   Correct any "Past Month/Day" inference logic if applicable.
            *   Ensure only structured components (no `original` string) are stored in metadata.
    *   **Rationale:** Simplifies the main parsing path, focuses Netlify logic on specific tasks (normalized date parsing, time extraction, simple original string parsing), maintains components needed for v1.3 query relevance, accepts limitations for ambiguous dates not normalized by GPT.
    *   **Status:** **Planned (Current Phase).**

5.  **Future Considerations (Backlog):**
    *   Advanced Retrieval (Hybrid search, time decay, more sophisticated boosting).
    *   Third-Party Date Parsing API (as fallback within `handleFallbackParsing` if needed).

---

### Phase 6: Documentation & Launch (Pending)

1.  **Final Checks:** Perform regression testing after v1.7 implementation, review security configurations.

--- 