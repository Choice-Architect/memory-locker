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
import * as chrono from 'chrono-node';

// --- Interfaces for API Contract ---

// REVISED Interface for Enhanced Date Handling with Components (v1.5)
interface EnhancedNormalizedDate {
    original: string;        // The original string like "last Tuesday afternoon"
    note?: string;           // Explanation if partial or failed (e.g., "Partial parse: Day and period identified relative to reference date", "Failed to parse date string")
    // --- Component Fields (all optional) ---
    year?: number;           // e.g., 2024
    month?: number;          // e.g., 4 (1-12)
    day?: number;            // e.g., 2 (1-31)
    day_of_week?: number;    // e.g., 2 (0=Sun, 1=Mon, 2=Tue...)
    week_number?: number;    // e.g., 14 (ISO 8601 week number, 1-53)
    time_hour?: number;      // e.g., 15 (0-23)
    time_minute?: number;    // e.g., 0
    time_second?: number;    // e.g., 0
    period?: 'Morning' | 'Afternoon' | 'Evening' | 'Night'; // Simplified Periods derived from boundary terms or time
}

interface ExtractedEntities {
    people?: string[];
    // Input uses flexible date types, processed internally into EnhancedNormalizedDate
    dates?: (string | { original: string; normalized?: string | null; note?: string })[]; // Allow basic normalized or string
    locations?: string[];
    topics?: string[];
    type?: string;
    sentiment?: string;
    priority?: number;
    conversation_id?: string;
    thread_id?: string;
    [key: string]: any; // Allow flexible entity types
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
    similarity?: number; // Added: Optional similarity score from vector search
    rank?: number; // Added: Optional rank score from FTS
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
    rank?: number; // Added: Optional rank score from FTS
}

