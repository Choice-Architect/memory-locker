import { Handler, HandlerEvent, HandlerContext } from "@netlify/functions";
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import stemmer from '@stdlib/nlp-porter-stemmer';
import {
    formatISO,
    isValid,
    parseISO,
    endOfDay,
    startOfDay,
    startOfWeek,
    endOfWeek,
    startOfMonth,
    endOfMonth,
    startOfYear,
    endOfYear,
    subDays,
    subWeeks,
    subMonths,
    subYears,
    isFuture,
    isPast
} from 'date-fns';
import * as chrono from 'chrono-node';

// --- Interfaces for API Contract ---

// Updated Interface for normalized date object (Old - will be replaced by EnhancedNormalizedDate in outputs)
interface NormalizedDate {
    original: string;
    normalized: string | null; // ISO 8601 format or null if failed
    note?: string; // Added: Reason for failure (e.g., 'vague', 'parse_error')
}

// NEW Interface for Enhanced Date Handling with Components
interface EnhancedNormalizedDate {
    original: string;        // The original string like "last Tuesday afternoon"
    normalized?: string | null; // ISO 8601 if fully resolved, else null
    note?: string;           // Explanation if partial or failed (e.g., "Partial parse: Day and period identified relative to reference date")
    // --- Component Fields (all optional) ---
    year?: number;           // e.g., 2024
    month?: number;          // e.g., 4 (1-12)
    day?: number;            // e.g., 2 (1-31)
    day_of_week?: number;    // e.g., 2 (0=Sun, 1=Mon, 2=Tue...)
    time_hour?: number;      // e.g., 15 (0-23)
    time_minute?: number;    // e.g., 0
    time_second?: number;    // e.g., 0
    period?: 'AM' | 'PM' | 'Morning' | 'Afternoon' | 'Evening' | 'Night'; // e.g., "Afternoon"
    relative_marker?: 'last' | 'this' | 'next' | 'previous'; // e.g., "last"
    relative_unit?: 'day' | 'week' | 'month' | 'year' | 'weekend'; // e.g., "week" (implicitly via Tuesday)
}

interface ExtractedEntities {
    people?: string[];
    // Input can still be flexible string or NormalizedDate for initial capture
    // but will be processed into EnhancedNormalizedDate internally.
    dates?: (string | NormalizedDate)[];
    locations?: string[];
    topics?: string[];
    type?: string; // Added based on schema
    sentiment?: string; // Added based on schema
    priority?: number; // Added: Optional user-assigned priority (1-10)
    conversation_id?: string; // Added: Optional conversation identifier
    thread_id?: string; // Added: Optional thread identifier
    language?: 'en' | 'fr' | 'ar'; // Added: Optional language code
    [key: string]: any; // Allow flexible entity types, keep for now
}

// Interface for entities AFTER internal processing (using EnhancedNormalizedDate)
// This is what gets stored in metadata and returned in context objects.
interface ProcessedEntities {
    people?: string[];
    dates?: EnhancedNormalizedDate[]; // Use the new enhanced structure
    locations?: string[];
    topics?: string[];
    type?: string;
    sentiment?: string;
    priority?: number;
    conversation_id?: string;
    thread_id?: string;
    language?: 'en' | 'fr' | 'ar';
    [key: string]: any;
}

interface RequestPayload {
    query_text: string;
    extracted_entities: ExtractedEntities; // Input uses the original ExtractedEntities
    // user_id?: string; (Removed)
    mode: 'store' | 'query' | 'combined';
}

interface ContextObject {
    chunk: string;
    timestamp: string; // ISO 8601 format (Could be chunk creation or file creation)
    entities_in_chunk: ProcessedEntities; // Output uses ProcessedEntities with EnhancedNormalizedDate
    file_id?: string; // Reference to the source file (Corrected: UUID as string)
    chunk_id?: string; // Reference to the specific chunk (Corrected: UUID as string)
    chunk_index?: number; // Added: Index of the chunk within its file
}

interface SuccessResponse {
    retrieved_context: ContextObject[];
    storage_status: string;
    query_source: 'vector_store' | 'postgres_fallback' | 'postgres_fallback_metadata' | 'postgres_fallback_text' | 'none' | 'combined' | 'error'; // Added combined/error and specific fallbacks
    message_for_gpt?: string;
    error: null;
}

interface ErrorResponse {
    error: string;
}

// Define interface for the structure returned by search_memory_chunks RPC
interface SearchResultItem {
    // id?: string; // Chunk ID from transcript_embeddings if returned by RPC (Corrected: UUID as string)
    file_id: string; // Corrected: UUID as string
    content_chunk: string;
    // Metadata from DB should now contain ProcessedEntities structure
    metadata?: ProcessedEntities & { created_at?: string; [key: string]: any };
    similarity?: number;
    chunk_index?: number; // Added this field here too
}

// Define interface for the structure returned by the fallback files query
interface FallbackResultItem {
    id: string; // Corrected: UUID as string
    transcript_text: string;
    created_at: string | null;
    // file_metadata from DB should now contain ProcessedEntities structure
    file_metadata: ProcessedEntities | null;
}

