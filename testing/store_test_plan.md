# Memory Locker - Store Action Test Plan (v1.0)

**Objective:** Verify the correct functioning of the `store` action mode, including entity extraction by the GPT, date parsing, embedding generation, and data storage in Supabase (`files` and `transcript_embeddings` tables) with all associated metadata.

**Testing Procedure:**
For each test case:
1.  Provide the `Input Text` to the Custom GPT. Ensure the GPT understands it's a storage request (e.g., "Remember this:", "Store this memory:", or rely on the default `store` mode).
2.  Record the `Actual GPT Response`.
3.  Record relevant `Netlify Log Snippets` for the function invocation.
4.  Export and record the corresponding row(s) from the `files` table in Supabase.
5.  Export and record the corresponding rows from the `transcript_embeddings` table in Supabase.
6.  Record any relevant `Supabase Logs` if errors occur or specific function calls are being monitored.
7.  Compare the actual results against the `Expected GPT Behavior` and `Expected Backend State`.

---

## Test Cases:

**Test Case 1: Basic Entry with Entities**

*   **Objective:** Test basic entity extraction (person, location, topic, date) and storage.
*   **Input Text:** "I had a productive meeting with Sarah Chen at the downtown Starbucks yesterday afternoon about the Q3 marketing strategy."
*   **Expected GPT Behavior:**
    *   `mode`: `store`
    *   `people`: ["Sarah Chen"]
    *   `locations`: ["downtown Starbucks"]
    *   `topics`: ["Q3 marketing strategy"]
    *   `dates`: ["yesterday afternoon"] (String format for GPT)
    *   `type`: "meeting" (or similar inference)
    *   `sentiment`: "positive" / "neutral" (inference)
    *   `language`: "en" (default or inferred)
    *   `priority`: None specified (should be null or omitted)
*   **Expected Backend State:**
    *   `files` table: 1 row with input text, correct `file_metadata` (including `people`, `locations`, `topics`, `type`, `sentiment`, `language`, and an `EnhancedNormalizedDate` object for "yesterday afternoon" in `dates`).
    *   `transcript_embeddings` table: 1+ rows linked to the file, each with embedding, `chunk_index`, and mirrored `metadata` (including the `EnhancedNormalizedDate`).

---

**Test Case 2: Multiple Entities & Relative Date**

*   **Objective:** Test handling of multiple entities of the same type and a more specific relative date.
*   **Input Text:** "Remind me that John Smith and Emily White are presenting the Project Alpha findings next Tuesday morning in Conference Room B."
*   **Expected GPT Behavior:**
    *   `mode`: `store`
    *   `people`: ["John Smith", "Emily White"]
    *   `locations`: ["Conference Room B"]
    *   `topics`: ["Project Alpha findings"]
    *   `dates`: ["next Tuesday morning"]
    *   `type`: "reminder" / "presentation" (inference)
    *   `sentiment`: "neutral" (inference)
    *   `language`: "en"
    *   `priority`: None
*   **Expected Backend State:**
    *   `files` table: Correct `file_metadata` with lists for `people`, `locations`, `topics`, `type`, `sentiment`, `language`, and an `EnhancedNormalizedDate` for "next Tuesday morning".
    *   `transcript_embeddings` table: Correct embedding(s) and mirrored `metadata`.

---

**Test Case 3: Specific Date & Time**

*   **Objective:** Test parsing of a specific date and time.
*   **Input Text:** "The server maintenance window is scheduled for April 28th, 2025, from 2:00 AM to 4:00 AM UTC."
*   **Expected GPT Behavior:**
    *   `mode`: `store`
    *   `dates`: ["April 28th, 2025, from 2:00 AM to 4:00 AM UTC"]
    *   `topics`: ["server maintenance window"]
    *   `type`: "schedule" / "maintenance" (inference)
    *   `sentiment`: "neutral"
    *   `language`: "en"
    *   `priority`: None
*   **Expected Backend State:**
    *   `files` table: `file_metadata.dates` should contain an `EnhancedNormalizedDate` object accurately reflecting the specific date and time range (potentially needing parsing of the "from X to Y" structure by `chrono-node` or storing the full string representation within the date object if parsing fails).
    *   `transcript_embeddings` table: Mirrored `metadata`.

---

**Test Case 4: Date Range**

*   **Objective:** Test parsing of a date range.
*   **Input Text:** "My vacation is planned for the last two weeks of August 2025."
*   **Expected GPT Behavior:**
    *   `mode`: `store`
    *   `dates`: ["last two weeks of August 2025"]
    *   `topics`: ["vacation"]
    *   `type`: "personal" / "planning"
    *   `sentiment`: "positive" / "neutral"
    *   `language`: "en"
    *   `priority`: None
