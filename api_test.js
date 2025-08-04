import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics'; // Import both directly

// Configuration - Retrieved from .env file
const DIFY_HOST = __ENV.DIFY_HOST;
const DIFY_APP_ID = __ENV.DIFY_APP_ID;
const DIFY_APP_PUBLIC_TOKEN = __ENV.DIFY_APP_PUBLIC_TOKEN;

// Ensure required environment variables are set
if (!DIFY_APP_ID || !DIFY_APP_PUBLIC_TOKEN) {
    console.error("DIFY_APP_ID and DIFY_APP_PUBLIC_TOKEN must be set in the .env file.");
    throw new Error("Missing Dify application configuration.");
}

// Define options for your test
export let options = {
    scenarios: {
        dify_chatbot_test: {
            executor: 'constant-vus', // Maintain a constant number of VUs
            vus: 30,                 // 30 concurrent users
            duration: '5m',          // Test duration: 5 minutes
        },
    },
    thresholds: {
        'http_req_duration{name:Chat with Dify App}': ['p(95)<4000', 'p(99)<7000'],
        'http_req_failed': ['rate<0.01'],
        'checks': ['rate>0.99'],
        'successful_chat_interactions': ['rate>0.95'],
    },
    noConnectionReuse: false,
    // timeout: '60s', // This can be set if a global timeout is desired
};

// Custom metrics
const successfulChatInteractions = new Counter('successful_chat_interactions');
const failedChatInteractions = new Rate('failed_chat_interactions');

// VU-specific storage for conversation ID
// This is a cleaner and more direct way to manage per-VU state
const vuConversationIds = {};

// The 'setup' function runs once before the VUs start.
// It's used for test setup (e.g., getting shared data).
// It does NOT run per VU.
// We remove the VU-specific initialization from here.
export function setup() {
    // We don't need to return anything here for per-VU conversationId management
    // as we'll manage it directly within the default function's scope for each VU.
    console.log("k6 setup function completed. Starting VUs...");
    // Return a dummy value, or actual shared data if needed later
    return { startTime: new Date().toISOString() };
}


export default function () {
    // __VU is the Virtual User ID (1-indexed)
    const userId = `anon_user_${__VU}`;

    // Get the conversationId specific to this VU, or null if it's the first run for this VU
    let conversationId = vuConversationIds[__VU];

    const queries = [
        "What are the six key economic sectors identified in the Post COVID-19 Development Strategy 2030?",
        "What are the seven enablers identified in the Post COVID-19 Development Strategy 2030?",
        "How do the economic sectors and enablers interact to drive economic prosperity in Sarawak?",
        "What are the differences between seven strategic thrusts and seven enablers?",
        "What are the key objectives and initiatives related to environmental sustainability within the Post COVID-19 Development Strategy 2030?",
        "How does PCDS 2030 address Sarawak’s economic challenges?",
        "What are the seven strategic thrusts of PCDS 2030?",
        "Summarize the key points in PCDS 2030",
        "What happened during COVID-19 pandemic in Sarawak?",
        "What are the conclusion from PCDS 2030?",
        "Briefly explain the first key economic sector in PCDS 2030."
    ];
    const currentQuery = queries[Math.floor(Math.random() * queries.length)];

    const chatHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DIFY_APP_PUBLIC_TOKEN}`,
        'Accept': 'text/event-stream',
    };

    const chatPayload = {
        inputs: {},
        query: currentQuery,
        response_mode: 'streaming',
        conversation_id: conversationId, // Pass conversation ID if it exists
        user: userId,
    };

    const chatRes = http.post(
        `${DIFY_HOST}/chat-messages`,
        JSON.stringify(chatPayload),
        {
            headers: chatHeaders,
            tags: { name: 'Chat with Dify App' },
            timeout: '30s', // Maximum 30 seconds to receive the full stream
        }
    );

    const isSuccessful = check(chatRes, {
        'Chat stream started (status 200)': (res) => res.status === 200,
        'Response body not empty': (res) => res.body && res.body.length > 0,
    });

    if (isSuccessful) {
        successfulChatInteractions.add(1);

        // Parse streamed response to extract conversation_id
        // Only try to extract if we don't already have one for this VU
        if (!conversationId && chatRes.body) {
            try {
                // Split by double newline to get individual SSE events
                const events = chatRes.body.split('\n\n').filter(e => e.trim() !== '');
                for (const event of events) {
                    if (event.startsWith('data:')) { // Use startsWith for robustness
                        const dataString = event.substring(event.indexOf('data:') + 5).trim();
                        if (dataString) {
                            try {
                                const parsedData = JSON.parse(dataString);
                                if (parsedData && parsedData.conversation_id) {
                                    vuConversationIds[__VU] = parsedData.conversation_id; // Store for this VU
                                    console.log(`VU ${__VU}: Extracted new conversation ID: ${vuConversationIds[__VU]}`);
                                    break; // Found it, no need to parse further events
                                }
                            } catch (parseError) {
                                // console.warn(`VU ${__VU}: Could not parse data chunk as JSON: ${dataString}`);
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn(`VU ${__VU}: Error parsing streaming body for conversation ID: ${e}`);
            }
        }
    } else {
        failedChatInteractions.add(1);
        console.error(`VU ${__VU}: Chat failed: ${chatRes.status} - ${chatRes.body}`);
    }

    // Simulate think time between questions
    sleep(Math.random() * 3 + 2); // Random sleep between 2 and 5 seconds
}

// The 'handleSummary' function receives the aggregated test 'data'
export function handleSummary(data) {
    // Access the total count of the custom counter from the 'data.metrics' object
    const totalSuccessfulChats = data.metrics.successful_chat_interactions.values.count;
    console.log(`Test complete. Successful chat interactions: ${totalSuccessfulChats}`);

    return {
        'summary.json': JSON.stringify(data, null, 2),
    };
}