// NEW Interface for internal re-ranking
interface ScoredContextObject extends ContextObject {
    initial_score: number; // Normalized initial score (0-1)
    metadata_boost_score: number; // Calculated boost
    final_score: number;  // Score after boost
}

// --- Constants ---
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536; // Dimension for text-embedding-3-small
const CHUNK_SIZE = 1000; // Target size in characters
const CHUNK_OVERLAP = 200; // Overlap in characters
const VECTOR_MATCH_THRESHOLD = 0.5; // Similarity threshold for vector search (Lowered from 0.75)
const VECTOR_MATCH_COUNT = 15;     // Max number of chunks to retrieve via vector search (Updated for re-ranking)
const FALLBACK_MATCH_COUNT = 20; // Max number of files to retrieve via FTS fallback (Updated for re-ranking)
const FINAL_MATCH_COUNT = 5;     // Final number of results to return after re-ranking
const STORAGE_REFERENCE_DATE = new Date('2025-04-06T12:00:00Z'); // Fixed reference for storing test data

// Simple list of common English stop words
const STOP_WORDS = new Set([
    'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'aren\'t', 'as', 'at',
    'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can\'t', 'cannot',
    'could', 'couldn\'t', 'did', 'didn\'t', 'do', 'does', 'doesn\'t', 'doing', 'don\'t', 'down', 'during', 'each',
    'few', 'for', 'from', 'further', 'had', 'hadn\'t', 'has', 'hasn\'t', 'have', 'haven\'t', 'having', 'he', 'he\'d',
    'he\'ll', 'he\'s', 'her', 'here', 'here\'s', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'how\'s', 'i', 'i\'d',
    'i\'ll', 'i\'m', 'i\'ve', 'if', 'in', 'into', 'is', 'isn\'t', 'it', 'it\'s', 'its', 'itself', 'let\'s', 'me',
    'more', 'most', 'mustn\'t', 'my', 'myself', 'no', 'nor', 'not', 'of', 'off', 'on', 'once', 'only', 'or', 'other',
    'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'shan\'t', 'she', 'she\'d', 'she\'ll', 'she\'s',
    'should', 'shouldn\'t', 'so', 'some', 'such', 'than', 'that', 'that\'s', 'the', 'their', 'theirs', 'them',
    'themselves', 'then', 'there', 'there\'s', 'these', 'they', 'they\'d', 'they\'ll', 'they\'re', 'they\'ve', 'this',
    'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'wasn\'t', 'we', 'we\'d', 'we\'ll', 'we\'re',
    'we\'ve', 'were', 'weren\'t', 'what', 'what\'s', 'when', 'when\'s', 'where', 'where\'s', 'which', 'while', 'who',
    'who\'s', 'whom', 'why', 'why\'s', 'with', 'won\'t', 'would', 'wouldn\'t', 'you', 'you\'d', 'you\'ll', 'you\'re',
    'you\'ve', 'your', 'yours', 'yourself', 'yourselves'
]);

// --- Environment Variables ---
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const actionSecretKey = process.env.ACTION_SECRET_KEY || '';
const openaiApiKey = process.env.OPENAI_API_KEY || '';

// --- Client Initialization ---
let supabase: SupabaseClient;
let openai: OpenAI;

const initializeClients = () => {
    if (!supabase) {
        if (!supabaseUrl || !supabaseServiceRoleKey) {
            throw new Error("Supabase URL or Service Role Key is missing.");
        }
        supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
             auth: {
                persistSession: false // Recommended for serverless functions
            }
        });
    }
    if (!openai) {
        if (!openaiApiKey) {
            throw new Error("OpenAI API Key is missing.");
        }
        openai = new OpenAI({ apiKey: openaiApiKey });
    }
};

// --- Utility Functions ---

// ADD NEW deriveDateRange function
/**
 * Analyzes an array of EnhancedNormalizedDate objects to derive a specific,
 * historical date range suitable for filtering.
 * Prefers the first specific, past range found.
 * Returns null if no suitable range can be determined.
 */
