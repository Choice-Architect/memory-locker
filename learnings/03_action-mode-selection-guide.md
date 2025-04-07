# Defining action mode activation (store vs. query vs. combined):

I will answer your question by describing how the custom GPT will be used. When you are done reviewing, we should discuss options before you execute anything.

## Usage cases:
We have 4 common usage cases for the app. Bracketed [] words are entities, concepts, or variables that we are always looking to store (presumable as metadata but open to suggestions).

- A) User does a quick recording retelling "a [funny story] just happened with my son [son's name]".

- B) User dictates a long [email], over 3-4 minutes of talking, to the GPT because he loves how it fixes the language up for him and gets it ready to be sent.

- C) User adds a quick note saying something like: "I ran into [person's name] at [location name] and he mentioned this new app [app name]".

- D) "remind me to call [person's name] back tomorrow about the [subject matter]".

As you will have noticed, only 1 of these 4 common interactions makes any definitive statement like "remind me". It is definitely nice to have them and we should think on what those should be.

The next sections will describe how each of the 3 mode selections will come into play.

## Store:
I will describe how 'store' should behave in each of the 4 common usage cases:

### A) a funny story or anecdote:
- Any retelling of an event should trigger 'store' memory exclusively (unless the input also included a query, in which case, 'combined' would trigger: As a rule, unless the memory includes a query as well, then there is no need to query the database for further context). 
- The sentiment or importance of the event is also relevant: Funny stories, milestone events mentioned, angry encounters, etc... (I don't know whether this is something vector stores can handle without additional meta tags, but the idea is that one should be able to later query: "What are ALL my funny memories of [person's name]?" and be able to get that either from the vector store query or the fallback postgres if the items are many).
- Any names, locations, dates, events, organisations, etc.. should be added to the meta data.

### B) Dictating a long email:
- When ChatGPT knows it is reviewing and fixing the writing of an email, direct message, or a similar type of communication entity, it responds back as usual with a properly constructed and formatted email to the user, AND saves its generated response as a stored memory.
- We also want to be saving within the meta data that it is an email, DM, etc...
- Any names, locations, dates, events, organisations, etc.. should be added to the meta data.

### C) Adding a quick note:
- Like the funny story or anecdote, a note without an explicit request or query included should exclusively trigger the 'store' action.
- Instead of the 'funny story' being notable, the entity here would be something like "encounter" or other event type inferred.
- As usual, any names, locations, dates, events, organisations, etc.. should be added to the meta data. In this instance, [app name] is notable.

### D) Explicit reminder:
- Commands like "add task", "remind me", "add reminder", should automatically trigger the 'store' action exclusively (unless combined with another query of course)
- A classifier meta tag like "reminder", "task" "shopping item" should be stored.
- Any names, locations, dates, events, organisations, etc.. should be added to the meta data


## Query:

### A) a funny story or anecdote:
Examples of queries that would trigger this memory:
- "What was the last funny story I shared about [person's name]"
- "How many times has [person's name] been funny in the 5 months?"
- "When did [person's name] do that funny thing?"

### B) Dictating a long email:
Examples of queries that would trigger this memory:
- "What did I last send [person's name]?"
- "What was the timing of the meeting mentioned in my last email?"
- "What did I tell [person's name] that I would do last?"
- "What are the last 3 emails I sent to [person's name]"

### C) Adding a quick note:
Examples of queries that would trigger this memory:
- "What was the name of that app [person's name] mentioned the last time I ran into him?"
- "Where did I last run into [person's name]?"
- "Who are the people who have mentioned [app name] to me?

### D) Explicit reminder:
Examples of queries that would trigger this memory:
- "What are my reminders for today?"
- "What is on my to-do for this week?"
- "What do I need to remember to pick up from the store?"

#### Additional notes
I should add that, within the customGPT, I will be uploading documents to the 'knowledge base" to provide more context while it is operating. These simple documents or tables will include information about me, my family, and any key associations that I expect ChatGPT to know while it is processing the interaction. I hope this is not problematic. 