*   **Expected Backend State:**
    *   `files` table: `file_metadata.dates` should contain an `EnhancedNormalizedDate` object representing the start and end of the specified range.
    *   `transcript_embeddings` table: Mirrored `metadata`.

---

**Test Case 5: Ambiguous Date (Less Specific)**

*   **Objective:** Test how less specific, potentially ambiguous dates are handled.
*   **Input Text:** "We discussed the budget revisions sometime last spring."
*   **Expected GPT Behavior:**
    *   `mode`: `store`
    *   `dates`: ["last spring"]
    *   `topics`: ["budget revisions"]
    *   `type`: "discussion" / "finance"
    *   `sentiment`: "neutral"
    *   `language`: "en"
    *   `priority`: None
*   **Expected Backend State:**
    *   `files` table: `file_metadata.dates` should contain an `EnhancedNormalizedDate` representing the best guess for "last spring" relative to the current date (e.g., March-May of the previous year). Check `chrono-node`'s interpretation.
    *   `transcript_embeddings` table: Mirrored `metadata`.

---

**Test Case 6: Explicit Metadata - Priority**

*   **Objective:** Test storage of explicitly provided priority.
*   **Input Text:** "URGENT: Need to finalize the contract with Acme Corp by end of day. Set priority 9."
*   **Expected GPT Behavior:**
    *   `mode`: `store`
    *   `topics`: ["contract with Acme Corp"]
    *   `dates`: ["end of day"]
    *   `priority`: 9
    *   `type`: "task" / "contract"
    *   `sentiment`: "neutral" / "negative" (due to urgency)
    *   `language`: "en"
*   **Expected Backend State:**
    *   `files` table: `file_metadata` includes `priority: 9` and an `EnhancedNormalizedDate` for "end of day".
    *   `transcript_embeddings` table: Mirrored `metadata` including `priority: 9`.

---

**Test Case 7: Explicit Metadata - Language (French)**

*   **Objective:** Test storage of explicitly provided language (French).
*   **Input Text:** "Note pour moi-même : Le rapport financier pour Q2 doit être soumis avant vendredi prochain. Langue : fr."
*   **Expected GPT Behavior:**
    *   `mode`: `store`
    *   `topics`: ["rapport financier pour Q2"]
    *   `dates`: ["vendredi prochain"]
    *   `language`: "fr"
    *   `type`: "reminder" / "task"
    *   `sentiment`: "neutral"
    *   `priority`: None
*   **Expected Backend State:**
    *   `files` table: `file_metadata` includes `language: "fr"` and an `EnhancedNormalizedDate` for "vendredi prochain". Text content stored as provided.
    *   `transcript_embeddings` table: Mirrored `metadata` including `language: "fr"`. Embeddings generated from French text.

---

**Test Case 8: Dictation Handling (Email Rewrite & Store)**

*   **Objective:** Test dictation handling: GPT rewriting a long email draft and storing the rewritten version, as per instructions.
*   **Input Text (User provides this):** "hey can u help me write an email to the boss, mr henderson... kinda wanna summarize the project zeta meeting from this morning with lisa and mike... basically we decided the launch is def gonna be delayed, maybe push to sept? need to confirm that timeline still fits with marketing team (ask jen maybe?). also tech team found that bug in the login module (big relief!), should be fixed by tomorrow eod. lisa's handling the updated budget numbers, she'll send em over soon. just make it sound professional, ok? thx"
*   **Expected GPT Behavior:**
    *   **Internal Rewrite (Example):** GPT should first rewrite the user's informal request into a professional email. The exact wording will vary, but the structure and content should be similar to:
        ```
        Subject: Project Zeta Meeting Summary & Updates

        Dear Mr. Henderson,

        This email summarizes the key outcomes from this morning's Project Zeta meeting attended by Lisa Chen, Mike Davis, and myself.

        We determined that the project launch requires rescheduling, potentially moving to September. We will confirm this revised timeline's feasibility with the marketing team, possibly consulting Jen Simmons.

        On a positive note, the technical team has identified the bug within the login module. A fix is anticipated by the end of day tomorrow.

        Lisa Chen is preparing the updated budget figures and will circulate them shortly.

        Best regards,
        [Your Name/Placeholder]
        ```
    *   **Action Call Payload:** GPT should then call the `memory-action` with the *rewritten* text.
        *   `mode`: `store`
        *   `query_text`: (The *rewritten* email text GPT generated)
        *   `extracted_entities`: (Extracted *from the rewritten text*)
            *   `people`: ["Mr. Henderson", "Lisa Chen", "Mike Davis", "Jen Simmons"]
            *   `topics`: ["Project Zeta", "launch rescheduling", "timeline", "marketing team", "login module bug", "budget figures"]
            *   `dates`: ["this morning", "September", "end of day tomorrow", "shortly"] (Strings passed)
            *   `type`: "dictated_email" (Crucial inference)
            *   `sentiment`: "neutral"
            *   `language`: "en"
            *   `priority`: None
    *   **Final Response to User:** After successful storage, GPT should present the rewritten email to the user and acknowledge it has been stored.
