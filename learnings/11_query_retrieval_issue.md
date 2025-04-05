# Phase 4 - Investigation: Query Retrieval Failures

## Problem Summary (As of Apr 4 Evening - Updated Apr 5)

Following fixes to the `memory-action` Netlify function's error handling:

1.  **Storage Success:** Storing new memories appears reliable.
2.  **Consistent Query Failure (Dual System):** Retrieval using the `query' mode consistently fails:
    *   General and specific queries return no results.
    *   **Crucially, neither the primary vector search nor any potential fallback mechanism (e.g., direct text search) seems to be returning relevant data.** The Netlify function logs indicate empty `retrieved_context`.
3.  **False Negatives:** The GPT correctly reports it cannot find information because the `memory-action` provides no context.

## Hypothesis (Expanded)

The issue likely stems from one or more of the following areas within the retrieval pipeline:

*   **Supabase `search_memory_chunks` SQL Function:** Logic issues (vector comparison, filtering, ordering, limiting).
*   **Parameters Passed to SQL Function:** Incorrect `query_embedding`, `match_threshold`, `match_count`, or crucially, potential issues with shared filters like `user_id`.
*   **Netlify Function Orchestration:** The function might incorrectly sequence calls, mishandle errors/empty results from Supabase, or fail to execute the fallback logic correctly.
*   **Row Level Security (RLS) / Permissions:** RLS policies on `files` or `transcript_embeddings` might prevent the Netlify function's role from accessing the required data for *both* vector and fallback searches.
*   **Data Integrity:** The specific data being queried might be missing corresponding entries in `files` or `transcript_embeddings`, or have inconsistent identifiers.
*   **Vector Index (`ivfflat`):** Less likely, but potential issues with index health or updates.

## Diagnostic Checklist (Replaces Previous "Investigation Plan" / "Next Steps")

To systematically pinpoint the failure, we need to gather the following information:

**I. Netlify (`memory-action` Function)**

*   **Goal:** Understand execution flow, parameters, and results for `'query'`.
*   **Actions:**
    1.  **(User Task)** Trigger several failed `'query'` requests (general & specific).
    2.  **(User Task)** Collect complete, verbose Netlify function logs (`debug-logs/netlify-function-log.txt`) showing: `query_text`, generated `query_embedding`, exact parameters sent to *all* Supabase calls (RPC and direct table queries), raw responses (`data`/`error`) from Supabase, fallback logic execution, and final `retrieved_context`.
    3.  **(User Task)** Verify Netlify Node.js runtime version.
    4.  **(User Task)** Confirm Supabase URL/Key environment variables.

**II. Supabase (SQL & Database)**

*   **Goal:** Verify SQL logic, test manually, check data/permissions.
*   **Actions:**
    1.  **(AI Task)** Review `search_memory_chunks` definition in `sql/schema.sql` (parameters, vector logic, filtering, ordering).
    2.  **(User Task)** Execute `search_memory_chunks` manually in SQL Editor with known embeddings and varying thresholds. Provide queries & results.
    3.  **(AI Task)** Review `sql/schema.sql` for potential fallback SQL functions.
    4.  **(User Task)** Manually test fallback SQL functions or simulate Netlify's direct table queries (e.g., `SELECT ... FROM files WHERE ...`). Provide queries & results.
    5.  **(User Task)** Check Supabase query logs/history for actual queries executed by Netlify during failures.
    6.  **(User Task)** Verify data integrity: Check specific `file_id`s exist in both `files` and `transcript_embeddings` for failed query targets.
    7.  **(User Task)** Review RLS policies on `files` and `transcript_embeddings`. Provide definitions if enabled.

**III. ChatGPT Integration**

*   **Goal:** Confirm correct action usage (Lower priority).
*   **Actions:**
    1.  **(User Task - Optional)** Review GPT instructions for `memory-action` usage.

## Investigation Progress (Apr 5)

1.  **Detailed Netlify Logs Collected:**
    *   Confirmed Netlify function `memory-action` (Node.js v22.x) receives queries, generates embeddings, and calls Supabase `search_memory_chunks` RPC successfully (no connection/auth errors).
    *   Supabase RPC call consistently returns `data: []` (empty results) even for valid query embeddings.
    *   Conclusion: Netlify function -> Supabase connection is working; issue is within Supabase search/data.
2.  **Schema Review:**
    *   `search_memory_chunks` function logic seems correct for cosine similarity search.
    *   No fallback SQL functions identified.
    *   RLS is enabled but bypassed by service key; not the issue.
3.  **HNSW Index Verified:**
    *   Manual check in Supabase SQL Editor confirmed the `transcript_embeddings_embedding_hnsw_idx` HNSW index exists and uses the correct `vector_cosine_ops`.
4.  **Manual SQL Function Test Attempt:**
    *   Attempting to run `search_memory_chunks` directly in Supabase SQL Editor with a full query embedding copied from Netlify logs failed with `ERROR: 22000: expected 1536 dimensions, not 164`.
    *   **Hypothesis:** The Supabase SQL Editor UI is likely truncating the very long vector literal string pasted into the query input field, causing the dimension mismatch error.

## Next Steps (As of end of Apr 5 session)

1.  **Confirm SQL Editor Input Truncation:** Manually inspect the SQL query *in the editor window* after pasting the full embedding but *before* running, to see if the vector array or query text appears truncated.
2.  **If Truncated:** Execute the manual `search_memory_chunks` test using an alternative method that bypasses SQL Editor UI limits (e.g., `psql` via Supabase CLI, or a desktop SQL client connected to the database).
3.  **If Not Truncated (or alternative method used):**
    *   Run the `search_memory_chunks` query with a known embedding and `match_threshold := 0.1`.
    *   If results are returned, incrementally increase the threshold (0.5, 0.7, 0.75, 0.8) and record results/performance.
    *   If no results are returned even at 0.1 threshold, investigate data integrity (Step II.6 - do relevant embeddings exist?) and potentially data quality (are stored embeddings genuinely not similar to the query?).

---

## Debugging Session Summary (2025-04-05)

**Objective:** Test `search_memory_chunks` directly using Supabase CLI/psql to bypass potential SQL Editor limitations and diagnose empty results.

**Steps & Findings:**

1.  **Supabase CLI Setup & Initial Connection Attempts:** See previous summary for details on CLI install, login, link, and initial `psql` failures due to DNS issues with `db.*` hostname.
2.  **IPv6 / Pooler Investigation:**
    *   Identified GitHub Discussion ([https://github.com/orgs/supabase/discussions/20951](https://github.com/orgs/supabase/discussions/20951)) and Supabase UI warnings indicating the `db.*` hostname is often IPv6 only and incompatible with some networks.
    *   Located the **Shared Pooler** connection string using the IPv4-compatible hostname: `aws-0-eu-central-1.pooler.supabase.com` (Port `5432`).
    *   **Successfully connected** to the database using `psql` with the Shared Pooler URI.

3.  **Direct SQL Function Test (Interactive `psql`):**
    *   Attempted to execute `SELECT * FROM public.search_memory_chunks(...)` interactively in `psql` with the embedding from Netlify logs and `match_threshold := 0.1`.
    *   **Result:** Failed with `ERROR: different vector dimensions 1536 and 164`. This suggests the long vector literal string was truncated by the interactive terminal input.

4.  **RLS Linter Warnings Resolved:** (Details in previous summary). User needs to apply `CREATE POLICY` statements via SQL Editor.

**Conclusion & Next Step (To Resume):**

*   The direct database connection issue was resolved by using the **Shared Pooler connection string** (`aws-0-...pooler.supabase.com:5432`).
*   The interactive `psql` execution failed due to apparent **truncation of the long vector literal**.
*   **The next step is to execute the exact same `search_memory_chunks` SQL query from a file** using `psql -f <filename>` to avoid interactive input limits.
*   This will finally allow us to see if the function returns *any* results with a low threshold, helping to isolate whether the issue is the SQL logic, the data, the index, or the parameters used by the Netlify function.

**Next Steps (Resume Session):**
1.  **(User Task - If not done)** Apply the RLS `CREATE POLICY` statements in the Supabase SQL Editor.
2.  Create a file named `test_query.sql` containing the full `SELECT * FROM public.search_memory_chunks(...)` command with the correct embedding and parameters.
3.  Execute the query file using `psql 'POOLER_URI' -f test_query.sql`.
4.  Analyze the results (or lack thereof).

---

## Debugging Session Summary & Conclusion (2025-04-05 - PM Session)

**Objective:** Isolate the cause of empty results from `search_memory_chunks`.

**Steps & Findings:**

1.  **Basic Table Access Confirmed:** Successfully queried `public.files` via Supabase SQL Editor, confirming basic connectivity and data existence.
2.  **Data Integrity Confirmed:** Verified that a specific test file (`id: b8ce080c...`) has a corresponding entry (`count: 1`) in `public.transcript_embeddings`.
3.  **Log Analysis (Netlify & Supabase):**
    *   Netlify logs confirmed the `memory-action` function generates a query embedding and calls `search_memory_chunks` RPC with correct parameters (`threshold: 0.75`, `count: 5`).
    *   Netlify logs consistently show the RPC call returning `data: []` with `error: null`.
    *   Supabase logs (Postgres, PostgREST) confirm successful RPC calls (HTTP 200) without internal SQL errors reported during function execution.
4.  **Direct SQL Execution Attempts (`psql`, GUI Client):**
    *   Multiple attempts to execute `search_memory_chunks` or direct similarity queries using the vector *string literal* (copied from Netlify logs) via `psql` (with `-f`, `-v`) and the Supabase SQL Editor consistently failed with `ERROR: different vector dimensions 1536 and 68`.
    *   This error occurred *before* the core similarity logic ran, pointing to a persistent issue within the PostgreSQL backend/pgvector extension when parsing or casting that specific, very long string literal as a `vector(1536)` parameter/input.
5.  **Stored Dimension Verification:** Successfully queried `vector_dims(embedding)` on `transcript_embeddings` via SQL Editor, confirming stored vectors **correctly have 1536 dimensions**.

**Conclusion:**

*   The `dimension 1536 and 68` error encountered during direct SQL tests is a **red herring**. It's an artifact of how the backend parses the extremely long vector *string literal* and is *not* indicative of the actual stored data or the vector passed via the Supabase JS client RPC.
*   Stored embeddings have the correct 1536 dimensions.
*   The Netlify function successfully calls the `search_memory_chunks` RPC, passing the full 1536-dimension vector (likely via a non-literal mechanism within the JS library).
*   The function executes without dimension errors on the backend *when called via RPC*, but returns no results (`data: []`).
*   The most likely cause of the empty results is that the `match_threshold` of `0.75` used in the function was **too high**, causing the similarity condition `1 - (te.embedding <=> query_embedding) > 0.75` to evaluate to false for all stored chunks.
*   **Additionally, the lack of an implemented fallback search mechanism (querying the `files` table directly) meant that queries unsuitable for semantic search (e.g., keyword counting, specific metadata filtering) would fail even if relevant data exists.**

**Resolution Attempted:**

*   Lowered `VECTOR_MATCH_THRESHOLD` constant in `netlify/functions/memory-action/memory-action.ts` from `0.75` to `0.5`. This successfully enabled retrieval for semantic queries.

**Next Steps:**

1.  Deploy the updated Netlify function with the lower threshold.
2.  Test querying via the Custom GPT interface.
3.  Verify if results are now returned in the GPT response and check Netlify logs for `retrieved_context` content.
4.  **Implement Fallback Search:** Modify the `memory-action` function to include logic that queries the `files` table (e.g., using `ILIKE` on `transcript_text` or filtering `file_metadata`) when the initial vector search returns no results.
    *   **(Plan for Next Session):** Implement a combined approach: attempt filtering based on `file_metadata` using extracted entities, and also perform a keyword search (e.g., `ILIKE`) on `transcript_text`.
5.  Test queries that rely on keyword or metadata matching.

---

## Debugging Session Summary (2025-04-04)

**Objective:** Test `search_memory_chunks` directly using Supabase CLI/psql to bypass potential SQL Editor limitations.

**Steps & Findings:**

1.  **Supabase CLI Setup:**
    *   Installed Supabase CLI using Homebrew (`brew install supabase/tap/supabase`).
    *   Successfully logged in (`supabase login`).
    *   Successfully linked the project (`supabase link --project-ref vmmpodvzidqucxgizpoi`).

2.  **Direct Database Connection Attempts (`psql`):**
    *   Attempted to connect using `psql` with both the "Direct connection" URI (`...:5432`) and the "Transaction pooler" URI (`...:6543`).
    *   **Result:** Both attempts failed consistently with `psql: error: could not translate host name "db.vmmpodvzidqucxgizpoi.supabase.co" to address: nodename nor servname provided, or not known`.

3.  **DNS Resolution Diagnosis:**
    *   `ping -c 4 db.vmmpodvzidqucxgizpoi.supabase.co` failed with `ping: cannot resolve ... Unknown host`.
    *   Flushing macOS DNS cache (`dscacheutil -flushcache`, `killall -HUP mDNSResponder`) did not resolve the issue.
    *   `dig @8.8.8.8 db.vmmpodvzidqucxgizpoi.supabase.co +short` returned no output.
    *   `dig @8.8.8.8 db.vmmpodvzidqucxgizpoi.supabase.co` (full output) confirmed `status: NOERROR`, but crucially `ANSWER: 0`. This indicates the authoritative DNS server for `supabase.co` is stating there is no A record for this specific hostname.

4.  **RLS Linter Warnings Resolved:**
    *   Added default permissive RLS policies (`ALLOW ALL USING (true)`) to `sql/schema.sql` for all tables with RLS enabled but no policies defined.
    *   **Action Required (User):** Apply these `CREATE POLICY` statements via the Supabase SQL Editor.

**Conclusion & Blocker:**

*   The inability to connect via `psql` is due to a **DNS resolution failure specific to the direct database hostname (`db.vmmpodvzidqucxgizpoi.supabase.co`)**. This is *not* a local network issue, as confirmed by `dig` against public DNS.
*   This DNS failure is separate from the API endpoint (`https://vmmpodvzidqucxgizpoi.supabase.co`) used by the Netlify function, which likely *is* resolving correctly (as evidenced by previous successful storage operations and recent API gateway logs showing successful health checks and CLI communication during this session).
*   **Direct database debugging using `psql` is currently blocked.** The `db.*` hostname resolution failure needs to be addressed by Supabase Support.
*   The original issue (empty results from `search_memory_chunks` called via the Netlify function) still requires investigation, but the primary debugging method (`psql`) is unavailable until the DNS issue is resolved.

