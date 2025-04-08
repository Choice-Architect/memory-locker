# Metadata Enhancement Suggestions (v1)

**Goal:** Enhance the Memory Locker GPT Action by incorporating additional metadata to enable more sophisticated storage and retrieval capabilities.

---

## 1. Priority (Explicit 1-10)

**Objective:** Allow users to explicitly assign a priority level (1-10) to stored memories for later filtering/sorting.

**Implementation Steps:**

*   **GPT Instructions (`learnings/02_gpt_instructions.md`):**
    *   Instruct the GPT to look for explicit priority assignments in the user's input (e.g., "Remember this, priority 9", "Store this as priority level 7").
    *   Specify that if a priority is found, it should be included as an integer between 1 and 10 in the `extracted_entities`.
*   **OpenAPI Schema (`openapi.json`):**
    *   Modify the `ExtractedEntities` schema definition within `components.schemas`.
    *   Add an optional `priority` field:
        ```json
        "priority": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10,
          "description": "User-assigned priority level (1-10, 10 = highest)"
        }
        ```
*   **Netlify Function (`memory-action.ts`):**
    *   In the `store` / `combined` mode logic:
        *   Check if `payload.extracted_entities.priority` exists and is valid.
        *   Include the `priority` value within the `fileMetadata` object that gets saved to the `files.file_metadata` JSONB column.
    *   In the `query` / `combined` mode logic (Fallback Search):
        *   Modify the fallback query builder.
        *   If the user's query includes priority criteria (e.g., "Show priority 9 notes"), add a filter condition targeting `file_metadata->>'priority'`. (Requires careful GPT instruction on how users should query priority).
        *   Consider adding priority to the `ORDER BY` clause for relevant queries.
*   **Database (`files` table):**
    *   No schema change needed (using JSONB `file_metadata`).
    *   *Optional:* Consider adding a GIN index on `file_metadata` if priority-based queries become frequent and performance is an issue: `CREATE INDEX idx_files_metadata_gin ON files USING gin (file_metadata);`

---

## 2. Relationship Linking (Conversation/Thread ID)

**Objective:** Link memories created within the same conversation thread for contextual retrieval.

**Implementation Steps:**

*   **GPT Instructions (`learnings/02_gpt_instructions.md`):**
    *   **CRITICAL:** Investigate if the ChatGPT environment reliably provides a stable `conversation_id` or `thread_id` accessible to the Custom GPT during an interaction. This is currently **UNCLEAR** and the biggest risk/dependency for this feature.
    *   *Assuming IDs are available:* Instruct the GPT to retrieve the current `conversation_id` and/or `thread_id` from its context.
    *   Instruct the GPT to include these IDs in the `extracted_entities`.
*   **OpenAPI Schema (`openapi.json`):**
    *   Modify the `ExtractedEntities` schema.
    *   Add optional `conversation_id` and `thread_id` fields:
        ```json
        "conversation_id": {
          "type": "string",
          "description": "Identifier for the ongoing conversation session (if available)"
        },
        "thread_id": {
           "type": "string",
           "description": "Identifier for a specific topic thread within a conversation (if available and distinct)"
        }
        ```
*   **Netlify Function (`memory-action.ts`):**
    *   In the `store` / `combined` mode logic:
        *   Check for `payload.extracted_entities.conversation_id` and `thread_id`.
        *   Retrieve the corresponding column names from your `files` table schema (confirm they exist as user stated).
        *   Include these IDs in the main `fileInsertData` object for the `files` table insert (e.g., `fileInsertData.conversation_id = payload.extracted_entities.conversation_id;`).
    *   In the `query` / `combined` mode logic:
        *   Update vector search (`search_memory_chunks` RPC): Does it need modification to accept/filter by these IDs? If not possible via RPC, filtering must happen *after* retrieval or in the fallback.
        *   Update fallback search: If the user asks to "find other notes from this conversation", the GPT needs to provide the *current* conversation ID in the query payload. The function then adds a `WHERE conversation_id = \'...\'` clause to the fallback query.
        *   **Note (Apr 9, 2025): Implementation of querying logic for conversation/thread IDs is postponed until after further testing.**
*   **Database (`files` table):**
    *   **Verify:** Confirm that columns named `conversation_id` and `thread_id` (or similar) already exist in the `files` table as text or appropriate types. If not, add them:
        ```sql
        ALTER TABLE files ADD COLUMN conversation_id TEXT;
        ALTER TABLE files ADD COLUMN thread_id TEXT;
        ```
    *   Add indexes if needed for performance:
        ```sql
        CREATE INDEX idx_files_conversation_id ON files (conversation_id);
        CREATE INDEX idx_files_thread_id ON files (thread_id);
        ```

---

## 3. Content Enrichment (Auto-Keywords)

**Objective:** Generate supplementary keywords automatically during storage to improve fallback search recall.

**Implementation Steps:**

*   **GPT Instructions (`learnings/02_gpt_instructions.md`):**
    *   No change needed. Keyword generation will happen in the Netlify function.
