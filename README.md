# 🎓 ScholarMind - AI Research Companion

**ScholarMind** is a next-generation research assistant that transforms static academic papers into interactive, multimedia knowledge bases. Built with **React** and the **Google Gemini API**, it leverages retrieval-augmented generation (RAG) and multimodal capabilities to help students and researchers understand complex topics faster.

![ScholarMind UI](https://via.placeholder.com/1200x600?text=ScholarMind+Dashboard)

## ✨ Key Features

### 🔍 Discovery & Library Management
*   **Scholar Search:** Scrape and analyze scholar profiles using Google Search Grounding to auto-populate their top papers.
*   **Manual Addition:** Add specific papers by title or topic to build a custom "Mixed Collection" library.
*   **Persistent Library:** Your profile, papers, and chat history are automatically saved to Local Storage, so you never lose your research session.

### 🧠 Deep Analysis Pipeline
*   **Smart Summaries:** Automatically fetches abstracts and metadata using Google Search.
*   **Citation Network:** Find and analyze papers that cite the current work to understand its impact.
*   **Multimodal Generation:**
    *   📝 **Blogs:** Converts dense academic text into engaging, markdown-formatted blog posts.
    *   🎨 **Illustrations:** Generates abstract, data-viz style cover art for every paper using `gemini-2.5-flash-image`.
    *   📊 **Slides:** Auto-generates key takeaways and slide decks.
    *   🃏 **Flashcards:** Creates active recall study materials.
    *   🧩 **Quizzes:** Generates multiple-choice questions with explanations.

### 🎧 Audio & Conversational Learning
*   **AI Podcast Intros:** Generates natural-sounding audio summaries using `gemini-2.5-flash-preview-tts`.
*   **Interactive Host:** A conversational quiz mode where an AI host (with selectable voices like Kore, Puck, Zephyr) reads questions and provides audio feedback on your answers.

### 💬 Context-Aware Chat Bot
*   **Scholar Bot:** A persistent chat assistant on the right panel.
*   **RAG (Retrieval Augmented Generation):** The bot has read access to the full generated content of your library. It answers questions specifically based on the papers you have analyzed.
*   **Search Integration:** Can browse the live web to answer questions outside the scope of the loaded papers.

### 🎨 Modern UI/UX
*   **Glassmorphism:** Beautiful, translucent UI with mesh gradient backgrounds.
*   **Dynamic Theming:** Switch instantly between 5 themes (Ocean, Violet, Emerald, Rose, Amber).
*   **Responsive:** optimized for desktop and tablet research workflows.

---

## 🛠️ Tech Stack

*   **Frontend:** React 19, TypeScript, Vite
*   **Styling:** Tailwind CSS (Custom Configuration)
*   **AI SDK:** `@google/genai`
*   **Icons:** Lucide React
*   **State:** LocalStorage persistence

---

## 🤖 Gemini Models Used

ScholarMind utilizes the latest experimental models from Google DeepMind:

| Task | Model | Description |
| :--- | :--- | :--- |
| **Search & Reasoning** | `gemini-3-flash-preview` | Used for finding scholars, scraping papers, RAG chat, and generating text resources. |
| **Image Generation** | `gemini-2.5-flash-image` | Creates unique cover art for every research paper. |
| **Text-to-Speech** | `gemini-2.5-flash-preview-tts` | Generates high-quality, low-latency audio for summaries and the quiz host. |

---

## 🚀 Getting Started

### Prerequisites

1.  **Node.js** (v18 or higher)
2.  **Google AI Studio API Key** (Get one [here](https://aistudio.google.com/))
    *   *Note: Ensure you are in a region that supports the Gemini 3 and 2.5 experimental models.*

### Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/yourusername/scholarmind.git
    cd scholarmind
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Set up Environment Variables:**
    Create a `.env` file in the root directory:
    ```env
    API_KEY=your_google_gemini_api_key_here
    ```

4.  **Run the development server:**
    ```bash
    npm start
    ```

---

## 📖 Usage Guide

1.  **Search or Add:**
    *   Toggle the input bar to **Search Scholar** to find an author (e.g., "Geoffrey Hinton").
    *   Or toggle to **Add Paper** to analyze a specific topic (e.g., "Attention is All You Need").

2.  **Select & Generate:**
    *   Select the papers you are interested in using the checkboxes.
    *   Click the **Generate** button. The app will asynchronously fetch deep details, write blogs, create slides, and generate audio/images.

3.  **Read & Listen:**
    *   Click **Read** on any processed paper to open the modal.
    *   Switch tabs to view **Slides**, take a **Quiz**, or flip **Flashcards**.
    *   Click **Listen** to hear the audio summary.

4.  **Chat:**
    *   Use the **Scholar Bot** on the right to ask specific questions like "Compare the methodologies of paper A and B".
    *   Use `analyze [Paper Title]` in the chat to quickly add a new paper to your library via conversation.

---

## 📄 License

MIT License. Open source for educational and research purposes.
