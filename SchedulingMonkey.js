// Email → Apple Calendar Bridge
// Accepts a shared image (flyer/ticket/screenshot), a shared link (fetches and
// reads the page), or pasted/shared text (an email body). Extracts event
// details with an LLM (Groq, free tier), then creates the event with
// Scriptable's native Calendar API
// (EventKit) — no CalDAV/app passwords needed.

const KEYCHAIN_API_KEY = "email_calendar_bridge_api_key";
const KEYCHAIN_CALENDAR_NAME = "email_calendar_bridge_calendar_name";
const CONFIDENCE_THRESHOLD = 0.75; // below this, ask before adding
const GROQ_MODEL = "qwen/qwen3.6-27b"; // free tier, handles text and images

// --- Setup: API key (stored once, locally, on this device) ---
async function getApiKey() {
  if (Keychain.contains(KEYCHAIN_API_KEY)) {
    return Keychain.get(KEYCHAIN_API_KEY);
  }
  const alert = new Alert();
  alert.title = "Groq API Key Needed";
  alert.message = "Paste your free Groq API key (get one at console.groq.com/keys — no credit card needed). It's stored securely on this device only — never shared or uploaded.";
  alert.addTextField("gsk_...");
  alert.addAction("Save");
  alert.addCancelAction("Cancel");
  const idx = await alert.presentAlert();
  if (idx === -1) throw new Error("No API key provided — can't continue without one.");
  const key = alert.textFieldValue(0).trim();
  if (!key) throw new Error("API key was empty.");
  Keychain.set(KEYCHAIN_API_KEY, key);
  return key;
}

// --- Setup: which calendar to add events to (remembered after first pick) ---
async function pickCalendar() {
  const calendars = await Calendar.forEvents();

  if (Keychain.contains(KEYCHAIN_CALENDAR_NAME)) {
    const savedName = Keychain.get(KEYCHAIN_CALENDAR_NAME);
    const found = calendars.find((c) => c.title === savedName);
    if (found) return found;
  }

  const alert = new Alert();
  alert.title = "Pick a Calendar";
  alert.message = "New events will go here from now on (you can reset by deleting the script's keychain entries).";
  calendars.forEach((c) => alert.addAction(c.title));
  alert.addCancelAction("Cancel");
  const idx = await alert.presentSheet();
  if (idx === -1) throw new Error("No calendar selected.");
  const chosen = calendars[idx];
  Keychain.set(KEYCHAIN_CALENDAR_NAME, chosen.title);
  return chosen;
}

const LINK_TEXT_MAX_CHARS = 3000; // cap how much of the fetched page we keep

// --- Strip HTML down to rough plain text (no DOM parser available in Scriptable) ---
function htmlToPlainText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Fetch a page and return cleaned plain text ---
async function fetchLinkText(url) {
  const req = new Request(url);
  req.timeoutInterval = 10;
  const html = await req.loadString();
  const text = htmlToPlainText(html);
  if (!text) throw new Error("Fetched the page but couldn't extract any readable text from it.");
  return text.slice(0, LINK_TEXT_MAX_CHARS);
}

