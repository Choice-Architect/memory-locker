## Test Plan: Memory Locker GPT

### Category 1: `store` Mode Tests

**Objective:** Verify accurate storage, entity extraction, metadata processing (including new fields), and chunking/embedding.

*   **S01: Simple Story Storage**
    *   **Goal:** Test basic storage and simple entity extraction (person, location, sentiment).
    *   **Sample Input:** "Okay, just got back from the park with Leo, you won't believe what happened. He saw a squirrel and started barking at it, thinking it was a dog! It was absolutely hilarious, I couldn't stop laughing."

*   **S02: Dictated Note with Topics & Organization**
    *   **Goal:** Test storage of a longer note simulating dictation, involving topics and organizations. Check `type: dictated_note` (or similar).
    *   **Sample Input:** "Alright, take this down: meeting notes from the sync with the Marketing team about the Q3 campaign launch. Key takeaway is we need to finalize the budget allocation by next Wednesday. Action item for me is to draft the proposal. Also, Sarah mentioned needing the latest analytics report."

*   **S03: Task Storage with Priority & Due Date (Relative)**
    *   **Goal:** Test storing a task with explicit priority and a relative due date, verifying `priority` and `normalized_due_date` storage. Check `type: task`.
    *   **SampleInput:** "Add a task for me: follow up with John about the server migration plan. Make this priority 8. It needs to be done by EOD tomorrow."

*   **S04: Storage with Specific Date & Location**
    *   **Goal:** Test storage involving a specific date and location, verifying `dates` (normalized) and `locations` extraction.
    *   **Sample Input:** "Remember that on July 15th, 2024, I had that amazing dinner at 'The Italian Place' downtown. The pasta carbonara was incredible. I went there with Emily."