*   **Expected Backend State:**
    *   `files` table: 1 row containing the **rewritten** email text in `text_content`. `file_metadata` reflects entities extracted *from the rewritten text*, including `type: "dictated_email"` and corresponding `EnhancedNormalizedDate` objects for dates parsed from the rewrite (e.g., "this morning", "September", "tomorrow EOD").
    *   `transcript_embeddings` table: 1+ rows linked to the file, containing chunks of the **rewritten** text, embeddings, `chunk_index`, and mirrored metadata derived from the rewrite.

---

**Test Case 9: Mixed Languages (Inferred)**

*   **Objective:** Test language inference when text contains multiple languages without explicit instruction.
*   **Input Text:** "I need to buy croissants from the Boulangerie Dumas on my way home. Don't forget!"
*   **Expected GPT Behavior:**
    *   `mode`: `store`
    *   `topics`: ["buy croissants"]
    *   `locations`: ["Boulangerie Dumas"]
    *   `language`: "en" (Likely inferred as dominant language, but check if `fr` is detected)
    *   `type`: "reminder" / "task"
    *   `sentiment`: "neutral"
    *   `priority`: None
*   **Expected Backend State:**
    *   `files` table: `file_metadata.language` should ideally be "en" or possibly include multiple detected languages if the model supports it. Verify what is stored.
    *   `transcript_embeddings` table: Mirrored `metadata`.

---

**Test Case 10: Very Short Input**

*   **Objective:** Test handling of minimal input text.
*   **Input Text:** "Call Mom."
*   **Expected GPT Behavior:**
    *   `mode`: `store`
    *   `people`: ["Mom"]
    *   `topics`: ["Call Mom"]
    *   `type`: "task" / "reminder"
    *   `sentiment`: "neutral"
    *   `language`: "en"
    *   `priority`: None
*   **Expected Backend State:**
    *   `files` table: 1 row with minimal metadata.
    *   `transcript_embeddings` table: 1 row with the short text, embedding, and mirrored metadata.

---

**Test Case 11: Very Long Input (Multi-Chunk)**

*   **Objective:** Test handling of input text significantly longer than `CHUNK_SIZE`, requiring multiple chunks and embeddings.
*   **Input Text:** (Paste a long article snippet here - e.g., 3000+ characters. Example: A detailed project update email body)
    "Subject: Project Phoenix - Weekly Update (April 10, 2025)
    Team, This week saw significant progress across multiple workstreams for Project Phoenix. The frontend team, led by Anya Sharma, completed the integration of the new charting library (Chart.js v4) into the main dashboard component. Initial testing looks positive, resolving the previous performance bottlenecks we observed during peak load simulations last month. User acceptance testing (UAT) is scheduled to begin next Monday, April 14th, at the Waterfront Tech Park facility. Please ensure all prerequisites listed in the UAT plan document (shared via Confluence) are met by Friday EOD. The backend team, under David Lee's supervision, deployed the optimized database query (`search_optimized_v3`) to the staging environment late yesterday evening (around 11 PM PST). Preliminary results show a 30% reduction in average query latency for complex data retrieval operations. We need to monitor this closely over the next 48 hours before planning the production rollout, tentatively set for Wednesday, April 16th. Key dependencies include the successful completion of the related security audit by SecureSoft Inc., whose final report is expected by Tuesday afternoon. Lastly, the design team (Maria Garcia and Ben Carter) presented the final mockups for the mobile application interface. Feedback was overwhelmingly positive, focusing on the intuitive navigation and clean aesthetic. Minor adjustments based on stakeholder comments received during the review session held at the Mountain View Campus on April 8th will be incorporated, with final assets delivered by COB April 15th. Marketing has requested these assets for inclusion in the upcoming press release planned for the first week of May 2025. Please sync with Sandra Jones from Marketing if you foresee any delays. Let's maintain this momentum! Best, Project Lead."