// --- The JSON schema + extraction rules shared by both the text and image extraction paths ---
function buildSystemPrompt(todayISO) {
  return `You extract calendar event details from the provided content, which may be an email, the text of a webpage, or an image (a screenshot, flyer, poster, or ticket). Respond with ONLY valid JSON, no other text and no markdown fences, in exactly this shape:
{"is_event": boolean, "title": string, "start": "YYYY-MM-DDTHH:MM:SS", "end": "YYYY-MM-DDTHH:MM:SS" or null, "timezone": "IANA timezone name" or null, "location": string or null, "notes": string or null, "confidence": number between 0 and 1}

Rules:
- If the content does not describe a specific event with a real date/time (e.g. it's a newsletter, receipt with no event, or generic page/image content), set "is_event": false and leave other fields as empty strings or null.
- If the content clearly describes a real event (people agreeing to meet, a scheduled call, etc.) but never states an explicit title or subject line — common in casual chat/text threads — synthesize a short, sensible title from context instead of leaving it blank, e.g. "Meeting with Adi, Mugdha, and Neena" or "Call with Jordan". Prefer using participant names over a generic word like "Meetup" when names are visible.
- If no explicit year is given, assume the nearest future occurrence relative to today.
- If no end time is given, set "end" to null (the caller will default to a 1-hour event).
- "start" and "end" should be the plain wall-clock time as stated (no UTC offset) — timezone handling is separate.
- "timezone" should be an IANA timezone identifier (e.g. "America/New_York", "Europe/London", "Asia/Tokyo") if the content states or clearly implies one — a named zone abbreviation like "EST"/"PST", a city, an address, or context like a specific venue location. If nothing indicates a timezone, set it to null and the device's local timezone will be used.
- "notes" should capture anything useful that doesn't fit title/start/end/location — confirmation numbers, dial-in links or meeting codes, what to bring, dress code, agenda items, prices, contact info, cancellation policy, etc. Write it as short plain-text lines, not a copy-paste of the source. Omit navigation menus, footers, unsubscribe links, and marketing filler. If there's nothing worth keeping beyond the core fields, set "notes" to null.
- "confidence" should reflect how certain you are about the date/time specifically, not just whether an event exists.
- Today's date is ${todayISO}.`;
}

// --- Call Groq to extract structured event details from text (email or a fetched webpage) ---
async function extractEventFromText(sourceText, apiKey) {
  const todayISO = new Date().toISOString().split("T")[0];
  const systemPrompt = buildSystemPrompt(todayISO);

  // Groq's free tier: no cost, no credit card, rate-limited but way more than
  // enough for occasional manual runs. Trimming input keeps token count down.
  const trimmedText = sourceText.slice(0, 3000);

  const req = new Request("https://api.groq.com/openai/v1/chat/completions");
  req.method = "POST";
  req.headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + apiKey,
  };
  req.body = JSON.stringify({
    model: GROQ_MODEL,
    max_tokens: 500,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: trimmedText },
    ],
  });

  return await callGroqAndParse(req);
}

// --- Call Groq's vision model to extract event details directly from an image ---
async function extractEventFromImage(image, apiKey) {
  const todayISO = new Date().toISOString().split("T")[0];
  const systemPrompt = buildSystemPrompt(todayISO);

  // JPEG at 0.7 quality keeps the request comfortably under Groq's 4MB
  // base64 request limit for typical phone screenshots/photos.
  const base64Image = Data.fromJPEG(image, 0.7).toBase64String();

  const req = new Request("https://api.groq.com/openai/v1/chat/completions");
  req.method = "POST";
  req.headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + apiKey,
  };
  req.body = JSON.stringify({
    model: GROQ_MODEL,
    max_tokens: 500,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: "Extract calendar event details from this image, following the schema and rules above." },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
        ],
      },
    ],
  });

  return await callGroqAndParse(req);
}

// --- Shared: send the request, validate the response, parse the JSON ---
async function callGroqAndParse(req) {
  const res = await req.loadJSON();

  if (res.error) {
    throw new Error("Groq API error: " + res.error.message);
  }

  const messageContent = res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
  if (!messageContent) throw new Error("No text content in API response.");

  const cleaned = messageContent.trim().replace(/^```json\s*/i, "").replace(/```$/, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Couldn't parse model output as JSON: " + cleaned.slice(0, 200));
  }
}

// --- Convert a naive "wall clock" time in a given IANA timezone to a correct UTC Date ---
// Handles DST correctly because it asks the system for the real offset at that
// specific date, rather than assuming a fixed offset for the zone.
function zonedTimeToUtc(dateTimeStr, timeZone) {
  const naiveUtc = new Date(dateTimeStr + "Z"); // treat the wall-clock numbers as if they were UTC, as a reference point
  const asZoned = new Date(naiveUtc.toLocaleString("en-US", { timeZone }));
  const asUtc = new Date(naiveUtc.toLocaleString("en-US", { timeZone: "UTC" }));
  const offset = asZoned.getTime() - asUtc.getTime();
  return new Date(naiveUtc.getTime() - offset);
}