**Next Steps (Post-Session):**
1.  **(User Task)** Contact Supabase Support regarding the DNS resolution failure for `db.vmmpodvzidqucxgizpoi.supabase.co`, providing the `dig` results.
2.  **(User Task)** Apply the RLS `CREATE POLICY` statements in the Supabase SQL Editor.
3.  Resume debugging of `search_memory_chunks` once direct database access is restored (or explore alternative debugging methods if necessary).

### `punycode` Deprecation Warning

**Observation:**
- Netlify function logs show `(node:9) [DEP0040] DeprecationWarning: The 'punycode' module is deprecated. Please use a userland alternative instead.`
- A search of the codebase (`grep_search`) did not find direct usage of `punycode`.
- Analysis of `package-lock.json` revealed no direct or obvious indirect dependency explicitly pulling in `punycode`.

**Hypothesis:** The warning might stem from:
- The Node.js runtime version configured for Netlify functions (Managed via Netlify UI as `netlify.toml` is not present).
- Implicit usage within core Node.js modules triggered by dependencies like `whatwg-url` (used by Supabase/OpenAI clients) during URL processing.

**Next Steps (Resume Tomorrow):**
1.  **Check Netlify Node.js Version:** Verify the Node.js version used for functions in the Netlify dashboard settings. Ensure it's a recent, supported version (e.g., Node 20+).
2.  **Update Dependencies:** Consider running `npm update @netlify/functions @supabase/supabase-js openai` locally, committing changes, and redeploying to potentially resolve the issue via updated sub-dependencies. (This is lower priority as it's only a warning for now). 