function deriveDateRange(dates: EnhancedNormalizedDate[] | undefined, referenceDate: Date = new Date()): { startDate: string; endDate: string } | null {
    if (!dates || dates.length === 0) {
        return null;
    }

    console.log("Deriving date range from:", JSON.stringify(dates));

    for (const dateInfo of dates) {
        let potentialStart: Date | null = null;
        let potentialEnd: Date | null = null;

        // Try using chrono's parsed date directly if fully specified and in the past
        if (dateInfo.normalized && dateInfo.year && dateInfo.month && dateInfo.day) {
            try {
                const parsed = parseISO(dateInfo.normalized);
                if (isValid(parsed) && isPast(parsed)) {
                    // Use the specific day
                    potentialStart = startOfDay(parsed);
                    potentialEnd = endOfDay(parsed);
                    console.log(`Derived range from normalized date: ${dateInfo.original}`);
                } else {
                     console.log(`Normalized date ${dateInfo.normalized} is invalid or in the future, skipping.`);
                }
            } catch (e) {
                console.warn(`Error parsing normalized date ${dateInfo.normalized}, ignoring.`);
            }
        }

        // Handle specific relative terms if no date derived yet
        if (!potentialStart && dateInfo.relative_marker === 'last') {
            if (dateInfo.relative_unit === 'day' || /yesterday/i.test(dateInfo.original)) {
                potentialStart = startOfDay(subDays(referenceDate, 1));
                potentialEnd = endOfDay(subDays(referenceDate, 1));
                console.log(`Derived range from relative term: yesterday`);
            }
             else if (dateInfo.relative_unit === 'week') {
                potentialStart = startOfWeek(subWeeks(referenceDate, 1)); // Consider locale for start of week
                potentialEnd = endOfWeek(subWeeks(referenceDate, 1));
                console.log(`Derived range from relative term: last week`);
            }
             else if (dateInfo.relative_unit === 'month') {
                potentialStart = startOfMonth(subMonths(referenceDate, 1));
                potentialEnd = endOfMonth(subMonths(referenceDate, 1));
                console.log(`Derived range from relative term: last month`);
            }
             else if (dateInfo.relative_unit === 'year') {
                potentialStart = startOfYear(subYears(referenceDate, 1));
                potentialEnd = endOfYear(subYears(referenceDate, 1));
                console.log(`Derived range from relative term: last year`);
            }
        }

        // Handle Year-Month or Year if no specific date/relative term worked
        if (!potentialStart && dateInfo.year) {
            if (dateInfo.month) { // Year and Month provided
                const year = dateInfo.year;
                const monthIndex = dateInfo.month - 1; // date-fns uses 0-indexed months
                const dateInMonth = new Date(year, monthIndex);
                if (isValid(dateInMonth) && isPast(endOfMonth(dateInMonth))) { // Check if the whole month is past
                    potentialStart = startOfMonth(dateInMonth);
                    potentialEnd = endOfMonth(dateInMonth);
                    console.log(`Derived range from year/month: ${dateInfo.year}-${dateInfo.month}`);
                }
            } else { // Only Year provided
                 const year = dateInfo.year;
                 const dateInYear = new Date(year, 0); // January 1st of the year
                 if (isValid(dateInYear) && isPast(endOfYear(dateInYear))) { // Check if the whole year is past
                    potentialStart = startOfYear(dateInYear);
                    potentialEnd = endOfYear(dateInYear);
                    console.log(`Derived range from year: ${dateInfo.year}`);
                 }
            }
        }

        // If we found a valid past range, return it (prioritizing the first one found)
        if (potentialStart && potentialEnd && isValid(potentialStart) && isValid(potentialEnd) && isPast(potentialEnd)) {
            return {
                startDate: formatISO(potentialStart),
                endDate: formatISO(potentialEnd),
            };
        }
    }

    console.log("No specific, historical date range could be derived.");
    return null; // No suitable range found
}

// NEW checkOverlap helper function for re-ranking
/**
 * Checks if two arrays share at least one common element.
 * Performs case-insensitive comparison for strings.
 * Handles null/undefined arrays gracefully.
 */
function checkOverlap(arr1?: any[], arr2?: any[]): boolean {
    if (!arr1 || !arr2 || arr1.length === 0 || arr2.length === 0) {
        return false;
    }

    const set1 = new Set(arr1.map(item => (typeof item === 'string' ? item.toLowerCase() : item)));

    for (const item2 of arr2) {
        const normalizedItem2 = typeof item2 === 'string' ? item2.toLowerCase() : item2;
        if (set1.has(normalizedItem2)) {
            return true;
        }
    }

    return false;
}

