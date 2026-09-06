import { describe, expect, it } from 'vitest';
import { pcmToWav, slugify } from '../server/export';

/**
 * Gemini TTS returns headerless PCM, so this header is the only thing standing
 * between stored bytes and audio the browser will play. A silent regression
 * here produces a file that downloads fine and refuses to open.
 */
describe('pcmToWav', () => {
  const pcm = Buffer.alloc(100, 7);
  const wav = pcmToWav(pcm, 24000);

  it('prepends exactly 44 bytes and keeps the samples intact', () => {
    expect(wav.length).toBe(144);
    expect(wav.subarray(44)).toEqual(pcm);
  });

  it('writes the RIFF/WAVE/fmt/data chunk markers', () => {
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.toString('ascii', 36, 40)).toBe('data');
  });

  it('declares 16-bit mono PCM at the requested rate', () => {
    expect(wav.readUInt16LE(20)).toBe(1);      // format: PCM
    expect(wav.readUInt16LE(22)).toBe(1);      // channels
    expect(wav.readUInt32LE(24)).toBe(24000);  // sample rate
    expect(wav.readUInt16LE(34)).toBe(16);     // bits per sample
  });

  it('derives byte rate and block align from the format', () => {
    expect(wav.readUInt16LE(32)).toBe(2);        // blockAlign = 1ch * 16bit / 8
    expect(wav.readUInt32LE(28)).toBe(48000);    // byteRate = rate * blockAlign
  });

  it('sizes both length fields against the payload', () => {
    expect(wav.readUInt32LE(4)).toBe(136);   // 36 + data
    expect(wav.readUInt32LE(40)).toBe(100);  // data
  });

  it('honours a non-default sample rate', () => {
    const other = pcmToWav(pcm, 16000);
    expect(other.readUInt32LE(24)).toBe(16000);
    expect(other.readUInt32LE(28)).toBe(32000);
  });
});

/** Slugs become filenames inside the export ZIP, so they must never be empty. */
describe('slugify', () => {
  it('lowercases and joins on single hyphens', () => {
    expect(slugify('Attention Is All You Need')).toBe('attention-is-all-you-need');
  });

  it('strips accents rather than dropping the letters', () => {
    expect(slugify('Étude sur la Récursion')).toBe('etude-sur-la-recursion');
  });

  it('collapses punctuation runs and trims the edges', () => {
    expect(slugify('  ...Hello, World!!  ')).toBe('hello-world');
  });

  it('never returns an empty string', () => {
    expect(slugify('')).toBe('untitled');
    expect(slugify('!!!')).toBe('untitled');
    expect(slugify('   ')).toBe('untitled');
  });

  it('truncates without leaving a trailing hyphen', () => {
    const slug = slugify('a'.repeat(40) + ' ' + 'b'.repeat(40), 41);
    expect(slug.length).toBeLessThanOrEqual(41);
    expect(slug.endsWith('-')).toBe(false);
  });
});
