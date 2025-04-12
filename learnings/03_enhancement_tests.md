# Memory Locker: v1.7 Store Mode Test Cases

**Objective:** Test the `store` mode of the `memory-action` function, specifically focusing on the correct extraction and processing of entities (including dates via the v1.7 hybrid parsing) from diverse user inputs.

**Methodology:** Use the following inputs as the `query_text` in a `store` mode request to the Custom GPT. Compare the `extracted_entities` sent by the GPT to the action (should be English, with dates potentially having `original` and `normalized` fields) and the final `processedMetadata` stored by the Netlify function (visible in logs or database, should contain component-only `EnhancedNormalizedDate` objects).

---

**Test Cases:**

1.  **ID:** STORE-001
    **Input Text:** "Met with Dr. Evelyn Reed at the Riverside Clinic this morning around 9:15 AM to discuss the clinical trial results for patient JKL-88. She seemed optimistic about the progress."
    **Expected Entities Focus:** Person, Location, Date (relative + time), Topic (specific ID), Sentiment.

2.  **ID:** STORE-002
    **Input Text:** "Reminder: The Q3 financial review meeting originally scheduled for last Thursday is now happening next Tuesday afternoon. Need to prepare the slide deck on revenue projections for the European market. Priority 8."
    **Expected Entities Focus:** Dates (past relative, future relative + period), Topic, Location (implied/market), Priority, Type (reminder).

3.  **ID:** STORE-003
    **Input Text:** "Ran into Michael Sterling and his partner Alex Chen at the grand opening of the 'Artisan's Corner' gallery downtown on Saturday evening. They mentioned they're planning a trip to Kyoto next spring."
    **Expected Entities Focus:** People (multiple), Location (specific name + general), Date (relative + period), Date (future season), Topic (event).

4.  **ID:** STORE-004
    **Input Text:** "Note to self: Buy tickets for the Daft Punk tribute concert at the Zenith Arena on 2025-07-18. They go on sale tomorrow morning!"
    **Expected Entities Focus:** Topic (event + artist), Location (specific name), Date (absolute YYYY-MM-DD), Date (relative + period), Type (note/task).

5.  **ID:** STORE-005
    **Input Text:** "Dictated thought: The philosophical implications of advanced AI consciousness, particularly concerning the 'Ship of Theseus' paradox applied to neural networks, are fascinating but also deeply unsettling. Need to explore papers by Chalmers and Dennett."
    **Expected Entities Focus:** Topic (complex/abstract), People (authors), Sentiment (mixed), Type (dictated_thought).

6.  **ID:** STORE-006
    **Input Text:** (Long Email Snippet)
    "Subject: Project Chimera - Urgent Update (COB Today)\n\nHi Team,\n\nFollowing our sync this morning, we need to finalize the deployment checklist for the Project Chimera alpha release by close of business today. The key blocker identified revolves around the integration module provided by OmniCorp, which failed integration tests again yesterday.\n\nPlease review the attached logs (Ref: CHIM-LOG-451) and provide your feedback. We have a hard deadline with the client for the end of next week. Let's ensure we hit this target.\n\nThanks,\nJavier Rodriguez\nLead Engineer, Tech Solutions Inc."
    **Expected Entities Focus:** Topic (Project name + specific details), Date (relative + period: COB Today), Date (relative + period: this morning), Date (relative: yesterday), Date (relative: end of next week), Organization (OmniCorp, Tech Solutions Inc.), Person (sender). (Max 3 distinct date concepts: Today, Yesterday, Next Week).

7.  **ID:** STORE-007
    **Input Text:** "Had a really frustrating call with Apex Support regarding ticket #7783-B concerning the faulty server rack at the London data center. The issue started around 3 PM GMT on April 5th, 2025, and is still unresolved."
    **Expected Entities Focus:** Organization, Topic (ticket ID), Location (specific + city), Date (absolute with time + timezone hint), Sentiment (negative).

8.  **ID:** STORE-008
    **Input Text:** "Idea for novel: Character named 'Silas Vance' discovers an ancient artifact in the Sahara Desert that manipulates probability. Plot point: Needs to activate it during the next solar eclipse visible from North Africa."
    **Expected Entities Focus:** Person (fictional), Topic (novel idea, artifact), Location (specific), Date (relative event).

9.  **ID:** STORE-009
    **Input Text:** "Remember the fantastic paella we had at 'El Faro Blanco' restaurant during our vacation in Valencia last summer? It was unforgettable!"
    **Expected Entities Focus:** Location (specific name + city), Date (past season), Topic (food), Sentiment (positive), Type (story/memory).

10. **ID:** STORE-010
     **Input Text:** "Need to book follow-up dental appointment with Dr. Anya Sharma sometime in the first two weeks of June 2025."
     **Expected Entities Focus:** Person, Topic (appointment), Date (future range), Type (task).