// Interface for internal re-ranking
interface ScoredContextObject extends ContextObject {
    initial_score: number; // Combined vector similarity or FTS rank
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

/**
 * Checks if there's any overlap between two arrays.
 * Case-insensitive comparison for strings.
 */
function checkOverlap(arr1?: any[], arr2?: any[]): boolean {
    if (!arr1 || !arr2) return false;
    const set1 = new Set(arr1.map(item => typeof item === 'string' ? item.toLowerCase() : item));
    return arr2.some(item => set1.has(typeof item === 'string' ? item.toLowerCase() : item));
}

/**
 * REFACTORED (v1.5): Parses a natural language date/time string into components
 * using chrono-node for identification and date-fns for reliable calculation.
 * Prioritizes extracting components.
 * @param dateString The raw date string from user input or entities.
 * @param referenceDate The reference date (usually now) for resolving relative dates.
 * @returns An EnhancedNormalizedDate object with extracted components.
 */
function parseDateStringToEnhanced(dateString: string, referenceDate: Date): EnhancedNormalizedDate {
    console.log(`Parsing date string: "${dateString}" with reference date: ${referenceDate.toISOString()}`);
    const result: EnhancedNormalizedDate = { original: dateString };

    // 1. Define and Strip Qualifiers
    const qualifiers = [
        // Order matters slightly - longer phrases first
        "first week of", "last two weeks of", "end of day", "end of the day", "by end of day",
        "this morning", "this afternoon", "this evening", "tonight",
        "early", "late", "around", "before", "after", "by", "on", "at", "in", "for", "EOD", "COB"
    ];
    let cleanedDateString = dateString.toLowerCase();
    const foundQualifiers: string[] = [];
    qualifiers.forEach(q => {
        const regex = new RegExp(`\\b${q}\\b`, 'gi');
        if (regex.test(cleanedDateString)) {
            foundQualifiers.push(q.toUpperCase());
            cleanedDateString = cleanedDateString.replace(regex, '').trim();
        }
    });
    cleanedDateString = cleanedDateString.replace(/\s+/g, ' ').trim();
    console.log(`Cleaned string: "${cleanedDateString}", Found qualifiers: ${foundQualifiers.join(', ')}`);

    // 2. Date Phrase Identification (Leverage Chrono)
    const chronoResults = chrono.parse(cleanedDateString, referenceDate, { forwardDate: true });

    if (chronoResults.length === 0) {
        console.warn(`Chrono failed to parse cleaned string: "${cleanedDateString}". Checking original for boundary terms.`);
        // Check original string for boundary terms if chrono fails
        if (/\b(end of day|end of the day|by end of day|tonight|EOD)\b/i.test(dateString)) {
            result.year = getYear(referenceDate);
            result.month = getMonth(referenceDate) + 1;
            result.day = getDate(referenceDate);
            result.period = 'Evening';
            result.note = "Inferred current date from boundary term.";
            console.log("Set current date based on boundary term in original string.");
        } else if (/\b(this morning)\b/i.test(dateString)) {
            result.year = getYear(referenceDate);
            result.month = getMonth(referenceDate) + 1;
            result.day = getDate(referenceDate);
            result.period = 'Morning';
            result.note = "Inferred current date from boundary term.";
            console.log("Set current date based on boundary term in original string.");
        } else if (/\b(this afternoon|COB)\b/i.test(dateString)) {
            result.year = getYear(referenceDate);
            result.month = getMonth(referenceDate) + 1;
            result.day = getDate(referenceDate);
            result.period = 'Afternoon';
            result.note = "Inferred current date from boundary term.";
            console.log("Set current date based on boundary term in original string.");
        } else {
            result.note = "Failed to parse date string.";
        }
        return result;
    }

    const parsedResult = chronoResults[0];
    const identifiedText = parsedResult.text.toLowerCase();
    console.log(`Chrono identified text: "${identifiedText}"`);

    // 3. Pattern Matching & Component Calculation (using date-fns)
    let parsedDate: Date | null = null;
    let isRelativeWeekMonthYear = false; // Flag for patterns that don't yield a specific day

    // --- Pattern Matching (Order matters: More specific first) ---
    const datePatterns = [
        { regex: /^\d{4}-\d{1,2}-\d{1,2}$/, format: 'yyyy-MM-dd' },
        { regex: /^\d{1,2}\/\d{1,2}\/\d{4}$/, format: 'MM/dd/yyyy' },
        { regex: /^\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{4}$/i, format: 'dd MMM yyyy' },
        { regex: /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}(st|nd|rd|th)?,\s+\d{4}$/i, format: 'MMM do, yyyy'},
        { regex: /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday),\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}(st|nd|rd|th)?,\s+\d{4}$/i, format: 'EEEE, MMM do, yyyy'},
    ];

    let patternMatched = false;
    for (const p of datePatterns) {
        if (p.regex.test(identifiedText)) {
            try {
                parsedDate = dateFnsParse(identifiedText, p.format, referenceDate);
                 if (isValid(parsedDate)) {
                    console.log(`Pattern matched specific date format: ${p.format}`);
                    patternMatched = true;
                    break;
                 } else {
                     parsedDate = null;
                     console.warn(`date-fns failed to parse "${identifiedText}" with format ${p.format}`);
                 }
            } catch (e) {
                console.error(`Error parsing "${identifiedText}" with date-fns format ${p.format}:`, e);
                parsedDate = null;
            }
        }
    }

    if (!patternMatched) {
        // Handle relative terms
        if (identifiedText === 'today') {
            parsedDate = referenceDate;
            console.log("Pattern matched: today");
        } else if (identifiedText === 'yesterday') {
            parsedDate = subDays(referenceDate, 1);
            console.log("Pattern matched: yesterday");
        } else if (identifiedText === 'tomorrow') {
            parsedDate = addDays(referenceDate, 1);
            console.log("Pattern matched: tomorrow");
        }
        // Relative Weekdays (next/last/previous)
        else if (identifiedText.startsWith('next ')) {
            const dayPart = identifiedText.substring(5);
            if (dayPart === 'monday') parsedDate = nextMonday(referenceDate);
            else if (dayPart === 'tuesday') parsedDate = nextTuesday(referenceDate);
            else if (dayPart === 'wednesday') parsedDate = nextWednesday(referenceDate);
            else if (dayPart === 'thursday') parsedDate = nextThursday(referenceDate);
            else if (dayPart === 'friday') parsedDate = nextFriday(referenceDate);
            else if (dayPart === 'saturday') parsedDate = nextSaturday(referenceDate);
            else if (dayPart === 'sunday') parsedDate = nextSunday(referenceDate);
             if(parsedDate) console.log(`Pattern matched: next ${dayPart}`);
        } else if (identifiedText.startsWith('last ')) { // Accept "last" as synonym for "previous"
            const dayPart = identifiedText.substring(5);
            if (dayPart === 'monday') parsedDate = previousMonday(referenceDate);
            else if (dayPart === 'tuesday') parsedDate = previousTuesday(referenceDate);
            else if (dayPart === 'wednesday') parsedDate = previousWednesday(referenceDate);
            else if (dayPart === 'thursday') parsedDate = previousThursday(referenceDate);
            else if (dayPart === 'friday') parsedDate = previousFriday(referenceDate);
            else if (dayPart === 'saturday') parsedDate = previousSaturday(referenceDate);
            else if (dayPart === 'sunday') parsedDate = previousSunday(referenceDate);
            if(parsedDate) console.log(`Pattern matched: last/previous ${dayPart}`);
        }
         // Standalone weekdays (assume next instance)
        else if (/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(identifiedText)) {
            const dayPart = identifiedText;
            if (dayPart === 'monday') parsedDate = nextMonday(referenceDate);
            else if (dayPart === 'tuesday') parsedDate = nextTuesday(referenceDate);
            else if (dayPart === 'wednesday') parsedDate = nextWednesday(referenceDate);
            else if (dayPart === 'thursday') parsedDate = nextThursday(referenceDate);
            else if (dayPart === 'friday') parsedDate = nextFriday(referenceDate);
            else if (dayPart === 'saturday') parsedDate = nextSaturday(referenceDate);
            else if (dayPart === 'sunday') parsedDate = nextSunday(referenceDate);
             if(parsedDate) console.log(`Pattern matched standalone weekday (assuming next): ${dayPart}`);
        }
         // Month/Day Only (Handle cautiously)
        else if (parsedResult.start?.isCertain('month') && parsedResult.start?.isCertain('day') && !parsedResult.start?.isCertain('year')) {
            const impliedChronoYear = parsedResult.start?.get('year');
            const currentYear = getYear(referenceDate);
            try {
                // Use implied year if available, otherwise current year.
                // This handles cases where chrono might guess future year for past M/D.
                parsedDate = set(new Date(0), {
                    year: impliedChronoYear ?? currentYear,
                    month: parsedResult.start.get('month')! - 1, // Chrono month is 1-based
                    date: parsedResult.start.get('day')!
                });
                // Simple sanity check: if date is > 180 days in future compared to ref, maybe chrono guessed wrong year?
                // This logic is complex, keep basic approach for now.
                 if(isValid(parsedDate)) {
                    console.log(`Pattern matched: Month/Day only (using year ${getYear(parsedDate)})`);
                 } else {
                     parsedDate = null;
                 }
             } catch (e) { parsedDate = null; console.warn("Error setting Month/Day only", e); }
        }
        // Relative Weeks/Months/Years (Set components directly)
        else if (identifiedText === 'next week') {
            const nextWeekStart = startOfWeek(addWeeks(referenceDate, 1), { weekStartsOn: 1 });
            result.year = getYear(nextWeekStart);
            result.month = getMonth(nextWeekStart) + 1;
            result.week_number = getWeek(nextWeekStart, { weekStartsOn: 1 });
            result.day = undefined;
            isRelativeWeekMonthYear = true;
            console.log("Pattern matched: next week");
        } else if (identifiedText === 'last week') {
            const lastWeekStart = startOfWeek(subWeeks(referenceDate, 1), { weekStartsOn: 1 });
            result.year = getYear(lastWeekStart);
            result.month = getMonth(lastWeekStart) + 1;
            result.week_number = getWeek(lastWeekStart, { weekStartsOn: 1 });
            result.day = undefined;
            isRelativeWeekMonthYear = true;
             console.log("Pattern matched: last week");
        }
         // ... other relative week/month/year patterns ...
          else if (identifiedText === 'this year') {
            result.year = getYear(referenceDate);
            result.month = undefined;
            result.day = undefined;
            isRelativeWeekMonthYear = true;
            console.log("Pattern matched: this year");
        }
         // Standalone Year
        else if (/^\d{4}$/.test(identifiedText)) {
             result.year = parseInt(identifiedText, 10);
             result.month = undefined;
             result.day = undefined;
             isRelativeWeekMonthYear = true;
             console.log(`Pattern matched: standalone year ${identifiedText}`);
        }
          // Month Year (e.g., "August 2025")
        else if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4}$/i.test(identifiedText)) {
             const parts = identifiedText.split(' ');
             const monthIndex = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].findIndex(m => parts[0].startsWith(m));
             result.year = parseInt(parts[1], 10);
             result.month = monthIndex + 1;
             result.day = undefined;
             isRelativeWeekMonthYear = true;
             console.log(`Pattern matched: month year ${identifiedText}`);
        }
    }

    // 4. Populate Components from parsedDate
    if (parsedDate && isValid(parsedDate) && !isRelativeWeekMonthYear) {
        console.log(`Populating components from specific parsed date: ${parsedDate.toISOString()}`);
        result.year = getYear(parsedDate);
        result.month = getMonth(parsedDate) + 1;
        result.day = getDate(parsedDate);
        result.day_of_week = getDay(parsedDate);
        try {
            result.week_number = getWeek(parsedDate, { weekStartsOn: 1 });
        } catch (e) { console.warn("Could not determine week number:", e)}
    } else if (!isRelativeWeekMonthYear && !parsedDate) {
        console.warn(`No specific date could be parsed or matched for "${identifiedText}".`);
        result.note = result.note || "Failed to parse date string into specific components.";
    } else if (isRelativeWeekMonthYear) {
         console.log("Populated components for relative week/month/year.");
         result.note = "Partial parse: Specific day not specified.";
    }

    // 5. Handle Time Components (if Chrono found them)
    if (parsedResult.start?.isCertain('hour')) {
        result.time_hour = parsedResult.start.get('hour') ?? undefined;
        result.time_minute = parsedResult.start.get('minute') ?? 0;
        result.time_second = parsedResult.start.get('second') ?? 0;
        if (result.time_hour !== undefined) {
            console.log(`Time components found: H=${result.time_hour}, M=${result.time_minute}, S=${result.time_second}`);
        }
    } else {
        // Basic time keyword checks
        if (/\b(noon)\b/i.test(identifiedText)) { result.time_hour = 12; result.time_minute = 0; }
        else if (/\b(midnight)\b/i.test(identifiedText)) { result.time_hour = 0; result.time_minute = 0; }
        const timeMatch = identifiedText.match(/(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)/i);
        if (timeMatch) {
            let hour = parseInt(timeMatch[1], 10);
            const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
            const second = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
            const period = timeMatch[4].toLowerCase();
            if (period === 'pm' && hour < 12) hour += 12;
            if (period === 'am' && hour === 12) hour = 0;
            result.time_hour = hour;
            result.time_minute = minute;
            result.time_second = second;
            console.log(`Time components parsed via regex: H=${result.time_hour}, M=${result.time_minute}, S=${result.time_second}`);
        }
    }

    // 6. Determine Period (Based on Boundary Terms or Time)
    let periodSetByBoundary = false;
    // Check foundQualifiers derived from the original string
    if (foundQualifiers.includes("EOD") || foundQualifiers.includes("END OF DAY") || foundQualifiers.includes("BY END OF DAY") || foundQualifiers.includes("TONIGHT")) {
        result.period = 'Evening';
        periodSetByBoundary = true;
    } else if (foundQualifiers.includes("COB") || foundQualifiers.includes("THIS AFTERNOON")) {
        result.period = 'Afternoon';
        periodSetByBoundary = true;
    } else if (foundQualifiers.includes("THIS MORNING")) {
        result.period = 'Morning';
        periodSetByBoundary = true;
    }
    // Infer from time_hour if not set by a specific boundary term
    if (!periodSetByBoundary && result.time_hour !== undefined) {
        if (result.time_hour >= 5 && result.time_hour < 12) result.period = 'Morning';
        else if (result.time_hour >= 12 && result.time_hour < 18) result.period = 'Afternoon';
        else if (result.time_hour >= 18 && result.time_hour < 22) result.period = 'Evening';
        else result.period = 'Night';
    }
    if(result.period) console.log(`Period determined: ${result.period}`);

    // Final Logging & Return
    console.log("Final parsed components:", JSON.stringify(result));
    return result;
}