*   **S05: Storage in French with Language Detection**
    *   **Goal:** Test storage of content in French, verifying `language: fr` is stored in metadata.
    *   **Sample Input:** "N'oublie pas que j'ai une réunion importante avec l'équipe de Paris demain matin à 9h. C'est à propos du nouveau projet 'Soleil'. C'est très urgent." (Translation: Don't forget I have an important meeting with the Paris team tomorrow morning at 9am. It's about the new project 'Soleil'. It's very urgent.)

*   **S06: Storage in Arabic with Language Detection**
    *   **Goal:** Test storage of content in Arabic, verifying `language: ar` is stored in metadata.
    *   **Sample Input:** "تذكير: يجب عليّ الاتصال بوالدتي مساء اليوم للاطمئنان عليها. لا تنسى أيضًا شراء الحليب والخبز في طريق عودتك إلى المنزل." (Translation: Reminder: I must call my mother this evening to check on her. Also don't forget to buy milk and bread on your way home.)

*   **S07: Storage with Potential Auto-Keyword Generation**
    *   **Goal:** Test storage of text with distinct keywords to check if `auto_keywords` are generated and stored appropriately in `file_metadata`.
    *   **Sample Input:** "Thinking about the cloud infrastructure migration project... we need to consider scalability, cost optimization, security compliance, and vendor selection. The timeline is aggressive, especially the data transfer phase."

*   **S08: Storage with Ambiguous Date for Normalization**
    *   **Goal:** Test how a less specific date like "last month" is normalized and stored.
    *   **Sample Input:** "I finished reading that book 'Project Hail Mary' sometime last month, I think towards the end. It was a fantastic read, highly recommend it."

*   **S09: Storage with High Priority & Specific Due Date Format**
    *   **Goal:** Test priority 10 and a different date format.
    *   **Sample Input:** "This is critical, priority 10: Submit the final grant proposal document. The absolute deadline is 2025-08-20. No extensions possible."

---

### Category 2: `query` Mode Tests

**Objective:** Verify retrieval accuracy using both vector and fallback search, test filtering capabilities based on standard and new metadata fields.

*   **Q01: Simple Retrieval (Vector Search Expected)**
    *   **Goal:** Retrieve a recently stored simple memory based on semantic meaning. Use details from `S01`.
    *   **Sample Input:** "What was that funny thing Leo did at the park recently?"

*   **Q02: Keyword Retrieval (Fallback Search Expected)**
    *   **Goal:** Retrieve a memory based on specific keywords likely requiring fallback search. Use details from `S02`.
    *   **Sample Input:** "What was the action item for me regarding the Q3 campaign budget?"

*   **Q03: Priority-Based Query**
    *   **Goal:** Retrieve tasks or notes based on a specific priority level. Use details from `S03` / `S09`.
    *   **Sample Input:** "Show me my priority 8 tasks." OR "What are my highest priority items?" (Check logs to see if priority 10 is filtered).

*   **Q04: Due Date Query (Range)**
    *   **Goal:** Retrieve items based on a due date range, testing fallback filtering on `normalized_due_date` or potentially `created_at`. Use details from `S03` / `S09`.
    *   **Sample Input:** "What tasks are due by the end of next week?"

*   **Q05: Language-Based Query**
    *   **Goal:** Retrieve notes specifically stored in French, testing fallback filtering on `language`. Use details from `S05`.
    *   **Sample Input:** "Quelles sont mes notes en français sur le projet Soleil?" (Translation: What are my notes in French about the Soleil project?)

*   **Q06: Date-Based Query (Specific Normalized Date)**
    *   **Goal:** Retrieve information linked to a specific normalized date. Use details from `S04`.
    *   **Sample Input:** "What happened on July 15th, 2024?"

*   **Q07: Date-Based Query (Relative - `created_at` Fallback Expected)**
    *   **Goal:** Retrieve information stored within a relative timeframe, likely testing the `created_at` filter in the fallback search.
    *   **Sample Input:** "What notes did I dictate yesterday?"

*   **Q08: Combined Entity Query (Vector or Fallback)**
    *   **Goal:** Retrieve information using multiple entities (person, topic, potentially date). Use details from `S02`.
    *   **Sample Input:** "What did Sarah need regarding the Q3 campaign?"

*   **Q09: Query using Auto-Keywords (Fallback Expected)**
    *   **Goal:** Retrieve information using keywords expected to be in `auto_keywords`, testing the fallback search path. Use details from `S07`.
    *   **Sample Input:** "Tell me about my notes concerning cloud security compliance and cost optimization."

*   **Q10: Retrieval by Conversation/Thread ID (Requires Manual Input)**
    *   **Goal:** Test filtering by conversation/thread ID (if the GPT includes it in the payload). **Note:** You might need to manually find a `conversation_id` or `thread_id` from a previous `store` operation's `files` table entry and include it in your query like this:
    *   **Sample Input:** "What else did I mention in the conversation with ID [Paste Conversation ID here]?" OR "Summarize thread [Paste Thread ID here]." (Check if the function filters correctly).

---

### Category 3: `combined` Mode Tests

**Objective:** Verify the system correctly handles inputs that contain both information to store and a query, processing both aspects in a single action call.

*   **C01: Store New Info & Query Related Topic**
    *   **Goal:** Store a new piece of information while asking about something previously stored on the same topic. Use details from `S02`.
    *   **Sample Input:** "Okay, also remember that Mark from Finance approved the preliminary Q3 budget numbers today. Now, remind me, what was the exact deadline Sarah mentioned for the analytics report?"

*   **C02: Store Task with Priority & Query Different Priority**
    *   **Goal:** Store a new task with priority and ask about existing tasks of a different priority. Use details from `S03`.
    *   **Sample Input:** "Add another task: Draft the agenda for the project kickoff meeting, make it priority 5. By the way, what other priority 8 items do I have?"

*   **C03: Store French Note & Query English Topic**
    *   **Goal:** Test storing in one language while querying in another, checking metadata handling. Use details from `S05`.
    *   **Sample Input:** "Le rapport final pour le projet 'Soleil' est maintenant terminé et prêt à être envoyé. Also, what was that funny thing Leo did at the park last week?"

---