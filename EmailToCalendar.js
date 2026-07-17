// Email → Apple Calendar Bridge
// Accepts either a shared link (fetches and reads the page) or pasted/shared text
// (an email body). Extracts event details with an LLM (Groq, free tier), then
// creates the event with Scriptable's native Calendar API (EventKit) — no
// CalDAV/app passwords needed.

const KEYCHAIN_API_KEY = "email_calendar_bridge_api_key";
const KEYCHAIN_CALENDAR_NAME = "email_calendar_bridge_calendar_name";
const CONFIDENCE_THRESHOLD = 0.75; // below this, ask before adding
const GROQ_MODEL = "llama-3.3-70b-versatile"; // free tier, no cost

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

// --- Call Claude to extract structured event details from text (email or a fetched webpage) ---
async function extractEventFromText(sourceText, apiKey) {
  const todayISO = new Date().toISOString().split("T")[0];

  const systemPrompt = `You extract calendar event details from a piece of text, which may be an email or the text of a webpage (e.g. an event registration page). Respond with ONLY valid JSON, no other text and no markdown fences, in exactly this shape:
{"is_event": boolean, "title": string, "start": "YYYY-MM-DDTHH:MM:SS", "end": "YYYY-MM-DDTHH:MM:SS" or null, "timezone": "IANA timezone name" or null, "location": string or null, "notes": string or null, "confidence": number between 0 and 1}

Rules:
- If the text does not describe a specific event with a real date/time (e.g. it's a newsletter, receipt with no event, or generic page content), set "is_event": false and leave other fields as empty strings or null.
- If no explicit year is given, assume the nearest future occurrence relative to today.
- If no end time is given, set "end" to null (the caller will default to a 1-hour event).
- "start" and "end" should be the plain wall-clock time as stated in the text (no UTC offset) — timezone handling is separate.
- "timezone" should be an IANA timezone identifier (e.g. "America/New_York", "Europe/London", "Asia/Tokyo") if the text states or clearly implies one — a named zone abbreviation like "EST"/"PST", a city, an address, or context like a specific venue location. If nothing indicates a timezone, set it to null and the device's local timezone will be used.
- "notes" should capture anything useful that doesn't fit title/start/end/location — confirmation numbers, dial-in links or meeting codes, what to bring, dress code, agenda items, prices, contact info, cancellation policy, etc. Write it as short plain-text lines, not a copy-paste of the source. Omit navigation menus, footers, unsubscribe links, and marketing filler. If there's nothing worth keeping beyond the core fields, set "notes" to null.
- "confidence" should reflect how certain you are about the date/time specifically, not just whether an event exists.
- Today's date is ${todayISO}.`;

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
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: trimmedText },
    ],
  });

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
  // Accept a URL shared directly (via Share Sheet as a URL, or "Get URLs from Input"
  // in the Shortcut), or plain/pasted text (an email body).
  const sharedUrl = (args.urls && args.urls[0]) || null;
  const rawInput = args.plainTexts[0] || args.shortcutParameter;
  const trimmedInput = rawInput ? rawInput.trim() : null;
  const isBareLink = trimmedInput && /^https?:\/\/\S+$/i.test(trimmedInput);

  const linkToFetch = sharedUrl || (isBareLink ? trimmedInput : null);

  let sourceText;
  if (linkToFetch) {
    try {
      sourceText = await fetchLinkText(linkToFetch);
    } catch (e) {
      throw new Error(`Couldn't fetch that link: ${e.message}`);
    }
  } else if (rawInput) {
    sourceText = rawInput;
  } else {
    throw new Error("No link or text received — share a URL or paste event text into the Shortcut.");
  }

  const apiKey = await getApiKey();
  const details = await extractEventFromText(sourceText, apiKey);

  if (!details.is_event) {
    Script.setShortcutOutput("No event detected in this email.");
    return;
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