/**
 * Maps a database result (from vector search or FTS) to a ContextObject.
 * @param dbResult The result item from Supabase (SearchResultItem or FallbackResultItem).
 * @param sourceType The source of the result ('vector_store' or 'postgres_fallback_text').
 * @returns A ContextObject.
 */
function mapDbResultToContextObject(
    dbResult: SearchResultItem | FallbackResultItem,
    sourceType: 'vector_store' | 'postgres_fallback_text'
): ContextObject {
    let contextObject: Partial<ContextObject> = {}; // Use Partial for easier construction

    if (sourceType === 'vector_store') {
        const result = dbResult as SearchResultItem;
        contextObject.file_id = result.file_id;
        contextObject.chunk = result.content_chunk;
        contextObject.timestamp = result.metadata?.created_at ?? new Date(0).toISOString();
        contextObject.chunk_index = result.chunk_index;
        contextObject.similarity = result.similarity;
        contextObject.entities_in_chunk = typeof result.metadata === 'object' && result.metadata !== null
            ? {
                people: result.metadata.people,
                dates: (result.metadata.dates as EnhancedNormalizedDate[]) || [],
                locations: result.metadata.locations,
                topics: result.metadata.topics,
                type: result.metadata.type,
                sentiment: result.metadata.sentiment,
                priority: result.metadata.priority,
              }
            : {};
    } else { // postgres_fallback_text
        const file = dbResult as FallbackResultItem;
        contextObject.file_id = file.id;
        contextObject.chunk = file.transcript_text.substring(0, 3000) + (file.transcript_text.length > 3000 ? '...' : '');
        contextObject.rank = file.rank;
        contextObject.timestamp = file.created_at ? new Date(file.created_at).toISOString() : new Date(0).toISOString();
        contextObject.chunk_index = undefined; // FTS results are file-level
        contextObject.entities_in_chunk = typeof file.file_metadata === 'object' && file.file_metadata !== null
            ? {
                people: file.file_metadata.people,
                dates: (file.file_metadata.dates as EnhancedNormalizedDate[]) || [],
                locations: file.file_metadata.locations,
                topics: file.file_metadata.topics,
                type: file.file_metadata.type,
                sentiment: file.file_metadata.sentiment,
                priority: file.file_metadata.priority,
              }
            : {};
    }

    // Ensure all required fields are present (even if empty/default)
    contextObject.chunk = contextObject.chunk ?? '';
    contextObject.timestamp = contextObject.timestamp ?? new Date(0).toISOString();
    contextObject.entities_in_chunk = contextObject.entities_in_chunk ?? {};

    return contextObject as ContextObject; // Cast back to full type
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
            // Use similarity score from vector search (already mapped in ContextObject)
            initial_score = candidate.similarity || 0;
            // Ensure similarity is within 0-1 range (clamp if necessary, though unlikely)
            initial_score = Math.max(0, Math.min(1, initial_score));
        } else { // postgres_fallback_text
            // Use rank score from FTS (already mapped in ContextObject)
            initial_score = candidate.rank || 0;
             // Assume rank is already normalized (0-1). If not, normalization needed here.
             initial_score = Math.max(0, Math.min(1, initial_score)); // Clamp just in case
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

        // --- START: Revised Hierarchical Date Matching Boost ---
        if (queryMetadata.dates && queryMetadata.dates.length > 0 && candidateEntities?.dates && candidateEntities.dates.length > 0) {
            let dateBoostApplied = 0.0;
            for (const queryDate of queryMetadata.dates) {
                let bestMatchBoost = 0.0;
                for (const candidateDate of candidateEntities.dates) {
                    let currentMatchBoost = 0.0;
                    // Check Day-Level Match (highest priority)
                    if (queryDate.year && queryDate.month && queryDate.day &&
                        candidateDate.year === queryDate.year &&
                        candidateDate.month === queryDate.month &&
                        candidateDate.day === queryDate.day) {
                        currentMatchBoost = 0.05; // Higher boost for exact day
                    }
                    // Check Month-Level Match (medium priority)
                    else if (queryDate.year && queryDate.month &&
                             candidateDate.year === queryDate.year &&
                             candidateDate.month === queryDate.month) {
                        currentMatchBoost = Math.max(currentMatchBoost, 0.03); // Medium boost if month matches (don't overwrite higher day boost)
                    }
                    // Check Year-Level Match (lowest priority)
                    else if (queryDate.year && candidateDate.year === queryDate.year) {
                        currentMatchBoost = Math.max(currentMatchBoost, 0.01); // Low boost if only year matches
                    }

                    // Keep the highest boost found for this queryDate across all candidateDates
                    bestMatchBoost = Math.max(bestMatchBoost, currentMatchBoost);
                    // If we found the best possible match (day level), no need to check other candidateDates for this queryDate
                    if (bestMatchBoost === 0.05) break;
                }
                // Add the best boost found for this queryDate to the total
                dateBoostApplied += bestMatchBoost;
            }
            metadata_boost_score += dateBoostApplied;
             console.log(`Applied hierarchical date boost: +${dateBoostApplied.toFixed(3)} for candidate file ${candidate.file_id} chunk ${candidate.chunk_index}`);
        }
        // --- END: Revised Hierarchical Date Matching Boost ---

        // Language is explicitly excluded

        // NEW: Apply Date Range Boost (FTS Only)
        if (query_source === 'postgres_fallback_text' && queryMetadata.dates && queryMetadata.dates.length > 0) {
            let rangeBoostApplied = false;
            for (const queryDate of queryMetadata.dates) {
                // Derive potential range STARTING from queryDate (year, month, day if available)
                if (queryDate.year && queryDate.month && queryDate.day) {
                    try {
                        const rangeDate = new Date(queryDate.year, queryDate.month - 1, queryDate.day);
                        if (isValid(rangeDate) && isPast(rangeDate)) { // Only boost for past ranges
                             const rangeStart = startOfDay(rangeDate);
                             const rangeEnd = endOfDay(rangeDate);
                             const candidateTimestamp = parseISO(candidate.timestamp);

                            if (isValid(candidateTimestamp) && candidateTimestamp >= rangeStart && candidateTimestamp <= rangeEnd) {
                                console.log(`Applying +0.10 date boost to FTS result (timestamp: ${candidate.timestamp} within ${formatISO(rangeStart)}-${formatISO(rangeEnd)})`);
                                metadata_boost_score += 0.10;
                                rangeBoostApplied = true;
                                break; // Apply boost only once per candidate
                            }
                        }
                    } catch (e) { console.warn(`Error creating date range for FTS boost from queryDate ${JSON.stringify(queryDate)}:`, e); }
                }
                // Can add logic here for year/month ranges if needed
            }
        }

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
            const queryEmbeddingResponse = await openai.embeddings.create({
                model: EMBEDDING_MODEL,
                input: queryText,
                dimensions: EMBEDDING_DIMENSIONS,
            });
            const queryEmbedding = queryEmbeddingResponse?.data[0]?.embedding;

            if (!queryEmbedding) {
                throw new Error("Failed to generate query embedding.");
            }

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
                // USE HELPER FUNCTION FOR MAPPING
                retrieved_context = typedSearchResults.map(result =>
                    mapDbResultToContextObject(result, 'vector_store')
                );
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

                            // USE HELPER FUNCTION FOR MAPPING
                            retrieved_context = typedTextResults.map(file =>
                                mapDbResultToContextObject(file, 'postgres_fallback_text')
                            );
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