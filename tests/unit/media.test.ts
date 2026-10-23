import { describe, expect, it } from 'vitest';
import { extensionFor, normalizeMime, sanitizeFileName } from '../../src/main/services/mediaLibrary';

describe('sanitizeFileName', () => {
  it('strips directories and unsafe characters', () => {
    expect(sanitizeFileName('dir/photo.png')).toBe('photo.png');
    expect(sanitizeFileName('a<b>c:d"e|f?g*h.png')).toBe('a_b_c_d_e_f_g_h.png');
    expect(sanitizeFileName('line\nbreak\tname.png')).toBe('line_break_name.png');
  });

  it('decodes percent-encoded names safely', () => {
    expect(sanitizeFileName('%E6%B5%8B%E8%AF%95.png')).toBe('测试.png');
    expect(sanitizeFileName('bad%2')).toBe('bad%2');
  });

  it('caps the length and never returns empty', () => {
    expect(sanitizeFileName(`${'x'.repeat(300)}.mp4`)).toHaveLength(120);
    expect(sanitizeFileName('')).toMatch(/^媒体-\d+$/);
    expect(sanitizeFileName('   ')).toMatch(/^媒体-\d+$/);
  });
});

describe('normalizeMime', () => {
  it('normalizes parameters and case', () => {
    expect(normalizeMime('IMAGE/PNG; charset=binary', 'x')).toBe('image/png');
    expect(normalizeMime('video/mp4', 'x')).toBe('video/mp4');
  });

  it('falls back to the extension for generic types', () => {
    expect(normalizeMime('application/octet-stream', 'clip.MP4')).toBe('video/mp4');
    expect(normalizeMime('', 'song.flac')).toBe('audio/flac');
    expect(normalizeMime('', 'unknown.xyz')).toBe('application/octet-stream');
    expect(normalizeMime('application/octet-stream', 'noext')).toBe('application/octet-stream');
  });
});

describe('extensionFor', () => {
  it('prefers a short filename extension', () => {
    expect(extensionFor('photo.PNG', 'image/jpeg')).toBe('png');
    expect(extensionFor('song.mp3', 'audio/mpeg')).toBe('mp3');
  });

  it('derives an extension from mime or falls back to bin', () => {
    expect(extensionFor('noext', 'video/webm')).toBe('webm');
    expect(extensionFor('noext', 'image/jpeg')).toBe('jpg');
    expect(extensionFor('weird.superlongext', 'application/octet-stream')).toBe('bin');
    expect(extensionFor('', 'application/octet-stream')).toBe('bin');
  });
});