*   **Expected GPT Behavior:**
    *   `mode`: `store`
    *   `people`: ["Anya Sharma", "David Lee", "Maria Garcia", "Ben Carter", "Sandra Jones", "Project Lead" (potentially)]
    *   `locations`: ["Waterfront Tech Park", "Mountain View Campus"]
    *   `topics`: ["Project Phoenix", "charting library", "Chart.js v4", "dashboard component", "User acceptance testing (UAT)", "optimized database query", "search_optimized_v3", "staging environment", "production rollout", "security audit", "SecureSoft Inc.", "mobile application interface", "press release"]
    *   `dates`: ["April 10, 2025", "last month", "next Monday, April 14th", "Friday EOD", "late yesterday evening (around 11 PM PST)", "next 48 hours", "Wednesday, April 16th", "Tuesday afternoon", "April 8th", "COB April 15th", "first week of May 2025"]
    *   `type`: "project update", "email", "report"
    *   `sentiment`: "positive", "neutral"
    *   `language`: "en"
    *   `priority`: None
*   **Expected Backend State:**
    *   `files` table: 1 row with the full text and comprehensive `file_metadata` containing all extracted entities and parsed `EnhancedNormalizedDate` objects.
    *   `transcript_embeddings` table: Multiple rows (e.g., 3+ depending on exact length and overlap), each linked to the same `file_id`, with correct `chunk_index` (0, 1, 2...), embeddings for each chunk, and the *same* mirrored `file_metadata` on every chunk record.

---

**Test Case 12: Input with No Clear Entities**

*   **Objective:** Test behavior when input text lacks obvious standard entities.
*   **Input Text:** "The rain in Spain stays mainly in the plain."
*   **Expected GPT Behavior:**
    *   `mode`: `store`
    *   `locations`: ["Spain"] (Possibly)
    *   `topics`: ["rain"] (Possibly)
    *   `type`: "phrase" / "saying" / "unknown"
    *   `sentiment`: "neutral"
    *   `language`: "en"
    *   `priority`: None
    *   Other entities likely null or empty arrays.
*   **Expected Backend State:**
    *   `files` table: Row with minimal `file_metadata`, potentially only `type`, `sentiment`, `language`.
    *   `transcript_embeddings` table: Corresponding chunk/embedding with mirrored minimal metadata.

---

**Test Case 13: Negative Sentiment**

*   **Objective:** Test inference and storage of negative sentiment.
*   **Input Text:** "Terrible customer service experience with FlyHigh Airlines today. My flight was delayed by 4 hours, and the staff were unhelpful."
*   **Expected GPT Behavior:**
    *   `mode`: `store`
    *   `topics`: ["customer service experience", "FlyHigh Airlines", "flight delay"]
    *   `dates`: ["today"]
    *   `type`: "complaint" / "feedback" / "experience"
    *   `sentiment`: "negative"
    *   `language`: "en"
    *   `priority`: None
*   **Expected Backend State:**
    *   `files` table: `file_metadata` includes `sentiment: "negative"`.
    *   `transcript_embeddings` table: Mirrored `metadata`.

---

**Test Case 14: Formal Location Name**

*   **Objective:** Test recognition of a formal location name.
*   **Input Text:** "The annual shareholders meeting will be held at The Grand Hyatt Hotel, New York City."
*   **Expected GPT Behavior:**
    *   `mode`: `store`
    *   `locations`: ["The Grand Hyatt Hotel, New York City"] (or potentially split)
    *   `topics`: ["annual shareholders meeting"]
    *   `type`: "event" / "meeting"
    *   `sentiment`: "neutral"
    *   `language`: "en"
    *   `priority`: None
*   **Expected Backend State:**
    *   `files` table: `file_metadata.locations` correctly captures the full hotel and city name.
    *   `transcript_embeddings` table: Mirrored `metadata`.

---

**Test Case 15: Input with Emojis**

*   **Objective:** Test how emojis are handled in text content and potentially influence sentiment.
*   **Input Text:** "Just finished the marathon! 🏅 Feeling exhausted but proud. 😊 Time for pizza 🍕. See you tomorrow."
*   **Expected GPT Behavior:**
    *   `mode`: `store`
    *   `topics`: ["marathon", "pizza"]
    *   `dates`: ["tomorrow"]
    *   `type`: "personal update" / "achievement"
    *   `sentiment`: "positive"
    *   `language`: "en"
    *   `priority`: None
*   **Expected Backend State:**
    *   `files` table: Text content should ideally preserve the emojis. `file_metadata.sentiment` should be positive.
    *   `transcript_embeddings` table: Mirrored `metadata`. Chunk text preserves emojis.