11. **ID:** STORE-011
     **Input Text:** "Received the preliminary designs for the 'Project Nightingale' mobile app UI from the design team at CreativeWorks Agency. The login screen looks great, but the dashboard needs rework. Feedback due EOD Friday."
     **Expected Entities Focus:** Topic (project name + specifics), Organization, Date (relative + period: EOD Friday).

12. **ID:** STORE-012
     **Input Text:** "Attended a workshop on sustainable urban planning hosted by the City Council at the Central Library yesterday afternoon. Key speaker was Professor Kenji Tanaka from Tokyo University."
     **Expected Entities Focus:** Topic, Organization (generic + specific), Location (specific + type), Date (relative + period), Person.

13. **ID:** STORE-013
     **Input Text:** (Long Note Snippet)
     "Research Notes: Quantum Entanglement & Communication\n\nExplored the potential of using quantum entanglement for instantaneous communication across vast distances, referencing the EPR paradox. Current challenges involve maintaining coherence and reliable measurement without collapsing the state. Found a promising paper from MIT researchers published around March 2024 discussing potential solutions using topological qubits.\n\nAlso, need to review the security implications discussed during the conference call on Monday, May 5th, 2025. Potential vulnerabilities exist if entanglement can be intercepted or manipulated. Compare findings with standard encryption methods like RSA."
     **Expected Entities Focus:** Topic (technical, multiple concepts), Organization (MIT), Date (approximate month/year), Date (specific month/day/year), Type (research_note). (Max 3 distinct date concepts: March 2024, May 5th 2025, Implicit 'current research').

14. **ID:** STORE-014
     **Input Text:** "That stand-up comedy show by Chloe Martinez at the 'Laugh Riot' club last night was hilarious! Her bit about trying to assemble IKEA furniture had me in tears."
     **Expected Entities Focus:** Person, Location (specific name + type), Date (relative + period), Topic (event type + specific bit), Sentiment (positive/funny).

15. **ID:** STORE-015
     **Input Text:** "Set reminder: Pay the quarterly estimated taxes. Due date is 06/15/2025. Priority 10."
     **Expected Entities Focus:** Topic (task), Date (absolute MM/DD/YYYY), Priority, Type (reminder).

16. **ID:** STORE-016
     **Input Text:** "Discussed the potential merger between Alpha Corp and Beta Industries with financial analyst David Chen on 2024-12-10. He advised caution due to market volatility."
     **Expected Entities Focus:** Organizations (multiple), Person, Date (absolute YYYY-MM-DD), Topic (merger, finance).

17. **ID:** STORE-017
     **Input Text:** "Feeling quite pleased with the progress on the garden project this weekend. Planted the tomatoes and peppers acquired from GreenThumb Nursery. Hopefully, we'll have a good harvest this fall."
     **Expected Entities Focus:** Topic (project + specifics), Date (relative weekend), Organization, Date (future season), Sentiment (positive).

18. **ID:** STORE-018
     **Input Text:** "Encounter note: Spoke with neighbor Mrs. Gable regarding the upcoming neighborhood watch meeting scheduled for the last Wednesday of this month. She confirmed attendance."
     **Expected Entities Focus:** Person, Topic (meeting), Date (relative month boundary), Type (encounter_note).

19. **ID:** STORE-019
     **Input Text:** "Book flight to Toronto for the Tech Innovators conference happening from July 21st to July 23rd, 2025. Need to arrive the evening before, on July 20th."
     **Expected Entities Focus:** Location (city), Topic (conference), Date (range with specific dates), Date (specific date + period), Type (task).

20. **ID:** STORE-020
     **Input Text:** (Very Long Dictation Snippet - Partial)
     "...and so, the critical path analysis reveals that the dependency on the resource allocation from the Barcelona office is delaying the entire 'Project Redwood' timeline. We initially projected completion by end of Q2 2025, but the slippage reported last Friday suggests we might push into early Q3. I spoke with Maria Garcia in Barcelona this morning, and she indicated the resources might be freed up by next Monday, but we need confirmation. Please draft an email summarizing this risk and the proposed mitigation strategy of reallocating internal engineers from the Dublin team. Emphasize the urgency and the potential budget impact if we don't resolve this by Wednesday..."
     **Expected Entities Focus:** Location (Barcelona, Dublin), Topic (Project name + specifics), Date (relative quarter/year: Q2 2025, Q3 2025), Date (relative: last Friday), Date (relative + period: this morning), Date (relative: next Monday), Date (relative: Wednesday), Person (Maria Garcia), Type (dictated_email_request). (Max 3 distinct date concepts: Q2/Q3 2025, Last Friday, This/Next Week). 