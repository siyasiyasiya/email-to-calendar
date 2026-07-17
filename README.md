<div align="center">

# SCHEDULING MONKEY

### **share text, a link, or an image. get a calendar event.**

<br />

**a scriptable script that turns any text, link, or image into a calendar event. powered by groq's free llm api. works with any calendar on your device.**

</div>

---

## why

i'm fiercely loyal to the apple ecosystem and love using apple calendar. unfortunately, i also get lazy to go out of my way and create an event for everything in my life. even more unfortunately, apple intelligence should be helping with this, but it doesn't. so i decided i had enough and just built my own tool that i use now.

## what it does

share anything with event info in it:

- **text** - a message, a group chat, a forwarded email, anything with a date and time in it
- **links** - share a URL to an event page; it fetches and reads the content
- **images** - share a screenshot, flyer, poster, or ticket photo; the vision model reads it

it pulls out the title, date/time, timezone, location, and any useful notes (confirmation numbers, dial-in links, dress codes, etc.), then creates the event directly in whichever calendar you pick using iOS's native EventKit - no third-party integrations needed.

high-confidence extractions are added automatically. lower-confidence ones show a confirmation prompt so you can verify before anything's committed.

---

## how it works

```
share text / link / image
        ↓
groq api (llama-3.3-70b for text, llama-4-scout for images)
        ↓
structured json: title, start, end, timezone, location, notes, confidence
        ↓
confidence ≥ 0.75 → auto-add     confidence < 0.75 → confirm first
        ↓
eventkit creates the event in your chosen calendar
        ↓
local notification confirms it's done
```

---

## setup

1. install [Scriptable](https://scriptable.app/) (free, ios/ipados)
2. on your phone, tap `scheduling _monkey.scriptable` in this repo — it'll open directly in Scriptable and import the script automatically. alternatively, create a new script manually and paste in `SchedulingMonkey.js`, named exactly `SchedulingMonkey`
3. grab a free groq api key at [console.groq.com/keys](https://console.groq.com/keys) - no credit card needed
4. run it once. on first run it'll ask you to:
   - paste your groq api key (stored in ios keychain, on-device only)
   - pick which calendar new events go to

---

## using it

**from the share sheet:**
- text → select it, tap share → run script → pick this script
- link → tap share in your browser → run script → pick this script
- image → tap share on the image → run script → pick this script

**via Shortcuts:**
build a shortcut with "Get Input from Share Sheet" (accepting text, urls, or images) → "run script" pointing at `SchedulingMonkey`

---

## configuration

| constant | default | what it does |
|----------|---------|--------------|
| `CONFIDENCE_THRESHOLD` | `0.75` | below this, shows a confirm prompt before adding |
| `GROQ_TEXT_MODEL` | `llama-3.3-70b-versatile` | model used for text and web pages |
| `GROQ_VISION_MODEL` | `meta-llama/llama-4-scout-17b-16e-instruct` | model used for images |
| `LINK_TEXT_MAX_CHARS` | `3000` | how much of a fetched page to send to the model |

---

## notes

- this is completely free since i'm using groq's free tiered models but go ahead and tweak if you would like but i rlly dont think it's necessary
- don't worry about leaking your api key. it's saved in ios keychain, on device only
  
