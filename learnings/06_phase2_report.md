# Phase 2: Core Action Development (Netlify Function) - Progress Report

**Status:** Tasks 2.1-2.4 Completed. Task 2.5 In Progress.

This document tracks the progress and decisions made during Phase 2 of the Memory Locker Custom GPT project.

## Phase 2 Tasks (from Roadmap):

1.  **API Endpoint Design (Task 2.1):**
    *   Status: **Completed**
    *   Details: Final API contract defined (see `learnings/01_new_gpt_roadmap.md` and `learnings/04_questions_to_answer.md`). Single action (`memory-action`) with modes (`store`, `query`, `combined`) approach confirmed.

2.  **Supabase Integration (Task 2.2):**
    *   Status: **Completed**
    *   Objective: Implement Supabase client initialization within the function using environment variables. Handle credentials securely.
    *   Details: The `memory-action.ts` file contains the necessary `createClient` initialization using `process.env.SUPABASE_URL` and `process.env.SUPABASE_SERVICE_ROLE_KEY`. Basic Action authentication using `ACTION_SECRET_KEY` is also present.

3.  **Database Logic Implementation (Task 2.3):**
    *   Status: **Completed**
    *   Objective: Implement functions for querying memories (vector search with filtering, fallback table search) and storing/upserting data (embedding generation, record creation in `files` and `transcript_embeddings`).
    *   Progress:
        *   Implemented storage logic (`store`/`combined` modes): Chunks text, creates `files` record, generates OpenAI embeddings (`text-embedding-3-small`), and stores chunks/embeddings/metadata in `transcript_embeddings`.
        *   Implemented query logic (`query`/`combined` modes): Generates query embedding, calls `search_memory_chunks` Supabase RPC function for vector search, and formats results.
        *   Created `search_memory_chunks` SQL function in Supabase database to handle efficient vector search.
        *   Corrected definition of `search_memory_chunks` after initial syntax error.

4.  **Error Handling & Logging (Task 2.4):**
    *   Status: **Completed (Initial Pass)**
    *   Objective: Implement robust error handling and basic logging within the Netlify function.
    *   Details: Basic `console.log`/`console.error` added. Main `catch` block refined to return more specific HTTP status codes (400, 401, 405, 500) based on error types.

5.  **Initial Deployment & Testing (Task 2.5):**
    *   Status: **In Progress**
    *   Objective: Deploy the function and test the endpoint directly.
    *   Progress:
        *   Initial deployment failed due to missing root `package.json`.
        *   Added root `package.json` and installed dependencies (`@supabase/supabase-js`, `openai`, `@netlify/functions`). Build succeeded.
        *   Cleaned up redundant nested `package.json` and `package-lock.json` from function directory.
        *   Resolved Supabase performance advisor warning by dropping duplicate HNSW index `transcript_embeddings_embedding_idx`.
        *   Testing `'store'` mode via `curl` initially failed due to incorrect `SUPABASE_SERVICE_ROLE_KEY` and `ACTION_SECRET_KEY` environment variables in Netlify.
        *   Corrected environment variables in Netlify and redeployed.
        *   Subsequent `curl` test failed with `{"error":"Failed to store file record: permission denied for schema public"}`.

## Key Decisions Made During Phase 2:

*   Confirmed use of a single GPT Action (`memory-action`) pointing to a single Netlify Function, using a `mode` parameter to differentiate operations.
*   Finalized the API contract (input/output JSON structure) for the `memory-action` function.
*   Confirmed use of Supabase RPC (`search_memory_chunks`) for efficient vector search.

## Next Steps / Pause Point (Apr 2nd Evening):

*   **Investigate and resolve the `permission denied for schema public` error encountered during the `store` operation test.**
    *   Primary focus: Check Row Level Security (RLS) status on the `public.files` table in Supabase. Temporarily disable if active to see if it resolves the issue (indicating an unexpected interaction with the service key).
    *   Secondary focus: If RLS is not the cause, consider resetting default privileges for the `public` schema using the `GRANT` commands previously discussed.
*   Once the permission error is resolved, re-test the `'store'` mode via `curl`.
*   If `'store'` mode succeeds, proceed to test `'query'` mode via `curl`.
*   Address the Supabase performance advisor warning: "Function Search Path Mutable" for `search_memory_chunks` by setting `search_path` explicitly within the function definition (lower priority). 

## Update (Apr 3rd): Troubleshooting Curl Tests

