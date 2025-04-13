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
    addYears,
    isFuture,
    isPast,
    isSameDay,
    isBefore,
    isAfter,
    addWeeks,
    addDays,
    set,
    format,
    setDay,
    addMonths,
    getWeek,
    getYear,
    getMonth,
    getDate,
    getDay,
    nextMonday,
    nextTuesday,
    nextWednesday,
    nextThursday,
    nextFriday,
    nextSaturday,
    nextSunday,
    previousMonday,
    previousTuesday,
    previousWednesday,
    previousThursday,
    previousFriday,
    previousSaturday,
    previousSunday,
    parse as dateFnsParse,
    differenceInCalendarDays
} from 'date-fns';

// --- Interfaces for API Contract ---

// Interface for the flexible date input from GPT
export type InputDateEntity = string | { original: string; normalized?: string; };

// Interface for Enhanced Date Components (Stored in Metadata/Context)
// Properties are optional. Includes only date components and period.
export interface EnhancedNormalizedDate {
    year?: number;           // e.g., 2024
    month?: number;          // e.g., 4 (1-12)
    day?: number;            // e.g., 2 (1-31)
    day_of_week?: number;    // e.g., 2 (0=Sun, 1=Mon, 2=Tue...)
    week_number?: number;    // e.g., 14 (ISO 8601 week number, 1-53)
    period?: 'Morning' | 'Afternoon' | 'Evening' | 'Night'; // Derived periods
}

interface ExtractedEntities { // Kept for Request Payload structure
    people?: string[];
    // Input uses flexible date types (string | {original: string, normalized?: string})
    dates?: InputDateEntity[];
    locations?: string[];
    topics?: string[];
    type?: string;
    sentiment?: string;
    priority?: number;
    conversation_id?: string;
    thread_id?: string;
    organizations?: string[]; // Added organizations
    [key: string]: any; // Allow flexible entity types
    source?: 'vector' | 'fts'; // Source of this specific context object before RRF
}

// Interface for entities AFTER internal processing (using EnhancedNormalizedDate)
// This is what gets stored in metadata and returned in context objects.
interface ProcessedEntities {
    people?: string[];
    dates?: EnhancedNormalizedDate[]; // Use the enhanced structure
    locations?: string[];
    topics?: string[];
    organizations?: string[]; // Added organizations
    type?: string;
    sentiment?: string;
    priority?: number;
    conversation_id?: string;
    thread_id?: string;
    rrf_score?: number; // Score after RRF, added internally
}

interface RequestPayload {
    query_text: string;
    extracted_entities: ExtractedEntities; // Input uses the original ExtractedEntities
    mode: 'store' | 'query';
    source?: 'vector' | 'fts'; // Source of this specific context object before RRF
}

interface ContextObject {
    chunk: string;
    timestamp: string; // ISO 8601 format
    entities_in_chunk: ProcessedEntities; // Output uses ProcessedEntities with v1.7 EnhancedNormalizedDate
    file_id: string; // UUID as string - Now guaranteed for both sources
    chunk_id?: string; // UUID as string (from vector search)
    chunk_index?: number; // (from vector search)
    similarity?: number; // Raw vector similarity
    rank?: number; // Raw FTS rank
    // v1.8 additions
    source?: 'vector' | 'fts'; // Source of this specific context object before RRF
}

// Updated SuccessResponse for hybrid source
interface SuccessResponse {
    retrieved_context: ContextObject[]; // Will contain cleaned ContextObjects (no internal scores)
    storage_status: string;
    // Final query source determination
    query_source: 'hybrid' | 'vector' | 'fts' | 'none' | 'error'; // Added vector/fts
    message_for_gpt?: string;
    error: null;
    rank?: number;
}

interface ErrorResponse {
    error: string;
}

// Define interface for the structure returned by search_memory_chunks RPC
interface SearchResultItem {
    file_id: string; // UUID as string
    content_chunk: string;
    // Metadata from DB should now contain ProcessedEntities structure
    metadata?: ProcessedEntities & { created_at?: string; [key: string]: any };
    similarity?: number;
    chunk_index?: number;
}

// Define interface for the structure returned by the fallback files query
interface FallbackResultItem {
    id: string; // UUID as string
    file_id: string; // Alias for id
    transcript_text: string;
    created_at: string | null;
    // file_metadata from DB should now contain ProcessedEntities structure
    file_metadata: ProcessedEntities | null;
    rank?: number;
}

// Interface for internal re-ranking
interface ScoredContextObject extends ContextObject {
    initial_score: number; // Normalized RRF score (0-1)
    metadata_boost_score: number; // Sum of weighted boosts
    final_score: number; // Clamped sum of initial + boost
}

// --- Constants ---
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;
const VECTOR_MATCH_THRESHOLD = 0.4;
const VECTOR_MATCH_COUNT = 15;
const FALLBACK_MATCH_COUNT = 20;
const FINAL_MATCH_COUNT = 5; // Number of results after re-ranking

// RRF constant and Entity Weighting for re-ranking
const RRF_K = 60; // RRF constant
const ENTITY_WEIGHTS = {
    people: 0.10,
    locations: 0.10,
    topics: 0.05,
    organizations: 0.10, // Added organizations weight
    type: 0.05,
    sentiment: 0.05,
    date_day: 0.15,     // Highest date precision
    date_month: 0.10,   // Medium date precision
    date_year: 0.05,    // Lowest date precision
    date_period: 0.05,  // Morning, Afternoon, etc.
    fts_date_range: 0.10 // Boost for FTS results falling in query date range (applied once)
};