// --- Fire a local notification (shows up like any other app notification) ---
async function notify(title, body) {
  const n = new Notification();
  n.title = title;
  n.body = body;
  await n.schedule();
}

// --- Create the actual calendar event ---
async function createCalendarEvent(details, calendar) {
  const timeZone = details.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const event = new CalendarEvent();
  event.title = details.title;
  event.calendar = calendar;
  event.timeZone = timeZone;
  event.startDate = zonedTimeToUtc(details.start, timeZone);
  event.endDate = details.end
    ? zonedTimeToUtc(details.end, timeZone)
    : new Date(event.startDate.getTime() + 60 * 60 * 1000); // default 1hr
  if (details.location) event.location = details.location;
  if (details.notes) event.notes = details.notes;
  await event.save();
}

// --- Main ---
async function main() {
  // Priority: shared image (flyer/poster/ticket screenshot) > shared URL > pasted/shared text.
  const sharedImage = (args.images && args.images[0]) || null;
  const sharedUrl = (args.urls && args.urls[0]) || null;
  const rawInput = args.plainTexts[0] || args.shortcutParameter;
  const trimmedInput = rawInput ? rawInput.trim() : null;
  const isBareLink = trimmedInput && /^https?:\/\/\S+$/i.test(trimmedInput);
  const linkToFetch = sharedUrl || (isBareLink ? trimmedInput : null);

  const apiKey = await getApiKey();

  let details;
  if (sharedImage) {
    details = await extractEventFromImage(sharedImage, apiKey);
  } else if (linkToFetch) {
    let sourceText;
    try {
      sourceText = await fetchLinkText(linkToFetch);
    } catch (e) {
      throw new Error(`Couldn't fetch that link: ${e.message}`);
    }
    details = await extractEventFromText(sourceText, apiKey);
  } else if (rawInput) {
    details = await extractEventFromText(rawInput, apiKey);
  } else {
    throw new Error("No image, link, or text received — share an image, a URL, or paste event text into the Shortcut.");
  }

  if (!details.is_event) {
    Script.setShortcutOutput("No event detected.");
    return;
  }

  if (!details.title || !details.title.trim()) {
    // Belt-and-suspenders: even with the prompt rule above, don't ever create
    // a blank-titled event. Also force the confirmation prompt in this case,
    // since a missing title is itself a sign the extraction was shakier than usual.
    details.title = "Untitled Event";
    details.confidence = Math.min(details.confidence, CONFIDENCE_THRESHOLD - 0.01);
  }

  if (details.confidence >= CONFIDENCE_THRESHOLD) {
    const calendar = await pickCalendar();
    await createCalendarEvent(details, calendar);
    const summary = `Added "${details.title}" on ${details.start}.`;
    await notify("Event Added", summary);
    Script.setShortcutOutput(summary);
  } else {
    const alert = new Alert();
    alert.title = "Confirm This Event?";
    const notesPreview = details.notes ? `\n\nNotes:\n${details.notes}` : "";
    const tzNote = details.timezone ? ` (${details.timezone})` : "";
    alert.message = `${details.title}\n${details.start}${tzNote}${details.location ? "\n" + details.location : ""}${notesPreview}\n\nConfidence: ${Math.round(details.confidence * 100)}% — low enough that I wanted to check first.`;
    alert.addAction("Add to Calendar");
    alert.addCancelAction("Skip");
    const idx = await alert.presentAlert();
    if (idx === 0) {
      const calendar = await pickCalendar();
      await createCalendarEvent(details, calendar);
      const summary = `Added "${details.title}" on ${details.start}.`;
      await notify("Event Added", summary);
      Script.setShortcutOutput(summary);
    } else {
      Script.setShortcutOutput("Skipped — not added.");
    }
  }
}

await main();
Script.complete();