---

**Test Case 16: Numeric Data and Codes**

*   **Objective:** Test handling of numeric codes or identifiers – should they be treated as topics?
*   **Input Text:** "Received confirmation for order #A B C-12345. Tracking ID is 987654321XYZ. Delivery expected next Wednesday."
*   **Expected GPT Behavior:**
    *   `mode`: `store`
    *   `topics`: ["order #A B C-12345", "Tracking ID 987654321XYZ", "Delivery"] (or similar)
    *   `dates`: ["next Wednesday"]
    *   `type`: "confirmation" / "order update"
    *   `sentiment`: "neutral"
    *   `language`: "en"
    *   `priority`: None
*   **Expected Backend State:**
    *   `files` table: `file_metadata.topics` should capture the order/tracking codes. `EnhancedNormalizedDate` for the date.
    *   `transcript_embeddings` table: Mirrored `metadata`.

---

**Test Case 17: Vague Person Reference**

*   **Objective:** Test handling of less specific person references.
*   **Input Text:** "My manager approved the vacation request submitted last week."
*   **Expected GPT Behavior:**
    *   `mode`: `store`
    *   `people`: ["My manager"] (Possibly, or maybe none)
    *   `topics`: ["vacation request"]
    *   `dates`: ["last week"]
    *   `type`: "update" / "approval"
    *   `sentiment`: "positive" / "neutral"
    *   `language`: "en"
    *   `priority`: None
*   **Expected Backend State:**
    *   `files` table: Check if "My manager" is stored in `file_metadata.people`. Store `EnhancedNormalizedDate` for "last week".
    *   `transcript_embeddings` table: Mirrored `metadata`.

---

**Test Case 18: Future Ambiguous Date**

*   **Objective:** Test handling of future ambiguous dates.
*   **Input Text:** "Let's schedule the follow-up meeting sometime early next year."
*   **Expected GPT Behavior:**
    *   `mode`: `store`
    *   `topics`: ["follow-up meeting"]
    *   `dates`: ["sometime early next year"]
    *   `type`: "planning" / "scheduling"
    *   `sentiment`: "neutral"
    *   `language`: "en"
    *   `priority`: None
*   **Expected Backend State:**
    *   `files` table: `file_metadata.dates` contains `EnhancedNormalizedDate` representing `chrono-node`'s interpretation of "early next year" (e.g., Jan-Mar of the next calendar year).
    *   `transcript_embeddings` table: Mirrored `metadata`.

---

**Test Case 19: Input with Conversation/Thread ID**

*   **Objective:** Test explicit storage of `conversation_id` and `thread_id`.
*   **Input Text:** "Summary of our call: Agreed on next steps for deployment. Conversation ID: conv123. Thread ID: thread-abc-789."
*   **Expected GPT Behavior:**
    *   `mode`: `store`
    *   `topics`: ["deployment next steps"]
    *   `conversation_id`: "conv123"
    *   `thread_id`: "thread-abc-789"
    *   `type`: "summary" / "meeting notes"
    *   `sentiment`: "neutral"
    *   `language`: "en"
    *   `priority`: None
*   **Expected Backend State:**
    *   `files` table: Row has `conversation_id` = "conv123" and `thread_id` = "thread-abc-789" in the dedicated top-level columns. `file_metadata` might also contain them but the top-level columns are key.
    *   `transcript_embeddings` table: Mirrored `metadata` (which will include `conversation_id` and `thread_id` within the JSONB).

---

**Test Case 20: Complex Sentence Structure**

*   **Objective:** Test entity extraction from a more complex sentence with nested clauses.
*   **Input Text:** "Although the initial proposal submitted by Tech Solutions Inc. last Tuesday was rejected, the revised plan, which addresses the concerns raised by Mr. David Robertson during the review meeting at the London office, looks promising for approval next month."
*   **Expected GPT Behavior:**
    *   `mode`: `store`
    *   `people`: ["Mr. David Robertson"]
    *   `locations`: ["London office"]
    *   `topics`: ["initial proposal", "Tech Solutions Inc.", "revised plan", "review meeting", "approval"]
    *   `dates`: ["last Tuesday", "next month"]
    *   `type`: "update" / "proposal review"
    *   `sentiment`: "neutral" / "positive" (due to "promising")
    *   `language`: "en"
    *   `priority`: None
*   **Expected Backend State:**
    *   `files` table: Correct `file_metadata` capturing entities from the complex structure. Multiple `EnhancedNormalizedDate` objects for the two dates.
    *   `transcript_embeddings` table: Mirrored `metadata`.

---