// Simple list of common English stop words - Keep as is
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
                persistSession: false
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

/**
 * Stemmer helper function: Takes a string, splits into words, removes stop words,
 * stems remaining words, and returns a Set of unique stems.
 */
function getStemmedWordSet(text?: string | string[]): Set<string> {
    const stemmedSet = new Set<string>();
    if (!text) return stemmedSet;

    const items = Array.isArray(text) ? text : [text];

    items.forEach(item => {
        if (typeof item === 'string') {
            const words = item.toLowerCase().split(/\s+/);
            words.forEach(word => {
                const cleanWord = word.replace(/[^a-z0-9]/gi, ''); // Remove punctuation
                if (cleanWord && !STOP_WORDS.has(cleanWord)) {
                    stemmedSet.add(stemmer(cleanWord));
                }
            });
        }
    });
    return stemmedSet;
}

/**
 * Checks if there's any overlap between two Sets of strings.
 */
function checkSetOverlap(set1: Set<string>, set2: Set<string>): boolean {
    if (!set1 || !set2 || set1.size === 0 || set2.size === 0) return false;
    for (const item of set1) {
        if (set2.has(item)) {
            return true;
        }
    }
    return false;
}

// --- START: Date Parsing Helper Functions ---

/**
 * Parses a date string in "Month DD, YYYY" format using date-fns.
 * @param normalizedDateString The date string (e.g., "April 11, 2025").
 * @param referenceDate The reference date (currently unused for this format).
 * @returns A partial EnhancedNormalizedDate object with date components, or empty if parsing fails.
 */
function parseNormalizedDate(normalizedDateString: string, referenceDate: Date): Partial<EnhancedNormalizedDate> {
    console.log(`Parsing normalized date string: "${normalizedDateString}"`);
    const result: Partial<EnhancedNormalizedDate> = {};
    try {
        // Use 'MMMM d, yyyy' to handle single-digit days correctly (e.g., "May 1, 2025")
        const parsedDate = dateFnsParse(normalizedDateString, 'MMMM d, yyyy', referenceDate);

        if (isValid(parsedDate)) {
            console.log(`  -> Successfully parsed to date: ${parsedDate.toISOString()}`);
            result.year = getYear(parsedDate);
            result.month = getMonth(parsedDate) + 1; // Adjust to 1-12
            result.day = getDate(parsedDate);
            result.day_of_week = getDay(parsedDate); // 0=Sun, 6=Sat
            try {
                result.week_number = getWeek(parsedDate, { weekStartsOn: 1 }); // ISO week number (Monday=1)
            } catch (e) {
                console.warn(`Could not determine week number for ${normalizedDateString}:`, e);
            }
        } else {
            console.warn(`  -> Failed to parse normalized date string: "${normalizedDateString}" using format 'MMMM d, yyyy'.`);
        }
    } catch (e) {
        console.error(`Error parsing normalized date string "${normalizedDateString}":`, e);
    }
    return result;
}

/**
 * Extracts ONLY the period of day (Morning, Afternoon, Evening, Night)
 * from the original date/time string based on keywords.
 * Does not attempt to parse specific hours or minutes.
 *
 * @param originalString The original date string provided by the user/GPT.
 * @returns An object containing only the `period` if found, otherwise an empty object.
 */
function extractTimeInfo(originalString: string): Partial<EnhancedNormalizedDate> {
    const lowerCaseString = originalString.toLowerCase();
    const components: Partial<EnhancedNormalizedDate> = {};

    // Define keywords for periods
    const periods = {
        Morning: [/\bmorning\b/, /\b(?:am|a\.m\.)\b/],
        Afternoon: [/\bafternoon\b/, /\bnoon\b/, /\b(?:pm|p\.m\.)\b/], // Treat PM as Afternoon/Evening
        Evening: [/\bevening\b/, /\b(?:pm|p\.m\.)\b/, /\b(?:eod|cob)\b/], // EOD/COB likely Evening
        Night: [/\bnight\b/, /\bmidnight\b/]
    };

    // Check for period keywords (prioritize later periods if both AM/PM and keyword exist)
    if (periods.Night.some(regex => regex.test(lowerCaseString))) {
        components.period = 'Night';
    } else if (periods.Evening.some(regex => regex.test(lowerCaseString))) {
        components.period = 'Evening';
    } else if (periods.Afternoon.some(regex => regex.test(lowerCaseString))) {
        // If PM is found, but not Evening/Night keywords, default to Afternoon
        components.period = 'Afternoon';
    } else if (periods.Morning.some(regex => regex.test(lowerCaseString))) {
        components.period = 'Morning';
    }

    // Simple PM check to potentially override Morning to Afternoon if only PM is specified without other keywords
    if (/\b(?:pm|p\.m\.)\b/.test(lowerCaseString) && components.period === 'Morning') {
         components.period = 'Afternoon'; // Or Evening? Afternoon is safer default.
    }

    // Remove chrono-node usage as it's not needed for period-only extraction
    // console.log(`     -> Final time components extracted: ${JSON.stringify(components)}`);
    return components;
}

/**
 * Parses an original date string (when GPT couldn't normalize) using only date-fns.
 * Attempts a limited set of common, unambiguous formats. Does NOT use chrono-node.
 * @param originalString The raw date string from user input or entities.
 * @param referenceDate The reference date for context (e.g., for year inference if needed).
 * @returns A partial EnhancedNormalizedDate object with date components, or empty if parsing fails.
 */
