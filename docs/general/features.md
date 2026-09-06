# Features & User Guide

```mermaid
journey
    title Getting from a name to a studied library
    section Discover
      Create a profile: 5: You
      Search a scholar or add a paper: 5: You
    section Process
      Select papers and press Index: 5: You
      Retrieve and embed the full text: 3: ScholarMind
      Press Generate when you want to read: 5: You
      Write, illustrate, narrate: 3: ScholarMind
    section Study
      Read the blog and slides: 5: You
      Take the quiz, flip flashcards: 5: You
      Ask questions with citations: 5: You
    section Keep
      Export the whole profile: 5: You
```

---

## 1. Profiles

Each profile is an independent library — its own papers, chat history, theme, and search index. Create one per scholar or topic. Everything is stored server-side, so a profile follows you across browsers and devices.

## 2. Discovery

**Search a scholar.** A name ("Geoffrey Hinton") or a Google Scholar profile URL. ScholarMind returns their affiliation, topics, and most-cited papers — and names the profile after them.

**Add a paper.** Switch to "Add Paper" and enter a title.

## 3. Processing

Select papers, then choose what you want. The two buttons are independent — run
either, both, or one and then the other later.

| Button | What it does | Roughly | Gives you |
| --- | --- | --- | --- |
| **Index** | Fetches the PDF and embeds it into this profile's search index | 5–10s per paper | Chat that answers from your papers, with citations |
| **Generate** | Writes the blog, slides, quiz, flashcards, audio and cover art | ~1min per paper | Everything under **Read** |

```mermaid
flowchart LR
    subgraph IDX["Index"]
        direction LR
        A["Finding<br/>the paper"] --> B["Downloading<br/>PDF"]
        B --> C["Building<br/>embeddings"]
        A -.->|"no open-access PDF"| C
        B -.->|"blocked or paywalled"| C
    end

    subgraph GEN["Generate"]
        direction LR
        D["Writing blog<br/>& slides"] --> E["Generating<br/>audio & art"]
    end

    C --> IX["🟢 Indexed"]
    E --> F["✅ Readable"]

    style IX fill:#ecfdf5,stroke:#059669
    style F fill:#ecfdf5,stroke:#059669
```

The dotted paths matter: when a PDF cannot be retrieved, the paper is still
indexed — from its abstract, and from the write-up if you have generated one.
Those papers carry an **Indexed (summary)** badge instead of **Indexed**, so you
always know which answers rest on full text.

Indexing first is usually the better order: **Generate** then grounds its writing
in the indexed full text rather than in a web search.

**One library per scholar.** Searching for a scholar you already have a library
for offers to open the existing one instead of building a second — which would
mean a second index and a split chat history. You can still choose to build a
separate library. It recognises the same scholar across a profile URL, a typed
name, and abbreviated forms like "G. E. Hinton".

**Papers are only fetched once.** If any profile has already indexed a paper,
the next one to index it reuses the downloaded PDF instead of hunting for it
again — roughly twice as fast, and it still works when the publisher has since
started blocking automated access. Each profile keeps its own search index, so
no profile can ever retrieve another's library.

The status bar shows how many papers of the batch are done, and what each
in-flight paper is currently doing.

## 4. Reading

**Read** opens the viewer:

- **Blog** — the generated article, with cover art
- **Slides** — the deck
- **Quiz** — multiple choice with explanations
- **Flashcards** — click to flip

**Listen** plays the narrated summary.

**Conversational quiz** — in the Quiz tab, enable conversational mode and an AI host reads questions aloud and responds to your answers. Five voices: Kore, Puck, Charon, Fenrir, Zephyr.

## 5. Chat

The Scholar Bot answers from your library and shows the sources it used — expand **"N sources from your library"** under any answer to see the document and the passage it drew from.

**One grounding mode per message:**

```mermaid
flowchart LR
    T{"Toggle"}
    T -->|"📚 Using your library"| L["semantic retrieval<br/>over indexed papers<br/><i>with citations</i>"]
    T -->|"🌐 Searching the web"| W["live web search<br/><i>for anything outside<br/>your library</i>"]

    style L fill:#f0f9ff,stroke:#0284c7
    style W fill:#fffbeb,stroke:#d97706
```

They cannot be combined — the API rejects requests attaching both — so the toggle makes the choice explicit rather than guessing.

You can also type `analyze [paper title]` to find, add, and process a paper from the conversation.

## 6. Export

The download icon on a profile card produces a ZIP:

```
profile-name/
  paper-title/
    blog.md          (with YAML front matter)
    slides.md
    quiz.md          (answers marked)
    flashcards.csv
    metadata.json
    illustration.jpg
    audio.wav        (playable, 24kHz mono)
    paper.pdf        (when retrieved)
  README.md          (index of the library)
```

## 7. Themes

Five palettes — Ocean, Violet, Emerald, Rose, Amber — applied instantly and saved per profile.
