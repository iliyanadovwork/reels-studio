import { describe, it, expect } from 'vitest';
import { introVoiceStartOutput, introVoiceEndOutput, introContentTime } from './introTiming';

describe('introVoiceStartOutput', () => {
  it('untrimmed reel (the common case): voice starts at output 0', () => {
    expect(introVoiceStartOutput(0, 0, 1)).toBe(0);
  });

  it('TRIMMED reel: voice still starts at output 0 — it never skips its own head', () => {
    // This is the exact bug the review caught: the old code did src.start(0, clipStart), skipping the first
    // `clipStart` seconds of the VOICE when the VIDEO was trimmed. The intro must play from word one.
    expect(introVoiceStartOutput(0, 2, 1)).toBe(0);
    expect(introVoiceStartOutput(0, 10, 1)).toBe(0);
  });

  it('tolerates videoRate 0 without dividing by zero', () => {
    expect(Number.isFinite(introVoiceStartOutput(0, 0, 0))).toBe(true);
  });
});

describe('introVoiceEndOutput', () => {
  it('untrimmed: ends exactly at audioDuration', () => {
    expect(introVoiceEndOutput(0, 5, 0, 1)).toBe(5);
  });

  it('TRIMMED: still ends at audioDuration (voice length is independent of the trim)', () => {
    // The duck must release when the VOICE ends. The old export over-ducked by `clipStart` seconds because
    // its end formula clamped the negative head to 0 while the voice actually ended earlier. With the voice
    // now playing in full from output 0, the release point is simply audioDuration.
    expect(introVoiceEndOutput(0, 5, 2, 1)).toBe(5);
    expect(introVoiceEndOutput(0, 5, 8, 1)).toBe(5);
  });

  it('end is always start + duration', () => {
    const start = introVoiceStartOutput(0, 3, 1);
    expect(introVoiceEndOutput(0, 4.2, 3, 1)).toBeCloseTo(start + 4.2, 6);
  });
});

describe('introContentTime', () => {
  it('output origin (clipStart) maps to content time 0', () => {
    expect(introContentTime(0, 0)).toBe(0);
    expect(introContentTime(2, 2)).toBe(0);
  });

  it('advances linearly from the origin', () => {
    expect(introContentTime(3, 0)).toBe(3);
    expect(introContentTime(5, 2)).toBe(3);   // 3s past the trimmed start
  });

  it('is negative before the clip start (caller shows no caption there)', () => {
    expect(introContentTime(1, 2)).toBe(-1);
  });
});

describe('preview/export agreement (the point of sharing the math)', () => {
  // Whatever trim the user sets, the voice-end (duck release) and the caption clock must line up in BOTH
  // surfaces because both call these functions. Assert the two derivations agree for a range of trims.
  for (const clipStart of [0, 0.5, 2, 7.3]) {
    it(`voice end == caption time at voice end (clipStart=${clipStart})`, () => {
      const audioDuration = 6;
      const voiceEndOutput = introVoiceEndOutput(0, audioDuration, clipStart, 1);
      // The source-time at which the voice ends is clipStart + voiceEndOutput; its content-time must equal the
      // voice-end output time — i.e. the caption for the last word is on screen exactly as the voice finishes.
      const sourceAtVoiceEnd = clipStart + voiceEndOutput;
      expect(introContentTime(sourceAtVoiceEnd, clipStart)).toBeCloseTo(voiceEndOutput, 6);
      expect(voiceEndOutput).toBe(audioDuration);   // and it's trim-independent
    });
  }
});