function parseOriginalStringDate(originalString: string, referenceDate: Date): Partial<EnhancedNormalizedDate> {
    console.log(`Parsing original (non-normalized) date string: "${originalString}"`);
    const result: Partial<EnhancedNormalizedDate> = {};
    // Prioritize formats that are less ambiguous or common first
    const formatsToTry = [
        'MM/dd/yyyy', 'M/d/yyyy',
        'yyyy-MM-dd',
        'yyyy/MM/dd',
        'MMMM d, yyyy', 'MMM d, yyyy', // "April 11, 2025", "Apr 11, 2025"
        'MMMM dd, yyyy', 'MMM dd, yyyy', // "April 11, 2025", "Apr 11, 2025"
        'd MMMM yyyy', 'd MMM yyyy', // "11 April 2025", "11 Apr 2025"
        'dd MMMM yyyy', 'dd MMM yyyy' // "11 April 2025", "11 Apr 2025"
        // Add more unambiguous formats if needed, but avoid overly flexible ones
    ];

    // Attempt to crudely strip ordinals (st, nd, rd, th) before parsing
    const stringWithoutOrdinals = originalString.replace(/(?<=\d)(st|nd|rd|th)/gi, '');

    for (const format of formatsToTry) {
        try {
            const parsedDate = dateFnsParse(stringWithoutOrdinals, format, referenceDate);
            if (isValid(parsedDate)) {
                console.log(`  -> Successfully parsed original string using format '${format}': ${parsedDate.toISOString()}`);
                result.year = getYear(parsedDate);
                result.month = getMonth(parsedDate) + 1;
                result.day = getDate(parsedDate);
                result.day_of_week = getDay(parsedDate);
                try {
                    result.week_number = getWeek(parsedDate, { weekStartsOn: 1 });
                } catch (e) {
                    console.warn(`  -> Could not determine week number for ${originalString}:`, e);
                }
                // Successfully parsed, break the loop
                return result;
            }
        } catch (e) {
            // Ignore errors and try the next format
        }
    }

    // If no format matched:
    console.warn(`  -> Failed to parse original date string "${originalString}" using any of the predefined date-fns formats.`);
    return {}; // Return empty object indicating failure
}

// --- END: Date Parsing Helper Functions ---

/**
 * Processes the raw date entities extracted by GPT, parsing and normalizing them.
 * @param rawInputDates The array of date entities from the request payload.
 * @param referenceDate The current date/time to use as a reference for parsing relative dates.
 * @returns An array of successfully parsed and structured EnhancedNormalizedDate objects.
 */
function processInputDates(
    rawInputDates: InputDateEntity[] | undefined,
    referenceDate: Date
): EnhancedNormalizedDate[] {
    const successfullyParsedDates: EnhancedNormalizedDate[] = [];
    console.log("Parsing dates with reference:", referenceDate.toISOString());

    if (!rawInputDates || !Array.isArray(rawInputDates)) {
        return successfullyParsedDates; // Return empty if no valid input
    }

    for (const dateEntity of rawInputDates) { // Use for...of for clarity
        let originalString: string;
        let normalizedDateString: string | undefined = undefined;
        let datePart: Partial<EnhancedNormalizedDate> = {};

        // 1. Determine original string and potential normalized string
        if (typeof dateEntity === 'string') {
            originalString = dateEntity;
            console.log(`Processing date entity (string): "${originalString}"`);
        } else if (dateEntity && typeof dateEntity === 'object' && typeof dateEntity.original === 'string') {
            originalString = dateEntity.original;
            normalizedDateString = dateEntity.normalized ?? undefined; // Use nullish coalescing
            console.log(`Processing date entity (object): original="${originalString}", normalized="${normalizedDateString}"`);
        } else {
            console.warn("Skipping invalid date input format:", dateEntity);
            continue; // Skip this iteration
        }

        // 2. Parse Date Part
        if (normalizedDateString) {
            // Prioritize parsing the GPT-provided normalized date ("Month DD, YYYY")
            datePart = parseNormalizedDate(normalizedDateString, referenceDate);
        } else {
            // If no normalized date, attempt to parse the original string using date-fns only
            datePart = parseOriginalStringDate(originalString, referenceDate);
        }

        // 3. Always Extract Time Part from Original String
        const timePart = extractTimeInfo(originalString);

        // 4. Combine Date and Time Parts
        const combinedComponents: Partial<EnhancedNormalizedDate> = { ...datePart, ...timePart };

        // 5. Validation & Storage
        // Store if we have at least year/month/day OR if we have only period
        // (avoids storing empty objects if all parsing failed)
        if (Object.keys(combinedComponents).length > 0 &&
            (combinedComponents.year || combinedComponents.month || combinedComponents.day ||
                // Check only for period if date components are missing
                (!combinedComponents.year && !combinedComponents.month && !combinedComponents.day && (combinedComponents.period))))
        {
            console.log(`  -> Storing combined components: ${JSON.stringify(combinedComponents)}`);
            successfullyParsedDates.push(combinedComponents as EnhancedNormalizedDate); // Add the valid, combined object
        } else {
            console.warn(`  -> Discarding components for "${originalString}" as no core date/time info was extracted: ${JSON.stringify(combinedComponents)}`);
        }
    }
     console.log("--- Finished Date Processing ---");
    return successfullyParsedDates;
}