// ADD NEW parseDateStringToEnhanced function using chrono-node
function parseDateStringToEnhanced(dateString: string, referenceDate: Date): EnhancedNormalizedDate {
    // Chrono parses relative to the referenceDate's timezone context
    const results = chrono.parse(dateString, referenceDate, { forwardDate: true });

    if (!results || results.length === 0) {
        console.log(`Chrono could not parse date string: "${dateString}"`);
        return { original: dateString, note: "Could not parse date." };
    }

    const result = results[0];
    let note = "Parsed successfully.";
    let normalized: string | null = null;

    const components = result.start;
    const year = components.get('year');
    const month = components.get('month');
    const day = components.get('day');
    const hour = components.get('hour');
    const minute = components.get('minute');
    const second = components.get('second');
    const weekday = components.get('weekday');

    const isCertain = components.isCertain('year') && components.isCertain('month') && components.isCertain('day');

    if (isCertain) {
        try {
            // Get the JS Date object from Chrono
            const parsedDateObj = result.date();

            if (!isValid(parsedDateObj)) {
                 throw new Error("Chrono library returned an invalid Date object.");
            }

            // formatISO can represent the date with timezone offset
            normalized = formatISO(parsedDateObj);

            if (!components.isCertain('hour')) {
                 note += " Time component was implied or defaulted by parser.";
             }

        } catch (err) {
            console.error(`Error constructing or formatting Date object for "${dateString}":`, err);
            normalized = null;
            note = "Error during final date construction/formatting.";
        }
    } else {
        normalized = null;
        note = "Partial parse: Year, Month, or Day component missing or uncertain.";
    }

    // --- Add Heuristics for Period/Relative Markers ---
    let period: EnhancedNormalizedDate['period'] = undefined;
    if (components.isCertain('hour') && hour !== null) {
        const h = hour;
        if (h >= 5 && h < 12) period = 'Morning';
        else if (h === 12) period = components.get('meridiem') === 0 ? 'AM' : 'PM'; // Handle noon specifically if AM/PM known
        else if (h > 12 && h < 17) period = 'Afternoon';
        else if (h >= 17 && h < 21) period = 'Evening';
        else period = 'Night'; // Roughly 9 PM to 5 AM

        // Refine if AM/PM is known
        if (components.isCertain('meridiem')) {
             period = components.get('meridiem') === 0 ? 'AM' : 'PM'; // 0=AM, 1=PM
        }
    }

    // Basic relative marker detection
    let relative_marker: EnhancedNormalizedDate['relative_marker'] = undefined;
    if (/last|previous/i.test(dateString)) relative_marker = 'last';
    else if (/next/i.test(dateString)) relative_marker = 'next';
    else if (/this/i.test(dateString)) relative_marker = 'this';

    // Basic relative unit detection
    let relative_unit: EnhancedNormalizedDate['relative_unit'] = undefined;
    if (/day/i.test(dateString)) relative_unit = 'day';
    else if (/week/i.test(dateString)) relative_unit = 'week';
    else if (/month/i.test(dateString)) relative_unit = 'month';
    else if (/year/i.test(dateString)) relative_unit = 'year';
    else if (/weekend/i.test(dateString)) relative_unit = 'weekend';

    const enhancedDate: EnhancedNormalizedDate = {
        original: dateString,
        normalized: normalized,
        note: note,
        year: components.isCertain('year') ? (year ?? undefined) : undefined,
        month: components.isCertain('month') ? (month ?? undefined) : undefined,
        day: components.isCertain('day') ? (day ?? undefined) : undefined,
        day_of_week: components.isCertain('weekday') ? (weekday ?? undefined) : undefined,
        time_hour: components.isCertain('hour') ? (hour ?? undefined) : undefined,
        time_minute: components.isCertain('minute') ? (minute ?? undefined) : undefined,
        time_second: components.isCertain('second') ? (second ?? undefined) : undefined,
        period: period,
        relative_marker: relative_marker,
        relative_unit: relative_unit
    };

    console.log(`Enhanced Parsing Result for '${dateString}':`, JSON.stringify(enhancedDate));
    return enhancedDate;
}

/**
 * Simple text chunking function.
 */
function chunkText(text: string, size: number, overlap: number): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
        const end = Math.min(start + size, text.length);
        chunks.push(text.substring(start, end));
        if (end === text.length) break;
        start += size - overlap;
        // Ensure start doesn't go backward if overlap is large or size is small
        start = Math.max(start, end - overlap);
    }
    return chunks;
}

/**
 * Generates embeddings for an array of text chunks using OpenAI API.
 */
