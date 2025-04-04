# Security Considerations & Future Work

This document tracks security-related decisions made during development and items that require future attention or review.

## RLS Status & Service Key Usage

1.  **RLS Temporarily Disabled on `files` Table:**
    *   **Status:** RLS on `public.files` was disabled during Phase 2 troubleshooting (Apr 3rd) to isolate permission errors.
    *   **Reason:** To confirm if RLS policies were unexpectedly interfering with the `service_role` key.
    *   **Action Required:** Re-enable RLS on the `files` table after confirming the basic `'store'` and `'query'` modes work correctly with RLS disabled.

2.  **`service_role` Key Usage & `GRANT` Commands:**
    *   **Decision:** The Netlify function (`memory-action.ts`) uses the Supabase `service_role` key (via `SUPABASE_SERVICE_ROLE_KEY` env var). This was chosen to simplify backend logic by bypassing RLS checks within the function context (suitable for the initial single-user-per-deployment model).
    *   **Associated Action:** `GRANT` commands were executed (Apr 3rd) to provide necessary default privileges (`USAGE` on schema, `ALL PRIVILEGES` on `files` and `transcript_embeddings`) to the `postgres` and `service_role` roles. This was required because the service role lacked permissions even *without* RLS.
    *   **Associated Action 2:** `GRANT EXECUTE` command was executed (Apr 4th) on the `search_memory_chunks` function for `postgres` and `service_role`. This is required for the function to call the RPC.
    *   **Implication:** These `GRANT` commands (table privileges and function execute) are likely **permanent requirements** for the function to operate correctly *when using the service key* on these specific objects. They are not temporary bypasses to be reverted unless the core architectural decision to use the service key changes.

3.  **Missing `user_id` Insertion:**
    *   **Issue:** The current `memory-action.ts` function logic does **not** insert the `user_id` into the `files` table, even when provided in the payload. This was identified during analysis of a successful partial insert (Apr 3rd).
    *   **Impact:** While the service key bypasses RLS checks *now*, the lack of `user_id` on records hinders proper data ownership tracking and would prevent user-specific RLS policies from working correctly if the service key was not used.
    *   **Action Required:** Modify `memory-action.ts` to correctly retrieve and insert the `user_id` into the `files` table during the `'store'` operation. Ensure the provided `user_id` corresponds to a valid entry in the `users` table, especially if moving away from the service key later.

## Other RLS Considerations

1.  **RLS Disabled on `users` Table:**
    *   **Status:** Screenshots from Apr 3rd indicated that RLS was disabled on the `public.users` table.
    *   **Impact:** As noted by the Supabase warning, this makes the table publicly readable and writable via the anonymous key.
    *   **Action Required:** Enable RLS on the `users` table and define appropriate security policies (e.g., users can only view/update their own record).

---

## Phase 3 Update (Apr 4, 2025)

*   Phase 3 (Custom GPT Configuration) completed.
*   Action authentication configured using API Key (`x-api-key`). This secures the Netlify function *endpoint* but does not change the backend authorization model.
*   The primary remaining security consideration is the Netlify function's continued use of the Supabase `service_role` key, which bypasses RLS. This is acceptable for the current single-user testing phase but should be revisited for potential multi-user scenarios or stricter RLS enforcement requirements in the future (e.g., potentially using OAuth and passing user tokens to Supabase). 