*   First `curl` test failed with `{"error":"Unauthorized"}` due to sending the API key in the `Authorization: Bearer` header instead of the `x-api-key` header expected by the function.
*   Second `curl` test (with corrected `x-api-key` header) failed with `{"error":"Expected property name or '}' in JSON at position 1 (line 1 column 2)"}`. This indicates a JSON parsing error, likely due to shell escaping issues with the `-d` payload.
*   **Next Troubleshooting Step:** Create a temporary `payload.json` file and use `curl -d @payload.json` to ensure correct JSON formatting for the next test. 

## Update (Apr 3rd - Continued): Resolving 'store' Mode Errors

*   Third `curl` test (using `payload.json`) bypassed JSON parsing error but revealed original `permission denied for schema public` error for `files` table, even with RLS disabled.
*   Executed `GRANT` commands to ensure `service_role` had privileges on `public` schema and `files` table.
*   Fourth `curl` test failed with `null value in column "id" of relation "files" violates not-null constraint`.
    *   **Fix:** Updated `sql/schema.sql` and ran `ALTER TABLE files ALTER COLUMN id SET DEFAULT gen_random_uuid();`.
*   Fifth `curl` test failed with `violates check constraint "files_file_type_check"`.
    *   **Fix:** Updated `sql/schema.sql` and ran `ALTER TABLE files DROP CONSTRAINT files_file_type_check;`, `ALTER TABLE files ADD CONSTRAINT files_file_type_check CHECK (file_type IN ('audio', 'image', 'document', 'gpt_interaction'));`.
*   Sixth `curl` test partially succeeded: Inserted into `files` table but failed inserting into `transcript_embeddings` with `Could not find the 'chunk_text' column`. 
    *   **Fix:** Corrected column name in `memory-action.ts` insert preparation from `chunk_text` to `content_chunk`. Deployed change.
*   Audited function code against schema. Found discrepancy in RPC result processing: code expected `row.chunk_text` but schema implies `row.content_chunk` from `transcript_embeddings`.
    *   **Fix:** Corrected column name in `memory-action.ts` result mapping. Deployed change.
*   Identified that `transcript_embeddings.file_id` allowed NULLs, contradicting requirement for mandatory link to `files`.
    *   **Fix:** Updated `sql/schema.sql` and ran `ALTER TABLE transcript_embeddings ALTER COLUMN file_id SET NOT NULL;`.

## Current Status & Next Steps (End of Session):

*   All identified schema/code discrepancies related to the 'store' operation have been addressed and deployed.
*   Database schema (`sql/schema.sql`) is updated.
*   RLS on the `files` table is still **disabled** for testing.
*   **Next action:** Run the `curl` command for `'store'` mode again to verify the end-to-end storage flow works.
*   If 'store' mode succeeds, re-enable RLS on the `files` table and test again.
*   Then, proceed to test `'query'` mode via `curl`.

## Update (Apr 3rd - End of Session Prep):

*   Netlify function redeployment completed successfully after committing latest code fixes.
*   Temporary `payload.json` file used for curl testing was deleted.

## Update (Apr 4th): Testing Query Mode

*   Ran `curl` test for `'store'` mode after re-enabling RLS on `files` table. **Success!** Confirmed service key bypasses RLS correctly.
*   Ran `curl` test for `'query'` mode. Failed with `{"query_source":"error","message_for_gpt":"Error searching memories."}`.
*   Hypothesis: Missing `EXECUTE` permission on the `search_memory_chunks` RPC function for the `service_role`.
*   **Action:** Executed `GRANT EXECUTE ON FUNCTION public.search_memory_chunks(...) TO service_role;`.
*   **Next Step for Next Session:** Re-run the `curl` command for `'query'` mode to see if granting execute permission resolved the issue. If not, investigate RPC function definition and parameters.

## Update (Apr 4th): Endpoint Confirmation & Next Steps

*   Further testing revealed that the correct Netlify function endpoint URL is `https://memory-locker-gpt.netlify.app/.netlify/functions/memory-action`, not the previously assumed `/api/memory-action` path.
*   The successful 'store' mode test mentioned earlier was likely performed manually, but the endpoint used at that time is unconfirmed.
*   The immediate next step is to test `'query'` mode using the confirmed `/.netlify/functions/` endpoint.
*   If the `'query'` mode test succeeds, we should also re-run a `'store'` mode test using the confirmed endpoint to ensure full verification before concluding Phase 2. 