async function generateEmbeddings(chunks: string[]): Promise<(number[] | null)[]> {
    if (!chunks || chunks.length === 0) return [];
    try {
        const response = await openai.embeddings.create({
            model: EMBEDDING_MODEL,
            input: chunks,
            dimensions: EMBEDDING_DIMENSIONS // Specify dimensions for newer models
        });

        // Check if response format is as expected
        if (!response || !response.data || response.data.length !== chunks.length) {
            throw new Error('Unexpected response format from OpenAI embedding API');
        }

        // Sort embeddings back to the original order based on index
        const embeddingsMap = new Map<number, number[]>();
        response.data.forEach(item => {
            embeddingsMap.set(item.index, item.embedding);
        });

        const sortedEmbeddings: (number[] | null)[] = [];
        for (let i = 0; i < chunks.length; i++) {
            sortedEmbeddings.push(embeddingsMap.get(i) || null);
        }
        return sortedEmbeddings;

    } catch (error) {
        console.error("Error generating embeddings:", error);
        throw new Error(`Failed to generate embeddings: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// NEW rerankResults function (Task 5)
/**
 * Re-ranks retrieved context objects based on initial score and metadata overlap.
 */
async function rerankResults(
    candidates: ContextObject[],
    queryMetadata: ProcessedEntities,
    query_source: Extract<SuccessResponse['query_source'], 'vector_store' | 'postgres_fallback_text'>
): Promise<ContextObject[]> {
    if (!candidates || candidates.length === 0) {
        return [];
    }

    console.log(`Re-ranking ${candidates.length} candidates from source: ${query_source}`);

    const scoredCandidates: ScoredContextObject[] = candidates.map(candidate => {
        // a. Map to Scored Objects & b. Calculate initial_score
        let initial_score = 0;
        if (query_source === 'vector_store') {
            // Attempt to access similarity, default to 0 if not present
            initial_score = (candidate as any).similarity || 0;
            // Ensure similarity is within 0-1 range (clamp if necessary, though unlikely)
            initial_score = Math.max(0, Math.min(1, initial_score));
        } else { // postgres_fallback_text
            initial_score = 0.5; // Assign fixed base score for FTS results
        }

        // c. Calculate metadata_boost_score
        let metadata_boost_score = 0.0;
        const candidateEntities = candidate.entities_in_chunk;

        // Check overlaps for different entity types (+0.05 for each type of overlap)
        if (checkOverlap(queryMetadata.people, candidateEntities?.people)) metadata_boost_score += 0.05;
        if (checkOverlap(queryMetadata.locations, candidateEntities?.locations)) metadata_boost_score += 0.05;
        if (checkOverlap(queryMetadata.topics, candidateEntities?.topics)) metadata_boost_score += 0.05;

        // Check for exact match on type
        if (queryMetadata.type && candidateEntities?.type && queryMetadata.type === candidateEntities.type) metadata_boost_score += 0.05;

        // Check for exact match on sentiment
        if (queryMetadata.sentiment && candidateEntities?.sentiment && queryMetadata.sentiment === candidateEntities.sentiment) metadata_boost_score += 0.05;

        // Check for presence of dates in both query and candidate
        if (queryMetadata.dates && queryMetadata.dates.length > 0 && candidateEntities?.dates && candidateEntities.dates.length > 0) metadata_boost_score += 0.05;

        // Language is explicitly excluded

        // d. Calculate final_score
        let final_score = Math.min(1.0, initial_score + metadata_boost_score);

        // e. Populate Scored Object
        return {
            ...candidate,
            initial_score,
            metadata_boost_score,
            final_score,
        };
    });

    // f. Sort by final_score (descending)
    scoredCandidates.sort((a, b) => b.final_score - a.final_score);

    console.log("Scores after re-ranking:", scoredCandidates.map(c => ({ file_id: c.file_id, chunk_index: c.chunk_index, initial: c.initial_score.toFixed(3), boost: c.metadata_boost_score.toFixed(3), final: c.final_score.toFixed(3) })));

    // g. Trim to FINAL_MATCH_COUNT
    const topResults = scoredCandidates.slice(0, FINAL_MATCH_COUNT);

    // h. Map back to ContextObject (removing temporary scores)
    const finalContext: ContextObject[] = topResults.map(scored => {
        const { initial_score, metadata_boost_score, final_score, ...contextObject } = scored;
        return contextObject;
    });

    // i. Return
    console.log(`Returning ${finalContext.length} results after re-ranking.`);
    return finalContext;
}

// --- Handler Function ---
const handler: Handler = async (event: HandlerEvent, context: HandlerContext): Promise<{ statusCode: number; body: string; headers?: { [key: string]: string } }> => {
    const headers = { 'Content-Type': 'application/json' };
    try {
        initializeClients(); // Initialize Supabase and OpenAI clients

        // Authentication
        const providedApiKey = event.headers['x-api-key'];
        if (!providedApiKey || providedApiKey !== actionSecretKey) {
            return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' } as ErrorResponse) };
        }

        // Method Check
        if (event.httpMethod !== 'POST') {
            return { statusCode: 405, headers: { ...headers, 'Allow': 'POST' }, body: JSON.stringify({ error: 'Method Not Allowed' } as ErrorResponse) };
        }

        // Request Body Parsing and Validation
        if (!event.body) {
            throw new Error("Request body is missing.");
        }
        const payload: RequestPayload = JSON.parse(event.body);
        if (!payload.query_text || !payload.mode || !payload.extracted_entities) {
             throw new Error("Missing required fields in request body (query_text, mode, extracted_entities).");
        }

        console.log("Parsed Payload:", { mode: payload.mode, text_length: payload.query_text.length, entities: payload.extracted_entities });

        // Initialize response variables
        let retrieved_context: ContextObject[] = [];
        let storage_status: string = "No storage operation requested.";
        let query_source: SuccessResponse['query_source'] = 'none';
        let message_for_gpt: string | undefined = undefined;
        let fileId: string | null = null;

        // 1. Pre-process extracted entities (normalize dates)
        const referenceDateForNormalization = new Date();
        console.log(`Parsing dates with reference: ${referenceDateForNormalization.toISOString()}`);

        // FIX: Refactor processedMetadata initialization and date parsing assignment
        const initialEntities = payload.extracted_entities;
        // Initialize with other properties, dates will be added after parsing
        let processedMetadata: ProcessedEntities = {
            people: initialEntities.people,
            locations: initialEntities.locations,
            topics: initialEntities.topics,
            type: initialEntities.type,
            sentiment: initialEntities.sentiment,
            priority: initialEntities.priority,
            language: initialEntities.language,
            // Initialize dates as undefined, will be populated below
            dates: undefined
        };

        // Parse dates from the *original* payload's dates array
        if (initialEntities.dates && Array.isArray(initialEntities.dates)) {
            const parsedDates: EnhancedNormalizedDate[] = initialEntities.dates
                .map(dateInput => {
                    // SIMPLIFIED TYPE CHECKING:
                    // 1. Handle string input directly
                    if (typeof dateInput === 'string') {
                        return parseDateStringToEnhanced(dateInput, referenceDateForNormalization);
                    }
                    // 2. Handle object input if it has a valid 'original' string property
                    else if (typeof dateInput === 'object' && dateInput !== null && typeof dateInput.original === 'string') {
                        console.warn(`Re-parsing object with 'original' property: ${JSON.stringify(dateInput)}`);
                        return parseDateStringToEnhanced(dateInput.original, referenceDateForNormalization);
                    }
                    // 3. Handle any other format as unexpected/invalid
                    else {
                        console.warn(`Unexpected date format in extracted_entities: ${JSON.stringify(dateInput)}`);
                        return null; // Invalid input format
                    }
                })
                // Use type guard filter to ensure the result is EnhancedNormalizedDate[]
                .filter((d): d is EnhancedNormalizedDate => d !== null);

            processedMetadata.dates = parsedDates; // Assign the correctly typed array
        } else {
            processedMetadata.dates = []; // Ensure it's an empty array if no dates were input
        }

        console.log("Processed Metadata (Dates Enhanced):", JSON.stringify(processedMetadata));


        // 2. Process based on mode
        if (payload.mode === 'store' || payload.mode === 'combined') {
            console.log("Processing 'store' mode...");
            const textToStore = payload.query_text;

            // Use the processedMetadata which now contains EnhancedNormalizedDate[]
            const fileMetadata: ProcessedEntities = {
                 // Use properties from processedMetadata
                 people: processedMetadata.people,
                 locations: processedMetadata.locations,
                 topics: processedMetadata.topics,
                 type: processedMetadata.type,
                 sentiment: processedMetadata.sentiment,
                 priority: processedMetadata.priority,
                 language: processedMetadata.language || 'en', // Default if not processed
                 dates: processedMetadata.dates, // Assign the newly parsed EnhancedNormalizedDate[]
                 // conversation_id and thread_id are top-level in 'files' table
            };

            console.log("Storing File Metadata:", JSON.stringify(fileMetadata));

            // a. Insert into 'files' table
            console.log("Preparing to insert into files table with processed metadata...");
            const fileInsertData: { [key: string]: any } = {
                transcript_text: textToStore,
                file_metadata: fileMetadata, // Store processed metadata with EnhancedNormalizedDate[]
                title: textToStore.substring(0, 50) + (textToStore.length > 50 ? '...' : ''),
                file_type: 'gpt_interaction',
                // Get conversation/thread IDs from the original payload
                conversation_id: payload.extracted_entities.conversation_id || null,
                thread_id: payload.extracted_entities.thread_id || null,
            };

            const { data: fileData, error: fileError } = await supabase
                .from('files')
                .insert(fileInsertData)
                .select('id')
                .single();

            if (fileError || !fileData) {
                console.error("Error inserting into files table:", fileError);
                throw new Error(`Failed to store file record: ${fileError?.message || 'No ID returned'}`);
            }
            fileId = fileData.id;
            console.log(`File record created with ID: ${fileId}`);


            // b. Chunk the text
            console.log("Chunking text...");
            const chunks = chunkText(textToStore, CHUNK_SIZE, CHUNK_OVERLAP);
            if (chunks.length === 0) {
                 console.warn("No chunks generated for the provided text.");
                 storage_status = `Stored file record (ID: ${fileId}) but no text chunks were generated or stored.`;
                 // Skip embedding if no chunks
            } else {
                 console.log(`Generated ${chunks.length} chunks.`);

                 // c. Generate embeddings for chunks
                 console.log("Generating embeddings...");
                 const embeddings = await generateEmbeddings(chunks);
                 const validEmbeddings = embeddings.filter(e => e !== null) as number[][];
                 if (validEmbeddings.length !== chunks.length) {
                     console.warn("Some embeddings could not be generated.");
                 }

                 if (validEmbeddings.length > 0) {
                     // d. Prepare records for 'transcript_embeddings'
                     const timestamp = new Date().toISOString();
                     const embeddingRecords = chunks.map((chunk, index) => {
                         const embedding = embeddings[index];
                         if (!embedding) return null; // Skip if embedding failed

                         // Store the *full fileMetadata* (including EnhancedNormalizedDate[])
                         // in each chunk's metadata field.
                         const chunkMetadata: ProcessedEntities & { created_at: string; chunk_index: number } = {
                             ...fileMetadata, // Spread the file metadata (contains EnhancedNormalizedDate[])
                             created_at: timestamp,
                             chunk_index: index,
                         };

                         return {
                             file_id: fileId,
                             content_chunk: chunk,
                             embedding: embedding,
                             metadata: chunkMetadata, // Ensure this contains EnhancedNormalizedDate[]
                         };
                     }).filter(record => record !== null);

                     // e. Insert into 'transcript_embeddings' table
                     if (embeddingRecords.length > 0) {
                         console.log(`Inserting ${embeddingRecords.length} embedding records...`);
                         const { error: embeddingError } = await supabase
                             .from('transcript_embeddings')
                             .insert(embeddingRecords as any); // Cast to any if TS complains about embedding type mismatch

                         if (embeddingError) {
                             console.error("Error inserting into transcript_embeddings table:", embeddingError);
                             throw new Error(`Failed to store embeddings: ${embeddingError.message}`);
                         } else {
                              console.log("Embedding records inserted successfully.");
                             storage_status = `Successfully stored file record (ID: ${fileId}) and ${embeddingRecords.length} text chunks with embeddings.`;
                         }
                     } else {
                         console.warn("No valid embedding records to insert.");
                         storage_status = `Stored file record (ID: ${fileId}) but no valid embeddings were generated to store.`;
                     }
                 } else {
                      console.warn("No embeddings were generated successfully.");
                      storage_status = `Stored file record (ID: ${fileId}) but failed to generate any embeddings.`;
                 }
            }
        }

        if (payload.mode === 'query' || payload.mode === 'combined') {
            console.log("Processing 'query' mode...");
            const queryText = payload.query_text;
            // Use processedMetadata which has EnhancedNormalizedDate[]
            const queryMetadata = processedMetadata;

            if (!queryText) {
                 throw new Error("query_text is required for 'query' or 'combined' mode.");
            }

            // a. Generate embedding for the query text
            console.log("Generating embedding for query text...");
            const queryEmbeddings = await generateEmbeddings([queryText]);
            if (!queryEmbeddings || queryEmbeddings.length === 0 || !queryEmbeddings[0]) {
                throw new Error("Failed to generate embedding for the query text.");
            }
            const queryEmbedding = queryEmbeddings[0];

            // b. Vector Search Call Update
            console.log("Attempt 1: Searching via vector search...");

            // UPDATE RPC Call parameters:
            const { data: searchResults, error: searchError } = await supabase.rpc(
                'search_memory_chunks',
                { // Use named parameters matching the *new* SQL function definition
                    query_embedding: queryEmbedding,
                    match_threshold: VECTOR_MATCH_THRESHOLD,
                    match_count: VECTOR_MATCH_COUNT,
                    filter_topics: queryMetadata.topics || null,
                    filter_people: queryMetadata.people || null,
                    filter_locations: queryMetadata.locations || null,
                    filter_type: queryMetadata.type || null,
                    filter_sentiment: queryMetadata.sentiment || null,
                }
            );
            const typedSearchResults = searchResults as SearchResultItem[] | null;

            let vectorSearchFailed = false;
            if (searchError) {
                console.error("Error during vector search RPC call:", searchError);
                query_source = 'error';
                message_for_gpt = `Error during vector search: ${searchError.message}. Trying fallback.`;
                vectorSearchFailed = true;
            } else if (typedSearchResults && typedSearchResults.length > 0) {
                console.log(`Found ${typedSearchResults.length} chunks via vector search.`);
                query_source = 'vector_store';
                // Map results - Ensure dates are handled as EnhancedNormalizedDate[]
                retrieved_context = typedSearchResults.map((result: SearchResultItem) => ({
                    file_id: result.file_id,
                    chunk: result.content_chunk,
                    timestamp: result.metadata?.created_at ?? new Date(0).toISOString(),
                    chunk_index: result.chunk_index,
                    entities_in_chunk: typeof result.metadata === 'object' && result.metadata !== null
                        ? { // Reconstruct entities
                            people: result.metadata.people,
                            dates: (result.metadata.dates as EnhancedNormalizedDate[]) || [],
                            locations: result.metadata.locations,
                            topics: result.metadata.topics,
                            type: result.metadata.type,
                            sentiment: result.metadata.sentiment,
                            priority: result.metadata.priority,
                            language: result.metadata.language,
                          }
                        : {},
                }));
            } else {
                console.log("Vector search yielded no results.");
            }


            // c. Fallback Logic Update
            if (retrieved_context.length === 0) {

                // Attempt Text Search Fallback (Now the primary fallback)
                if (retrieved_context.length === 0) {
                    console.log("Attempt 2: Fallback - Full-Text Search on 'files' table using query entities...");

                    // 1. Gather all string entities from the query metadata (EXCLUDING language)
                    const entityValues: string[] = [];
                    // Include original date strings in FTS query
                    (queryMetadata.dates || []).forEach(d => entityValues.push(d.original));
                    (queryMetadata.people || []).forEach(p => entityValues.push(p));
                    (queryMetadata.locations || []).forEach(l => entityValues.push(l));
                    (queryMetadata.topics || []).forEach(t => entityValues.push(t));
                    if (queryMetadata.type) entityValues.push(queryMetadata.type);
                    if (queryMetadata.sentiment) entityValues.push(queryMetadata.sentiment);
                    // DO NOT include queryMetadata.language

                    // Remove duplicates and empty strings
                    const uniqueEntities = [...new Set(entityValues)].filter(e => e && e.trim() !== '');

                    if (uniqueEntities.length > 0) {
                        // 2. Construct the FTS query string
                        const ftsQueryString = uniqueEntities
                            .map(term => term.replace(/['&|!():*]/g, '')) // Basic escaping
                            .filter(term => term.trim() !== '')
                            .join(' | ');

                        console.log(`Fallback FTS: Searching for entities: ${ftsQueryString}`);

                        // 3. Build the Supabase query with FTS
                        let ftsQueryBuilder = supabase
                            .from('files')
                            .select('id, transcript_text, created_at, file_metadata, rank:ts_rank_cd(transcript_tsv, to_tsquery(\'english\', $1))')
                            .textSearch('transcript_tsv', ftsQueryString, {
                                config: 'english',
                                type: 'websearch'
                            })
                            .order('rank', { ascending: false })
                            .limit(FALLBACK_MATCH_COUNT);

                        // --- START: Integrate Conditional Date Filtering (Task 2b) ---
                        const dateRange = deriveDateRange(queryMetadata.dates); // Pass the processed dates
                        if (dateRange) {
                             console.log(`Applying FTS date range filter: ${dateRange.startDate} to ${dateRange.endDate}`);
                             ftsQueryBuilder = ftsQueryBuilder.gte('created_at', dateRange.startDate);
                             ftsQueryBuilder = ftsQueryBuilder.lte('created_at', dateRange.endDate);
                        }
                         else {
                            console.log("No date range filter applied to FTS.");
                        }
                        // --- END: Integrate Conditional Date Filtering ---

                        // 4. Execute the FTS query
                        console.log("Executing Fallback FTS Query...");
                        const { data: ftsResults, error: ftsError } = await ftsQueryBuilder;
                        const typedTextResults = ftsResults as (FallbackResultItem & { rank?: number })[] | null;

                        if (ftsError) {
                            console.error("Error during fallback FTS search:", ftsError);
                            // Simpler error message handling now
                            if (!vectorSearchFailed) message_for_gpt = `Vector search found nothing. Fallback text search failed: ${ftsError.message}`;
                            else message_for_gpt += ` Fallback text search also failed: ${ftsError.message}`;
                            if (query_source !== 'error') query_source = 'error';
                        } else if (typedTextResults && typedTextResults.length > 0) {
                            console.log(`Found ${typedTextResults.length} files via fallback FTS search.`);
                            query_source = 'postgres_fallback_text'; // Set correct source

                            if (vectorSearchFailed) {
                                message_for_gpt += ` Found ${typedTextResults.length} potential match(es) via text fallback.`;
                            } else {
                                message_for_gpt = `Found ${typedTextResults.length} potential match(es) via text search.`;
                            }

                            // Map results - Ensure dates handled as EnhancedNormalizedDate[]
                            retrieved_context = typedTextResults.map((file) => ({
                                file_id: file.id,
                                chunk: file.transcript_text, // Use full transcript for now
                                timestamp: file.created_at ? new Date(file.created_at).toISOString() : new Date(0).toISOString(),
                                chunk_index: undefined, // FTS is on the whole file
                                entities_in_chunk: typeof file.file_metadata === 'object' && file.file_metadata !== null
                                    ? { /* Reconstruction logic */
                                        people: file.file_metadata.people,
                                        dates: (file.file_metadata.dates as EnhancedNormalizedDate[]) || [],
                                        locations: file.file_metadata.locations,
                                        topics: file.file_metadata.topics,
                                        type: file.file_metadata.type,
                                        sentiment: file.file_metadata.sentiment,
                                        priority: file.file_metadata.priority,
                                        language: file.file_metadata.language,
                                      }
                                    : {},
                            }));
                        } else {
                            console.log("Fallback FTS search also found no results.");
                            if (query_source !== 'error') {
                                query_source = 'none';
                                message_for_gpt = "I couldn't find any relevant information using vector or text search."; // Updated message
                            } else {
                                message_for_gpt += " Fallback text search also found nothing.";
                            }
                        }
                    } else {
                        console.log("No valid non-language entities found in the query to perform FTS fallback, skipping.");
                        if (query_source !== 'error') {
                            query_source = 'none';
                            message_for_gpt = "I couldn't find any relevant information based on the query filters, and no specific entities were provided for text search.";
                        } else {
                            message_for_gpt += " No specific non-language entities provided for text fallback.";
                        }
                    }
                } // End Text Search Fallback attempt

            } // End of Fallback Logic block

            // --- START: Integrate Re-ranking Call (Task 6) ---
            if (retrieved_context.length > 0 && (query_source === 'vector_store' || query_source === 'postgres_fallback_text')) {
                console.log(`Calling rerankResults for ${retrieved_context.length} candidates from ${query_source}...`);
                retrieved_context = await rerankResults(retrieved_context, queryMetadata, query_source);
                // query_source remains unchanged, reflecting the initial retrieval method
            } else {
                 console.log("Skipping re-ranking due to no initial results or non-rankable source.");
            }
            // --- END: Integrate Re-ranking Call ---

        } // End of 'query'/'combined' block

        // ADJUST final message generation to use notes from EnhancedNormalizedDate
        let dateParseNotes: string[] = [];
        if (processedMetadata.dates && Array.isArray(processedMetadata.dates)) {
            dateParseNotes = (processedMetadata.dates as EnhancedNormalizedDate[])
                // Capture notes that indicate partial parses or errors
                .filter(d => d.note && d.note !== "Parsed successfully." && !d.note.startsWith("Parsed successfully. Time component was implied"))
                .map(d => `For date '${d.original}': ${d.note}`);
        }
        if (dateParseNotes.length > 0) {
            const noteMessage = `Notes on date parsing: ${dateParseNotes.join('; ')}`;
            message_for_gpt = message_for_gpt ? `${message_for_gpt} ${noteMessage}` : noteMessage;
            console.log("Appending date parsing notes message:", noteMessage);
        }

        // Final response construction
        console.log(`DEBUG: Final retrieved_context count after potential re-ranking: ${retrieved_context.length}`);

        const successResponse: SuccessResponse = {
            retrieved_context: retrieved_context, // Use the potentially re-ranked context
            storage_status: storage_status,
            query_source: retrieved_context.length > 0 ? query_source : (query_source === 'error' ? 'error' : 'none'), // Refine source logic
            message_for_gpt: message_for_gpt,
            error: null,
        };

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(successResponse),
        };

    } catch (error: unknown) {
        console.error("Handler Error:", error);
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: errorMessage } as ErrorResponse),
        };
    }
};

export { handler }; 