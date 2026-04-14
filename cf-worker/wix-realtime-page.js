// Wix Velo Page Code — paste into a page's code panel.
// No UI elements needed — everything goes to browser console.
// Open DevTools → Console + Network (WS filter) to see the protocol.

import wixRealtimeFrontend from "wix-realtime-frontend";
import { fetch } from "wix-fetch";

const BACKEND = "https://patrickring9.wixstudio.com/http/_functions";

$w.onReady(function () {
    run().catch(err => console.error("run() failed:", err));
});

async function run() {
    console.log("=== REALTIME PROBE START ===");

    // 1 — Fire the streaming request to get the streamId back
    const res = await fetch(`${BACKEND}/v1ChatCompletions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            messages: [{ role: "user", content: "Tell me about the weather" }],
            stream: true,
            max_tokens: 64,
            max_sentences: 2,
        }),
    });

    const meta = await res.json();
    console.log("Stream meta:", JSON.stringify(meta, null, 2));

    const streamId = meta.stream?.resourceId;
    if (!streamId) {
        console.error("No streamId returned:", meta);
        return;
    }

    // 2 — Subscribe to the Realtime channel
    const channel = { name: "completions", resourceId: streamId };
    console.log("Subscribing to channel:", JSON.stringify(channel));

    let text = "";
    const subId = await wixRealtimeFrontend.subscribe(channel, (message, ch) => {
        console.log("RT msg:", JSON.stringify(message));
        console.log("RT ch:", JSON.stringify(ch));

        const payload = message.payload;
        if (payload.done) {
            console.log("=== STREAM DONE === Final text:", text);
            return;
        }
        if (payload.choices?.[0]?.delta?.content !== undefined) {
            text += payload.choices[0].delta.content;
            console.log("Text so far:", text);
        }
    });

    console.log("Subscription ID:", subId);
    console.log("=== Now check Network tab WS frames ===");
}
