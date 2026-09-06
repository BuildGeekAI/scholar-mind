# Deployment Guide

ScholarMind is a static frontend application. It can be deployed to any static site hosting provider (Vercel, Netlify, Cloudflare Pages, GitHub Pages, S3, etc.).

## Prerequisites
1. **Google Gemini API Key:** You must have a valid API key from [Google AI Studio](https://aistudio.google.com/).
2. **Build Tool:** The project is configured for a standard bundler (likely Vite or similar).

## Environment Variables
The application requires the API key to be available at build time or runtime depending on your security model.
For this client-side demo, the key is expected in `process.env.API_KEY`.

Create a `.env` file in the root:
```env
API_KEY=your_key_here
```

**Security Note:** Since this is a client-side app, the API key is exposed to the browser. For production use cases, you should proxy these requests through a backend server.

## Deploying to Vercel
1. Push your code to a Git repository (GitHub, GitLab, Bitbucket).
2. Import the project into Vercel.
3. Vercel should auto-detect the framework (Vite/React).
4. Add your `API_KEY` in the **Environment Variables** section of the Project Settings.
5. Deploy.

## Deploying to Netlify
1. Connect your Git repository to Netlify.
2. Set the build command to `npm run build` and publish directory to `dist` (or `build`).
3. Go to **Site settings > Build & deploy > Environment**.
4. Add `API_KEY` as a variable.
5. Deploy site.
