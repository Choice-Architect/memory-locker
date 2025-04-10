{
  "people": ["string", "..."], // Optional array of person names
  "dates": [ // Optional array of date objects
    { // EnhancedNormalizedDate object
      "original": "string", // e.g., "last Tuesday afternoon" (Required)
      "normalized": "string | null", // e.g., "2024-04-09T15:00:00Z" or null (ISO 8601)
      "note": "string | null", // e.g., "Parsed successfully. Time component was implied..."
      "year": "number | null", // e.g., 2024
      "month": "number | null", // e.g., 4 (1-12)
      "day": "number | null", // e.g., 9 (1-31)
      "day_of_week": "number | null", // e.g., 2 (0=Sun, 1=Mon...)
      "time_hour": "number | null", // e.g., 15 (0-23)
      "time_minute": "number | null", // e.g., 0
      "time_second": "number | null", // e.g., 0
      "period": "string | null", // e.g., "Afternoon", "AM", "PM", "Evening", etc.
      "relative_marker": "string | null", // e.g., "last", "this", "next"
      "relative_unit": "string | null" // e.g., "day", "week", "month"
    },
    "..." // More EnhancedNormalizedDate objects if multiple dates were extracted
  ],
  "locations": ["string", "..."], // Optional array of location names
  "topics": ["string", "..."], // Optional array of topic keywords
  "type": "string | null", // Optional inferred type (e.g., "story", "note")
  "sentiment": "string | null", // Optional inferred sentiment (e.g., "funny", "important")
  "priority": "number | null", // Optional user priority (1-10)
  // Note: conversation_id and thread_id are stored in dedicated columns in the 'files' table,
  //       but might be included here in transcript_embeddings.metadata for redundancy/convenience.
  "conversation_id": "string | null", // Optional
  "thread_id": "string | null", // Optional
  "language": "string | null", // Optional language code (e.g., "en", "fr")
  // --- Chunk-specific additions in transcript_embeddings.metadata ---
  "created_at": "string", // ISO 8601 timestamp of chunk creation/embedding
  "chunk_index": "number" // 0-based index of the chunk within its file
  // Potentially other key-value pairs from initial extraction
  // "additionalPropertyKey": ["string", "..."]
}