*   **OpenAPI Schema (`openapi.json`):**
    *   No change needed in the request payload. The keywords are generated *after* the request is received.
*   **Netlify Function (`memory-action.ts`):**
    *   In the `store` / `combined` mode logic, *before* inserting into `files`:
        *   Add logic to generate keywords from `payload.query_text`. Options:
            *   **Simple:** Use a basic NLP library (e.g., `natural` - already used for stemming, might have keyword extraction) to pull out significant words (excluding stop words).
            *   **Advanced (Optional):** Make a cheap/fast call to an LLM (like a smaller OpenAI model or potentially a dedicated keyword extraction API) to get keywords. *Consider cost/latency implications.*
        *   Store the generated keywords as an array of strings (e.g., `["budget", "meeting", "report"]`) within the `fileMetadata` object saved to `files.file_metadata` (e.g., `fileMetadata.auto_keywords = generatedKeywords;`).
    *   In the `query` / `combined` mode logic (Fallback Search):
        *   Modify the fallback query builder.
        *   Add a condition to search within the `auto_keywords` array in the `file_metadata` JSONB column. This typically involves JSONB operators like `?|` (exists any operator) or `@>` (contains operator). Example: `file_metadata->'auto_keywords' ?| array['keyword1', 'keyword2']`
*   **Database (`files` table):**
    *   No schema change needed (using JSONB `file_metadata`).
    *   Ensure the GIN index on `file_metadata` (suggested for Priority) is in place, as it will also accelerate searches on `auto_keywords`.

---

## 5. Language Support (en, fr, ar)

**Objective:** Store the language of the input text to potentially allow for language-specific filtering or processing.

**Implementation Steps:**

*   **GPT Instructions (`learnings/02_gpt_instructions.md`):**
    *   Instruct the GPT to detect the primary language of the `query_text`.
    *   Specify the expected output format (e.g., ISO 639-1 codes: `"en"`, `"fr"`, `"ar"`).
    *   Instruct it to include the detected language code in `extracted_entities.language`. Default to `"en"` if detection is uncertain or the language is unsupported.
*   **OpenAPI Schema (`openapi.json`):**
    *   Modify `ExtractedEntities` schema.
    *   Add an optional `language` field:
        ```json
        "language": {
          "type": "string",
          "enum": ["en", "fr", "ar"],
          "description": "Detected language of the query_text (ISO 639-1 code)"
        }
        ```
*   **Netlify Function (`memory-action.ts`):**
    *   In the `store` / `combined` mode logic:
        *   Check for `payload.extracted_entities.language`.
        *   Include the language code in `fileMetadata` (e.g., `fileMetadata.language = payload.extracted_entities.language || \'en\';`).
    *   In the `query` / `combined` mode logic (Fallback Search):
        *   **Note (Apr 9, 2025): Filtering by language during queries is NOT implemented.**
*   **Database (`files` table):**
    *   No schema change needed (using JSONB `file_metadata`).
    *   The GIN index will help index this field within the JSONB.

---

## 6. Future Suggestion: Time Specificity

**Objective:** Enhance date querying by understanding the precision of stored dates (e.g., knowing if "July 2024" refers to the whole month or just an unspecified day within it).

**Potential Implementation Idea:**

*   **Netlify Function (`memory-action.ts`):**
    *   Modify the `NormalizedDate` interface to include precision:
        ```typescript
        interface NormalizedDate {
            original: string;
            normalized: string | null; // ISO 8601
            precision?: 'year' | 'month' | 'day' | 'time'; // NEW FIELD
        }
        ```
    *   Enhance the `normalizeDateString` function: Based on the input format or keywords (e.g., "July 2024" vs "July 15th 2024" vs "yesterday afternoon"), determine the appropriate `precision` level and include it in the returned `NormalizedDate` object.
    *   Store this enhanced `NormalizedDate` object (with precision) within the `dates` array in `file_metadata`.
*   **Querying Logic:**
    *   When querying dates, use the stored `precision` information.
    *   Example: A query for "July 2024" could be interpreted as a range query covering the entire month. It would match stored dates where `normalized` falls within July AND `precision` is `'month'`, `'day'`, or `'time'`. It might *not* match a stored date like `"2024"` where `precision` is only `'year'`. This allows for more intelligent date range matching based on how specific the original date was.

---

## 7. Implementation Sequence (Suggested)

1.  **Priority & Due Date:** Relatively straightforward additions to existing structures. Implement together.
2.  **Language Support:** Also fairly simple, involves GPT detection and storing/filtering a simple string.
3.  **Relationship Linking:** Tackle this next, focusing heavily on verifying the availability and stability of `conversation_id`/`thread_id` from the GPT environment. If unavailable, this feature might need to be postponed or re-imagined.
4.  **Auto-Keywords:** Implement this after the others, as it involves adding a new generation step within the Netlify function. Decide on the generation method (library vs. LLM).
5.  **Review & Testing:** Thoroughly test all new metadata storage and querying capabilities.
6.  **Consider Time Specificity:** Evaluate if the benefits of implementing time specificity are needed based on testing the existing date normalization/querying.

---
