import { GoogleGenAI, Modality, GenerateContentResponse } from "@google/genai";
import { Paper, Message, Slide, QuizQuestion, FlashCard } from '../types';

const apiKey = process.env.API_KEY || '';
const ai = new GoogleGenAI({ apiKey });

// Helper to sanitize JSON string
const cleanJsonString = (str: string) => {
  return str.replace(/```json/g, '').replace(/```/g, '').trim();
};

// Retry helper for 429 errors
async function retryWithBackoff<T>(fn: () => Promise<T>, retries = 3, delay = 2000): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    const isRateLimit = error.status === 429 || 
                        error.code === 429 || 
                        error.message?.includes('429') || 
                        error.message?.includes('quota') ||
                        error.message?.includes('RESOURCE_EXHAUSTED');
                        
    if (retries > 0 && isRateLimit) {
      console.warn(`Rate limit hit. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return retryWithBackoff(fn, retries - 1, delay * 2);
    }
    throw error;
  }
}

export const searchScholarAndPapers = async (scholarName: string): Promise<{ affiliation: string, topics: string[], papers: Paper[] }> => {
  try {
    const isUrl = scholarName.toLowerCase().includes('http') || scholarName.toLowerCase().includes('www.') || scholarName.toLowerCase().includes('scholar.google');

    let prompt = '';

    if (isUrl) {
       prompt = `
      I have provided a specific Scholar Profile URL: "${scholarName}".
      
      Please use the Google Search tool to access this URL and analyze the scholar's profile page directly.
      
      1. Extract the Scholar's Name, Affiliation, and Research Topics from the profile.
      2. Extract the list of their top cited or most significant publications (aim for 5-10 key papers).
      
      For each paper, extract:
      - Title
      - Year
      - Authors
      - Citation Count
      - A brief summary (Use the search tool to find the abstract if not immediately available on the profile).

      Return a valid JSON object with the following schema:
      {
        "affiliation": "string",
        "topics": ["string"],
        "papers": [
          {
            "title": "string",
            "year": "string",
            "authors": ["string"],
            "citationCount": "string",
            "summary": "string"
          }
        ]
      }
    `;
    } else {
       prompt = `
      Analyze the following scholar input: "${scholarName}".
      
      Search for this scholar to find their details and top papers.
      
      Return a valid JSON object.
      
      For each paper, provide:
      - title
      - year
      - list of authors (strings)
      - citationCount (approximate string)
      - summary (2 sentences max)

      Schema:
      {
        "affiliation": "string",
        "topics": ["string"],
        "papers": [
          {
            "title": "string",
            "year": "string",
            "authors": ["string"],
            "citationCount": "string",
            "summary": "string"
          }
        ]
      }
    `;
    }

    const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        tools: [{ googleSearch: {} }]
      }
    }));

    const text = response.text || "{}";
    const data = JSON.parse(cleanJsonString(text));

    const papers: Paper[] = (data.papers || []).map((p: any, index: number) => ({
      id: `paper-${index}-${Date.now()}`,
      title: p.title,
      year: p.year,
      authors: p.authors || [],
      summary: p.summary,
      citationCount: p.citationCount,
      status: 'discovered'
    }));

    return {
      affiliation: data.affiliation || "Unknown Affiliation",
      topics: data.topics || [],
      papers
    };
  } catch (error) {
    console.error("Error searching scholar:", error);
    throw error; // Re-throw to be handled by UI
  }
};

export const findCitingPapers = async (paperTitle: string, authors: string[]): Promise<Paper[]> => {
  try {
    const prompt = `
      Find research papers that cite the following paper:
      Title: "${paperTitle}"
      Authors: ${authors.join(", ")}

      Use Google Search to find papers that reference this work.
      Return a list of 5-8 significant citing papers.
      
      For each citing paper, provide:
      - title
      - year
      - authors (list of strings)
      - summary (one sentence explaining how it relates to the cited work)
      
      Return JSON format:
      {
        "citingPapers": [
          { "title": "...", "year": "...", "authors": ["..."], "summary": "..." }
        ]
      }
    `;

    const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        tools: [{ googleSearch: {} }]
      }
    }));

    const text = response.text || "{}";
    const data = JSON.parse(cleanJsonString(text));

    return (data.citingPapers || []).map((p: any, index: number) => ({
      id: `citation-${index}-${Date.now()}`,
      title: p.title,
      year: p.year,
      authors: p.authors || [],
      summary: p.summary,
      status: 'discovered' // Default status for citations
    }));

  } catch (error) {
    console.error("Error finding citations:", error);
    return [];
  }
};

export const findSinglePaper = async (query: string): Promise<Paper | null> => {
  try {
    const prompt = `
      Find a specific research paper matching this query: "${query}".
      Use Google Search to find accurate details.
      
      Return a valid JSON object with the details of the single most relevant paper found.
      
      Schema:
      {
        "title": "string",
        "year": "string",
        "authors": ["string"],
        "citationCount": "string",
        "summary": "string"
      }
    `;

    const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        tools: [{ googleSearch: {} }]
      }
    }));

    const text = response.text || "{}";
    const data = JSON.parse(cleanJsonString(text));
    
    if (!data.title) return null;

    return {
      id: `paper-manual-${Date.now()}`,
      title: data.title,
      year: data.year || "Unknown",
      authors: data.authors || [],
      summary: data.summary || "",
      citationCount: data.citationCount,
      status: 'discovered'
    };

  } catch (error) {
    console.error("Error finding single paper:", error);
    return null;
  }
};

export const generatePaperResources = async (paper: Paper): Promise<{ 
  blogTitle: string, 
  blogContent: string, 
  slides: Slide[], 
  quiz: QuizQuestion[],
  flashCards: FlashCard[], 
  audioScript: string 
}> => {
  try {
    const prompt = `
      You are an expert research communicator and educator.
      
      Task: Create a comprehensive educational module for the following research paper.
      
      Paper Details:
      Title: ${paper.title}
      Authors: ${paper.authors.join(", ")}
      Initial Summary: ${paper.summary}
      
      IMPORTANT: Use the Google Search tool to find more details about this paper (abstract, key findings, methodology) to ensure the content is accurate and substantial. This is a Retrieval Augmented Generation (RAG) task.

      Requirements:
      1. Blog Post: Engaging, accessible, markdown formatted (< 500 words). Focus on "What they did", "How they did it", and "Why it matters".
      2. Slides: 4-6 key slides. Each slide has a title and 3-4 bullet points.
      3. Audio Script: A very short, natural sounding summary script (approx 50 words) suitable for a podcast intro.
      4. Quiz: Exactly 5 multiple-choice questions to test deep understanding. 
         - Each must have 4 options.
         - Provide the index of the correct answer (0-3).
         - Provide a brief explanation.
      5. Flashcards: Exactly 5 flashcards defining key terms, concepts, or findings.

      Return JSON:
      {
        "blogTitle": "string",
        "blogContent": "markdown string",
        "slides": [
          { "title": "string", "points": ["string"] }
        ],
        "audioScript": "string",
        "quiz": [
          { "question": "string", "options": ["string"], "correctAnswer": 0, "explanation": "string" }
        ],
        "flashCards": [
          { "front": "string", "back": "string" }
        ]
      }
    `;

    const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        tools: [{ googleSearch: {} }] // Enabled Search for RAG behavior
      }
    }));

    const text = response.text || "{}";
    const data = JSON.parse(cleanJsonString(text));

    return {
      blogTitle: data.blogTitle || `Blog: ${paper.title}`,
      blogContent: data.blogContent || "Content generation failed.",
      slides: data.slides || [],
      quiz: data.quiz || [],
      flashCards: data.flashCards || [],
      audioScript: data.audioScript || paper.summary
    };

  } catch (error) {
    console.error("Error generating resources:", error);
    // If retry fails, we return error state rather than crashing the flow
    return { 
      blogTitle: "Generation Failed", 
      blogContent: "We could not generate content for this paper due to high traffic. Please try again later.", 
      slides: [], 
      quiz: [],
      flashCards: [],
      audioScript: "" 
    };
  }
};

export const generateAudio = async (text: string, voiceName: string = 'Kore'): Promise<string | undefined> => {
  try {
    const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    }));
    
    // Return base64 string
    return response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  } catch (e) {
    console.error("Error generating audio:", e);
    return undefined;
  }
};

export const generateIllustration = async (title: string, summary: string): Promise<string | undefined> => {
  try {
    const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [{ 
          text: `Create a detailed, abstract, scientific illustration for a research paper titled "${title}". 
                 Summary: ${summary}. 
                 Style: Modern digital art, clean, isometric, data visualization aesthetic, high resolution, colorful but professional.` 
        }],
      },
      config: {
        imageConfig: { aspectRatio: "16:9" }
      }
    }));

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData && part.inlineData.data) {
        return part.inlineData.data;
      }
    }
    return undefined;
  } catch (error) {
    console.error("Error generating illustration:", error);
    return undefined;
  }
};

export const streamChatResponse = async (
  history: Message[],
  contextPapers: Paper[],
  userMessage: string,
  onChunk: (text: string) => void
) => {
  
  const knowledgeBase = contextPapers
    .filter(p => p.status === 'converted' && p.blogContent)
    .map(p => `### PAPER: ${p.title} (${p.year})\nAUTHORS: ${p.authors.join(", ")}\nCONTENT:\n${p.blogContent}\n`)
    .join('\n---\n');

  const systemInstruction = `
    You are an expert research assistant. 
    You have access to a knowledge base of papers below.
    
    If the user asks about these papers, use the provided KNOWLEDGE BASE.
    If the user asks about external information or general questions, you may use the Google Search tool to find the answer.
    
    KNOWLEDGE BASE:
    ${knowledgeBase}
  `;

  try {
    const chat = ai.chats.create({
      model: 'gemini-3-flash-preview',
      config: {
        systemInstruction,
        tools: [{ googleSearch: {} }] // Enabled search for chat
      }
    });

    const result = await chat.sendMessageStream({ message: userMessage });

    for await (const chunk of result) {
      if (chunk.text) {
        onChunk(chunk.text);
      }
    }
  } catch (error) {
    console.error("Chat error:", error);
    onChunk("\n[Error: Could not retrieve response from the model. Please try again.]");
  }
};