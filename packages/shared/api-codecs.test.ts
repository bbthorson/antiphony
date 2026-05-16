import { describe, it, expect } from 'vitest';
import { SubmitReplyRequestSchema } from './api-codecs';

describe('API Codecs Security Limits', () => {
  describe('SubmitReplyRequestSchema', () => {
    it('should reject phoneNumber longer than 20 characters', () => {
      const input = {
        phoneNumber: '1'.repeat(21),
        otp: '123456',
        promptId: 'p1',
        audioUrl: 'https://example.com/audio.webm',
        durationMs: 1000
      };
      const result = SubmitReplyRequestSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('String must contain at most 20 character(s)');
      }
    });

    it('should reject otp longer than 10 characters', () => {
      const input = {
        phoneNumber: '+15555555555',
        otp: '1'.repeat(11),
        promptId: 'p1',
        audioUrl: 'https://example.com/audio.webm',
        durationMs: 1000
      };
      const result = SubmitReplyRequestSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('String must contain at most 10 character(s)');
      }
    });
  });
});