/**
 * Safely maps raw database metadata (from vector or FTS search)
 * to the ProcessedEntities structure used in ContextObjects.
 */
function mapDbMetadataToProcessedEntities(metadata: any): ProcessedEntities {
    if (typeof metadata !== 'object' || metadata === null) {
        return {}; // Return empty object if metadata is invalid or missing
    }
    return {
        people: metadata.people || [],
        // Ensure dates are correctly typed or default to empty array
        dates: Array.isArray(metadata.dates) ? metadata.dates as EnhancedNormalizedDate[] : [],
        locations: metadata.locations || [],
        topics: metadata.topics || [],
        organizations: metadata.organizations || [], // Added organizations mapping
        type: metadata.type || undefined,
        sentiment: metadata.sentiment || undefined,
        priority: metadata.priority || undefined,
        // conversation_id and thread_id are not typically stored in chunk/file metadata
    };
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
            dimensions: EMBEDDING_DIMENSIONS
        });

        if (!response || !response.data || response.data.length !== chunks.length) {
            throw new Error('Unexpected response format from OpenAI embedding API');
        }

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

// Re-ranks retrieved context objects based on initial score and metadata overlap.
async function rerankResults(
    candidates: (ContextObject & { rrf_score?: number })[],
    queryMetadata: ProcessedEntities
): Promise<ContextObject[]> {
    if (!candidates || candidates.length === 0) {
        return [];
    }

    console.log(`Re-ranking ${candidates.length} candidates...`);

    // --- Pre-calculate stemmed sets for the query metadata --- START
    const queryPeopleStems = getStemmedWordSet(queryMetadata.people);
    const queryLocationsStems = getStemmedWordSet(queryMetadata.locations);
    const queryTopicsStems = getStemmedWordSet(queryMetadata.topics);
    const queryOrganizationsStems = getStemmedWordSet(queryMetadata.organizations); // Added organizations stems
    console.log("Query Stems:", {
        people: Array.from(queryPeopleStems),
        locations: Array.from(queryLocationsStems),
        topics: Array.from(queryTopicsStems),
        organizations: Array.from(queryOrganizationsStems) // Added logging
    });
    // --- Pre-calculate stemmed sets for the query metadata --- END

    // 1. Normalize RRF Scores (Min-Max Scaling to 0-1)
    let minRrfScore = Infinity;
    let maxRrfScore = -Infinity;
    candidates.forEach(c => {
        if (c.rrf_score !== undefined) {
            minRrfScore = Math.min(minRrfScore, c.rrf_score);
            maxRrfScore = Math.max(maxRrfScore, c.rrf_score);
        }
    });

    const range = maxRrfScore - minRrfScore;

    // Define the normalization function (Moved here)
    const normalize = (score: number | undefined): number => {
        if (score === undefined) return 0; // Handle undefined scores
        if (range === 0) return 1; // Avoid division by zero if all scores are the same
        return (score - minRrfScore) / range;
    };

    const scoredCandidates: ScoredContextObject[] = candidates.map(candidate => {
        // a. Calculate initial_score (Normalized RRF Score 0-1)
        const initial_score = normalize(candidate.rrf_score);

        // b. Calculate metadata_boost_score (Sum of weighted boosts based on ENTITY_WEIGHTS)
        let metadata_boost_score = 0.0;
        const candidateEntities = candidate.entities_in_chunk;

        // --- Calculate stemmed sets for the candidate metadata --- START
        const candidatePeopleStems = getStemmedWordSet(candidateEntities?.people);
        const candidateLocationsStems = getStemmedWordSet(candidateEntities?.locations);
        const candidateTopicsStems = getStemmedWordSet(candidateEntities?.topics);
        const candidateOrganizationsStems = getStemmedWordSet(candidateEntities?.organizations); // Added organizations stems
        // --- Calculate stemmed sets for the candidate metadata --- END

        // Check entity overlaps using stemmed sets and add weights
        if (checkSetOverlap(queryPeopleStems, candidatePeopleStems)) {
            metadata_boost_score += ENTITY_WEIGHTS.people;
            console.log(`Applied boost: +${ENTITY_WEIGHTS.people} (people - stemmed) for candidate ${candidate.file_id} chunk ${candidate.chunk_index}`);
        }
        if (checkSetOverlap(queryLocationsStems, candidateLocationsStems)) {
            metadata_boost_score += ENTITY_WEIGHTS.locations;
            console.log(`Applied boost: +${ENTITY_WEIGHTS.locations} (locations - stemmed) for candidate ${candidate.file_id} chunk ${candidate.chunk_index}`);
        }
        if (checkSetOverlap(queryTopicsStems, candidateTopicsStems)) {
            metadata_boost_score += ENTITY_WEIGHTS.topics;
            console.log(`Applied boost: +${ENTITY_WEIGHTS.topics} (topics - stemmed) for candidate ${candidate.file_id} chunk ${candidate.chunk_index}`);
        }
        if (checkSetOverlap(queryOrganizationsStems, candidateOrganizationsStems)) { // Added organizations check
            metadata_boost_score += ENTITY_WEIGHTS.organizations;
            console.log(`Applied boost: +${ENTITY_WEIGHTS.organizations} (organizations - stemmed) for candidate ${candidate.file_id} chunk ${candidate.chunk_index}`);
        }

        // Check for exact match on type (no stemming needed)
        if (queryMetadata.type && candidateEntities?.type && queryMetadata.type.toLowerCase() === candidateEntities.type.toLowerCase()) {
            metadata_boost_score += ENTITY_WEIGHTS.type;
            console.log(`Applied boost: +${ENTITY_WEIGHTS.type} (type) for candidate ${candidate.file_id} chunk ${candidate.chunk_index}`);
        }

        // Check for exact match on sentiment (no stemming needed)
        if (queryMetadata.sentiment && candidateEntities?.sentiment && queryMetadata.sentiment.toLowerCase() === candidateEntities.sentiment.toLowerCase()) {
            metadata_boost_score += ENTITY_WEIGHTS.sentiment;
            console.log(`Applied boost: +${ENTITY_WEIGHTS.sentiment} (sentiment) for candidate ${candidate.file_id} chunk ${candidate.chunk_index}`);
        }

        // --- START: Granular Date Matching Boost (using ENTITY_WEIGHTS) ---
        let dateBoostApplied = 0.0; // Track total date boost for logging
        if (queryMetadata.dates && queryMetadata.dates.length > 0 && candidateEntities?.dates && candidateEntities.dates.length > 0) {
            for (const queryDate of queryMetadata.dates) {
                let bestMatchBoostForQueryDate = 0.0;
                for (const candidateDate of candidateEntities.dates) {
                    let currentMatchBoost = 0.0;
                    // Day-Level Match
                    if (queryDate.year && queryDate.month && queryDate.day &&
                        candidateDate.year === queryDate.year &&
                        candidateDate.month === queryDate.month &&
                        candidateDate.day === queryDate.day) {
                        currentMatchBoost = ENTITY_WEIGHTS.date_day;
                    }
                    // Month-Level Match
                    else if (queryDate.year && queryDate.month &&
                             candidateDate.year === queryDate.year &&
                             candidateDate.month === queryDate.month) {
                        currentMatchBoost = Math.max(currentMatchBoost, ENTITY_WEIGHTS.date_month);
                    }
                    // Year-Level Match
                    else if (queryDate.year && candidateDate.year === queryDate.year) {
                        currentMatchBoost = Math.max(currentMatchBoost, ENTITY_WEIGHTS.date_year);
                    }

                    // Check Period Match (Independent of date components)
                    if (queryDate.period && candidateDate.period && queryDate.period === candidateDate.period) {
                        // Add period boost *in addition* to any date component boost found
                        currentMatchBoost += ENTITY_WEIGHTS.date_period;
                    }

                    // Keep the highest boost found for this queryDate across all candidateDates
                    bestMatchBoostForQueryDate = Math.max(bestMatchBoostForQueryDate, currentMatchBoost);
                    // If we found the best possible date match (day level), no need to check other candidateDates for this queryDate's DATE components
                    // However, we might still need to check for a period match on other candidateDates if the first one didn't have it.
                    // Simplification: Assume highest boost found so far is good enough for this queryDate.
                    // Potential refinement: Could track best date boost and best period boost separately.
                }
                // Add the best boost found for *this specific queryDate* to the running total
                metadata_boost_score += bestMatchBoostForQueryDate;
                dateBoostApplied += bestMatchBoostForQueryDate; // Accumulate for logging
            }
            if (dateBoostApplied > 0) {
                console.log(`Applied total date/period boost: +${dateBoostApplied.toFixed(3)} for candidate ${candidate.file_id} chunk ${candidate.chunk_index}`);
            }
        }
        // --- END: Granular Date Matching Boost ---

        // Language is explicitly excluded

        // --- FTS Date Range Boost (Using ENTITY_WEIGHTS.fts_date_range) ---
        let ftsRangeBoostApplied = false; // Ensure applied only once per candidate
        if (candidate.source === 'fts' && queryMetadata.dates && queryMetadata.dates.length > 0) {
            for (const queryDate of queryMetadata.dates) {
                if (queryDate.year && queryDate.month && queryDate.day) {
                    try {
                        const rangeDate = new Date(queryDate.year, queryDate.month - 1, queryDate.day);
                        if (isValid(rangeDate)) { // Check if the constructed date is valid
                             const rangeStart = startOfDay(rangeDate);
                             const rangeEnd = endOfDay(rangeDate);
                             const candidateTimestamp = parseISO(candidate.timestamp);

                            if (isValid(candidateTimestamp) && candidateTimestamp >= rangeStart && candidateTimestamp <= rangeEnd) {
                                console.log(`Applying FTS date range boost: +${ENTITY_WEIGHTS.fts_date_range} (timestamp: ${candidate.timestamp} within ${formatISO(rangeStart)}-${formatISO(rangeEnd)})`);
                                metadata_boost_score += ENTITY_WEIGHTS.fts_date_range;
                                ftsRangeBoostApplied = true;
                                break; // Apply boost only once per candidate, as confirmed
                            }
                        }
                    } catch (e) { console.warn(`Error processing date for FTS boost from queryDate ${JSON.stringify(queryDate)}:`, e); }
                }
                 if (ftsRangeBoostApplied) break; // Break outer loop if boost already applied
            }
        }

        // c. Calculate final_score (Clamped between 0 and 1)
        let final_score = Math.min(1.0, initial_score + metadata_boost_score);
        // Ensure final_score is not negative (though unlikely with current boosts)
        final_score = Math.max(0.0, final_score);

        // d. Populate Scored Object
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

// --- START: Hybrid Search Helper Functions ---

/**
 * Executes the vector search RPC call against Supabase.
 * @param embedding The query embedding vector.
 * @returns A promise resolving to an array of ContextObjects from vector search, or empty array on error.
 */
async function executeVectorSearch(
    embedding: number[]
): Promise<ContextObject[]> {
    console.log("Executing Vector Search...");
    try {
        const { data: searchResults, error: searchError } = await supabase.rpc(
            'search_memory_chunks',
            { // Use named parameters matching the simplified SQL function definition
                query_embedding: embedding,
                match_threshold: VECTOR_MATCH_THRESHOLD,
                match_count: VECTOR_MATCH_COUNT // Get more results initially for RRF
            }
        );

        if (searchError) {
            console.error("Error during vector search RPC call:", searchError);
            return []; // Return empty on error
        }

        // Add logging for raw results count
        const typedSearchResults = searchResults as SearchResultItem[] | null;
        console.log(`  -> Vector search raw results count: ${typedSearchResults?.length ?? 0}`);

        if (typedSearchResults && typedSearchResults.length > 0) {
            // Map results to ContextObject, adding source and preserving similarity
            return typedSearchResults.map(result => ({
                chunk: result.content_chunk,
                timestamp: result.metadata?.created_at ?? new Date(0).toISOString(),
                entities_in_chunk: mapDbMetadataToProcessedEntities(result.metadata),
                file_id: result.file_id,
                chunk_id: undefined, // chunk_id not returned by current RPC, adjust if needed
                chunk_index: result.chunk_index,
                similarity: result.similarity,
                source: 'vector', // Set source
                rank: undefined, // Not applicable for vector
            }));
        } else {
            console.log("Vector search yielded no results.");
            return [];
        }
    } catch (error) {
        console.error("Unexpected error during vector search execution:", error);
        return []; // Return empty on unexpected errors
    }
}

/**
 * Executes the Full-Text Search (FTS) query against the 'files' table.
 * @param queryText The original user query text for FTS.
 * @returns A promise resolving to an array of ContextObjects from FTS search, or empty array on error.
 */
async function executeFtsSearch(
    queryText: string
): Promise<ContextObject[]> {
    console.log("Executing FTS Search...");
    try {
        // 1. Use the raw queryText directly for FTS
        if (!queryText || queryText.trim() === '') {
            console.log("No valid query text provided for FTS query.");
            return [];
        }

        const ftsQueryString = queryText; // Use the full query text

        console.log(`FTS Search: Using query string: "${ftsQueryString}"`);

        // 3. Build the Supabase query with FTS
        const { data: ftsResults, error: ftsError } = await supabase.rpc(
            'fts_search_files',
            {
                query_string: ftsQueryString, // Pass the original query text
                match_count: FALLBACK_MATCH_COUNT // Pass the desired match count
            }
        );

        if (ftsError) {
            console.error("Error during FTS search RPC call:", ftsError);
            return [];
        }
        // Cast directly to the expected structure from the RPC
        const typedTextResults = ftsResults as any as FallbackResultItem[] | null;

        if (typedTextResults && typedTextResults.length > 0) {
            console.log(`FTS search found ${typedTextResults.length} raw results via RPC.`);
            // Map results to ContextObject, adding source and preserving rank
            return typedTextResults.map(file => ({
                // Truncate transcript_text, provide default for created_at if null
                chunk: (file.transcript_text || '').substring(0, 3000) + ((file.transcript_text?.length || 0) > 3000 ? '...' : ''),
                timestamp: file.created_at ? new Date(file.created_at).toISOString() : new Date(0).toISOString(),
                entities_in_chunk: mapDbMetadataToProcessedEntities(file.file_metadata),
                file_id: file.id, // Use 'id' from RPC result as file_id
                chunk_id: undefined, // Not applicable for FTS
                chunk_index: undefined, // Not applicable for FTS
                similarity: undefined, // Not applicable for FTS
                rank: file.rank, // Preserve raw FTS rank from RPC result
                source: 'fts', // Set source
            }));
        } else {
            console.log("FTS search yielded no results.");
            return [];
        }
    } catch (error) {
        console.error("Unexpected error during FTS search execution:", error);
        return [];
    }
}

/**
 * Applies Reciprocal Rank Fusion (RRF) to combine results from vector and FTS searches.
 * @param vectorResults Array of ContextObjects from vector search.
 * @param ftsResults Array of ContextObjects from FTS search.
 * @param k The RRF ranking constant (default: 60).
 * @returns A single array of ContextObjects sorted by descending RRF score, with rrf_score property added.
 */
function applyRRF(
    vectorResults: ContextObject[],
    ftsResults: ContextObject[],
    k: number = RRF_K
): ContextObject[] {
    console.log(`Applying RRF with k=${k} to ${vectorResults.length} vector and ${ftsResults.length} FTS results.`);
    // Use file_id as the primary key for fusion
    const rrfScores = new Map<string, { score: number; context: ContextObject }>();

    // Process vector results (ranked by index implicitly)
    vectorResults.forEach((result, index) => {
        const rank = index + 1;
        const scoreIncrement = 1 / (k + rank);
        const existing = rrfScores.get(result.file_id);
        if (existing) {
            existing.score += scoreIncrement;
            // Keep the vector context if collision (usually more granular)
        } else {
            rrfScores.set(result.file_id, { score: scoreIncrement, context: result });
        }
    });

    // Process FTS results (ranked by index implicitly)
    ftsResults.forEach((result, index) => {
        const rank = index + 1;
        const scoreIncrement = 1 / (k + rank);
        const existing = rrfScores.get(result.file_id);
        if (existing) {
            existing.score += scoreIncrement;
            // If vector context exists, don't overwrite. FTS rank is stored on its context object.
        } else {
            // Only add if not already present from vector search
            rrfScores.set(result.file_id, { score: scoreIncrement, context: result });
        }
    });

    // Convert map to array and sort by RRF score descending
    const fusedResults = Array.from(rrfScores.values())
        .sort((a, b) => b.score - a.score);

    console.log(`RRF produced ${fusedResults.length} fused results.`);

    // Map back to ContextObject[], adding the rrf_score
    return fusedResults.map(item => ({
        ...item.context,
        rrf_score: item.score // Add the calculated RRF score
    }));
}

// --- END: Hybrid Search Helper Functions ---

// --- Main Handler Function ---
const handler: Handler = async (event: HandlerEvent, context: HandlerContext): Promise<{ statusCode: number; body: string; headers?: { [key: string]: string } }> => {
    const headers = { 'Content-Type': 'application/json' };

    // Helper function to determine the final query_source for the response
    // Defined within handler scope to access handler-scoped variables
    function determineFinalQuerySource(
        finalContext: ContextObject[],
        initialQuerySource: SuccessResponse['query_source'],
        vectorResults: ContextObject[],
        ftsResults: ContextObject[]
    ): SuccessResponse['query_source'] {
        if (initialQuerySource === 'error') {
            return 'error'; // Preserve error state
        }
        if (finalContext.length === 0) {
            return 'none'; // No results after re-ranking
        }

        // Check sources present in the final context
        const hasVector = finalContext.some(c => c.source === 'vector');
        const hasFts = finalContext.some(c => c.source === 'fts');

        if (hasVector && hasFts) {
            return 'hybrid';
        } else if (hasVector) {
            return 'vector';
        } else if (hasFts) {
            return 'fts';
        } else {
            console.warn("Final context not empty, but no vector or fts source detected. Returning 'none'.");
            return 'none';
        }
    }

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
        let storage_status: string = "No storage operation performed.";
        // Default query source to 'none', will be updated based on search results
        let query_source: SuccessResponse['query_source'] = 'none';
        let message_for_gpt: string = ""; // Initialize message for GPT

        // --- Declare result arrays here to ensure scope --- START
        let vectorResults: ContextObject[] = [];
        let ftsResults: ContextObject[] = [];
        // --- Declare result arrays here to ensure scope --- END

        // --- Date Processing ---
        // Encapsulated date processing logic
        const referenceDate = new Date(); // Use current server time as reference
        const successfullyParsedDates = processInputDates(payload.extracted_entities.dates, referenceDate);

        // Prepare metadata object using the processed dates
        const processedMetadata: ProcessedEntities = {
             // Spread other entities first
            ...(payload.extracted_entities as Omit<ExtractedEntities, 'dates'>), // Cast to omit dates for type safety
            organizations: payload.extracted_entities.organizations || [], // Added organizations
            dates: successfullyParsedDates // Assign the processed dates array
        };
        // Remove language if present, as per instructions (though we decided to ignore the field overall later)
        // delete processedMetadata.language;

        console.log("Final Processed Metadata (excluding language):", JSON.stringify(processedMetadata));
        // --- END: Date Processing ---

        // Mode handling: store or query
        const mode = payload.mode; // mode is now only 'store' or 'query'
        let queryEmbedding: number[] | null = null; // Initialize query embedding

        // 2. Process based on mode
        if (payload.mode === 'store') {
            console.log("Processing 'store' mode...");
            const textToStore = payload.query_text;

            // Use the processedMetadata which now contains EnhancedNormalizedDate[]
            const fileMetadata: ProcessedEntities = {
                 // Use properties from processedMetadata
                 people: processedMetadata.people,
                 locations: processedMetadata.locations,
                 topics: processedMetadata.topics,
                 organizations: processedMetadata.organizations, // Added organizations
                 type: processedMetadata.type,
                 sentiment: processedMetadata.sentiment,
                 priority: processedMetadata.priority,
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
            const fileId = fileData.id;
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
                 const validChunks = chunks.filter((_, i) => embeddings[i] !== null);

                 if (validEmbeddings.length === 0) {
                     throw new Error("Failed to generate any valid embeddings.");
                 }

                 if (validChunks.length > 0) {
                     // d. Prepare records for 'transcript_embeddings'
                     const timestamp = new Date().toISOString();
                     const embeddingRecords = validChunks.map((chunk, index) => ({
                         file_id: fileId,
                         content_chunk: chunk,
                         embedding: validEmbeddings[index],
                         metadata: {
                             ...fileMetadata,
                             created_at: timestamp,
                             chunk_index: index,
                         },
                     }));

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

        if (payload.mode === 'query') {
            console.log("Processing 'query' mode...");
            const queryText = payload.query_text;
            // Use processedMetadata which has EnhancedNormalizedDate[]
            const queryMetadata = processedMetadata;
             // FTS uses the full query_text from the payload
            const originalQueryEntities = payload.extracted_entities;

            if (!queryText) {
                 throw new Error("query_text is required for 'query' or 'combined' mode.");
            }

            // a. Generate embedding for the query text
            console.log("Generating embedding for query text...");
            try {
                const queryEmbeddingResponse = await openai.embeddings.create({
                    model: EMBEDDING_MODEL,
                    input: queryText,
                    dimensions: EMBEDDING_DIMENSIONS,
                });
                queryEmbedding = queryEmbeddingResponse?.data[0]?.embedding;
                if (!queryEmbedding) {
                    throw new Error("Failed to generate query embedding (empty response).");
                }
            } catch (embeddingError) {
                 console.error("Error generating query embedding:", embeddingError);
                 // Don't throw here, allow FTS to proceed if embedding fails
                 message_for_gpt = `Warning: Failed to generate query embedding. Proceeding with text search only. Error: ${embeddingError instanceof Error ? embeddingError.message : String(embeddingError)}`;
                 query_source = 'error'; // Indicate an error occurred, even if FTS works
            }


            // b. Execute Concurrent Searches (Vector + FTS)
            console.log("--- Starting Concurrent Search ---");
            // Only run vector search if embedding was successful
            const searchPromises: Promise<ContextObject[]>[] = [];
            if (queryEmbedding) {
                searchPromises.push(executeVectorSearch(queryEmbedding));
            } else {
                 searchPromises.push(Promise.resolve([])); // Add placeholder if embedding failed
            }
            // Always run FTS search
            searchPromises.push(executeFtsSearch(queryText));


            const searchResultsSettled = await Promise.allSettled(searchPromises);

            if (searchResultsSettled[0].status === 'fulfilled') {
                 vectorResults = searchResultsSettled[0].value;
            } else {
                 console.error("Vector search promise rejected:", searchResultsSettled[0].reason);
                 if(query_source !== 'error') message_for_gpt += " Vector search failed."; // Append if no embedding error yet
                 query_source = 'error';
            }

            if (searchResultsSettled[1].status === 'fulfilled') {
                 ftsResults = searchResultsSettled[1].value;
            } else {
                 console.error("FTS search promise rejected:", searchResultsSettled[1].reason);
                  if(query_source !== 'error') message_for_gpt += " Text search failed.";
                  query_source = 'error';
            }

            console.log(`--- Concurrent Search Finished ---`);
            console.log(`Raw Counts - Vector: ${vectorResults.length}, FTS: ${ftsResults.length}`);

            // c. Apply RRF
            console.log("--- Starting RRF Combination ---");
            let combinedResults: ContextObject[] = [];
            if (vectorResults.length > 0 || ftsResults.length > 0) {
                 combinedResults = applyRRF(vectorResults, ftsResults);
                console.log("Combined results after RRF (before re-ranking):", combinedResults.map(c => ({ file_id: c.file_id, chunk_index: c.chunk_index, source: c.source, rrf_score: (c as any).rrf_score?.toFixed(4) })) );
            } else {
                 console.log("No results from either vector or FTS search before RRF.");
            }
            console.log("--- Finished RRF Combination ---");


            // d. Determine Query Source (based on results *before* re-ranking)
            if (query_source !== 'error') { // Only set non-error source if no errors occurred
                // Simplified logic: If any results exist, it must be hybrid (or handled by 'none' later)
                if (combinedResults.length > 0) {
                    query_source = 'hybrid';
                    message_for_gpt = `Found ${combinedResults.length} potential matches from combined vector and text search.`;
                } else {
                    query_source = 'none';
                    message_for_gpt = "I couldn't find any relevant information matching your query.";
                }
            } else {
                 // Keep error message, but clarify if *any* results were found despite errors
                 if(combinedResults.length > 0) {
                      message_for_gpt += ` Found ${combinedResults.length} partial results despite errors.`;
                 } else {
                      message_for_gpt += " No results found.";
                 }
            }


            // e. Apply Re-ranking
            console.log("--- Starting Re-ranking ---");
            if (combinedResults.length > 0) {
                 console.log(`Calling rerankResults for ${combinedResults.length} candidates from source: ${query_source}...`);
                 // Pass the RRF results (with rrf_score) to the new rerankResults
                 retrieved_context = await rerankResults(combinedResults, queryMetadata);
                 // Update message if results were trimmed
                 if (retrieved_context.length < combinedResults.length && retrieved_context.length > 0) {
                     message_for_gpt += ` Displaying top ${retrieved_context.length} after re-ranking.`;
                 } else if (retrieved_context.length === 0 && combinedResults.length > 0) {
                      message_for_gpt = "Found initial matches, but none scored high enough after re-ranking.";
                      query_source = 'none'; // Set source to none if re-ranking filters everything
                 }
            } else {
                 console.log("Skipping re-ranking as there are no combined results.");
                 retrieved_context = []; // Ensure context is empty
            }
            console.log("--- Finished Re-ranking ---");

        } // End of 'query' block

        // --- Final Response Construction ---
        console.log(`Final retrieved_context count: ${retrieved_context.length}, final query_source: ${query_source}`);

        // Determine the final source using the helper defined at the start of the handler
        const finalQuerySource = determineFinalQuerySource(retrieved_context, query_source, vectorResults, ftsResults);

        const successResponse: SuccessResponse = {
            retrieved_context: retrieved_context,
            storage_status: storage_status,
            query_source: finalQuerySource,
            message_for_gpt: message_for_gpt || (finalQuerySource === 'none' ? "No relevant information found." : ""),
            error: null,
            rank: undefined,
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