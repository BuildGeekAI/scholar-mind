# System Architecture

## Overview
ScholarMind is a client-side Single Page Application (SPA) built with React and TypeScript. It relies heavily on the Google Gemini API for all backend logic (data retrieval, processing, generation), effectively operating as a "Serverless" AI-wrapper application.

## Tech Stack
- **Framework:** React 19
- **Language:** TypeScript
- **Styling:** Tailwind CSS
- **Icons:** Lucide React
- **AI/LLM:** Google GenAI SDK (`@google/genai`)

## Core Modules

### 1. Services Layer (`services/geminiService.ts`)
This is the heart of the application. It abstracts all interactions with the Gemini API.
- **Scholar Search:** Uses `gemini-3-flash-preview` with the `googleSearch` tool to "scrape" scholar profiles and parse them into structured JSON.
- **Content Generation:** Uses a RAG (Retrieval Augmented Generation) approach. It takes raw paper metadata, performs a Google Search for deeper context (abstracts, findings), and then generates Markdown blogs, JSON slides, and quizzes.
- **Multimodal Generation:**
    - Images: `gemini-2.5-flash-image`
    - Audio: `gemini-2.5-flash-preview-tts`

### 2. State Management
The application uses a decentralized state management approach suited for local-first apps:
- **Global State:** `App.tsx` manages the list of `Profile` objects and persists them to `localStorage`.
- **Workspace State:** `ProfileWorkspace.tsx` manages the active session state (search inputs, processing queues, UI toggles).
- **Data Persistence:** All data (papers, generated blogs, chat history) is stored in the browser's Local Storage. There is no external database.

### 3. Component Hierarchy
- `App` (Router & Global Store)
  - `Dashboard` (Profile Selection)
  - `ProfileWorkspace` (Main Logic)
    - `PaperList` (Grid view of papers)
    - `ChatInterface` (Context-aware bot)
    - `BlogReader` (Modal for consumption)
