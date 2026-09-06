# Features & User Guide

## 1. Profiles

Each profile is an independent library — its own papers, chat history, theme, and File Search index. Create one per scholar or topic. Everything is stored server-side, so a profile follows you across browsers and devices.

## 2. Discovery

**Search a scholar.** Enter a name ("Geoffrey Hinton") or a Google Scholar profile URL. ScholarMind returns their affiliation, research topics, and most-cited papers.

**Add a paper.** Switch to "Add Paper" and enter a title to add it individually.

## 3. Processing

Select papers and press **Generate**. Per paper, the server:

1. Resolves an open-access PDF — arXiv, then Crossref, then Unpaywall, then search
2. Downloads it and indexes the full text for retrieval
3. Writes a blog post, 4–6 slides, a 5-question quiz, and 5 flashcards
4. Generates a narrated audio summary and cover art

Progress streams into the UI as each paper advances. Papers whose PDF cannot be found still produce content, grounded in web search instead — a missing PDF degrades quality, it does not block.

An "open access PDF" badge marks papers where the full text was retrieved; those have the most accurate generated content.

## 4. Reading

**Read** opens the paper viewer:

- **Blog** — the generated article, with cover art
- **Slides** — the deck
- **Quiz** — multiple choice with explanations
- **Flashcards** — click to flip

**Listen** plays the narrated summary.

**Conversational quiz** — in the Quiz tab, enable conversational mode and an AI host reads questions aloud and responds to your answers. Five voices: Kore, Puck, Charon, Fenrir, Zephyr.

## 5. Chat

The Scholar Bot answers from your library, citing the documents it used.

**One grounding mode per message.** A toggle above the input switches between:

- **📚 Using your library** — semantic retrieval over your indexed papers, with citations
- **🌐 Searching the web** — live web search for anything outside your library

They cannot be combined: the API rejects requests that attach both. The toggle makes the choice explicit rather than guessing.

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
  README.md
```

## 7. Themes

Five palettes — Ocean, Violet, Emerald, Rose, Amber — applied instantly and saved per profile.
