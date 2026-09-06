import { zipSync } from 'fflate';
import { FlashCard, Paper, QuizQuestion, Slide } from '../types';
import { BlobStore } from './blobStore';
import { ProfileRecord } from './repository';

/**
 * Gemini TTS returns headerless 24kHz mono Int16 PCM (confirmed by the spike),
 * so a 44-byte RIFF header is what turns stored bytes into a playable file.
 */
export const pcmToWav = (
  pcm: Buffer,
  sampleRate = 24000,
  channels = 1,
  bitsPerSample = 16
): Buffer => {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);           // PCM subchunk size
  header.writeUInt16LE(1, 20);            // audio format 1 = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
};

/** Rate is carried on the mime type as `audio/l16; rate=24000`. */
const sampleRateOf = (mime?: string): number =>
  Number(mime?.match(/rate=(\d+)/)?.[1]) || 24000;

export const slugify = (value: string, max = 60): string => {
  const slug = (value || 'untitled')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'untitled';
};

const extensionFor = (mime?: string): string => {
  if (!mime) return 'bin';
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('pdf')) return 'pdf';
  return 'bin';
};

const slidesMarkdown = (slides: Slide[]): string =>
  slides.map(s => `## ${s.title}\n\n${s.points.map(p => `- ${p}`).join('\n')}`).join('\n\n---\n\n');

const quizMarkdown = (quiz: QuizQuestion[]): string =>
  quiz
    .map((q, i) => {
      const options = q.options
        .map((o, j) => `${j === q.correctAnswer ? '- [x]' : '- [ ]'} ${o}`)
        .join('\n');
      return `### ${i + 1}. ${q.question}\n\n${options}\n\n> ${q.explanation}`;
    })
    .join('\n\n');

const flashcardsCsv = (cards: FlashCard[]): string => {
  const escape = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`;
  return ['front,back', ...cards.map(c => `${escape(c.front)},${escape(c.back)}`)].join('\n');
};

const blogMarkdown = (paper: Paper): string => {
  const front = [
    '---',
    `title: ${JSON.stringify(paper.blogTitle || paper.title)}`,
    `paper: ${JSON.stringify(paper.title)}`,
    `authors: ${JSON.stringify(paper.authors ?? [])}`,
    `year: ${JSON.stringify(paper.year ?? '')}`,
    paper.citationCount ? `citations: ${JSON.stringify(paper.citationCount)}` : '',
    paper.sourceUrl ? `source: ${JSON.stringify(paper.sourceUrl)}` : '',
    '---',
    '',
  ].filter(Boolean).join('\n');
  return front + (paper.blogContent || '');
};

const encoder = new TextEncoder();

export const buildProfileZip = async (
  profile: ProfileRecord,
  papers: Paper[],
  blobs: BlobStore
): Promise<Buffer> => {
  const files: Record<string, Uint8Array> = {};
  const root = slugify(profile.title);
  const used = new Set<string>();

  const index = [`# ${profile.title}`, ''];
  if (profile.affiliation) index.push(`**Affiliation:** ${profile.affiliation}`, '');

  for (const paper of papers) {
    let dir = slugify(paper.title);
    let n = 2;
    while (used.has(dir)) dir = `${slugify(paper.title, 55)}-${n++}`;
    used.add(dir);

    const base = `${root}/${dir}`;
    index.push(`- ${paper.title} (${paper.year || 'n.d.'}) — \`${dir}/\``);

    if (paper.blogContent) files[`${base}/blog.md`] = encoder.encode(blogMarkdown(paper));
    if (paper.slides?.length) files[`${base}/slides.md`] = encoder.encode(slidesMarkdown(paper.slides));
    if (paper.quiz?.length) files[`${base}/quiz.md`] = encoder.encode(quizMarkdown(paper.quiz));
    if (paper.flashCards?.length)
      files[`${base}/flashcards.csv`] = encoder.encode(flashcardsCsv(paper.flashCards));

    files[`${base}/metadata.json`] = encoder.encode(
      JSON.stringify(
        {
          title: paper.title,
          authors: paper.authors,
          year: paper.year,
          citationCount: paper.citationCount,
          summary: paper.summary,
          sourceUrl: paper.sourceUrl,
          pdfStatus: paper.pdfStatus,
        },
        null,
        2
      )
    );

    if (paper.illustrationKey) {
      const blob = await blobs.get(paper.illustrationKey).catch(() => null);
      // Extension follows the stored mime rather than assuming PNG (finding R11).
      if (blob) files[`${base}/illustration.${extensionFor(blob.contentType)}`] = new Uint8Array(blob.data);
    }
    if (paper.audioKey) {
      const blob = await blobs.get(paper.audioKey).catch(() => null);
      if (blob) {
        const wav = pcmToWav(blob.data, sampleRateOf(blob.contentType));
        files[`${base}/audio.wav`] = new Uint8Array(wav);
      }
    }
    if (paper.pdfKey) {
      const blob = await blobs.get(paper.pdfKey).catch(() => null);
      if (blob) files[`${base}/paper.pdf`] = new Uint8Array(blob.data);
    }
  }

  files[`${root}/README.md`] = encoder.encode(index.join('\n'));
  // level 0: the payload is dominated by already-compressed JPEG, WAV and PDF.
  return Buffer.from(zipSync(files, { level: 0 }));
};
