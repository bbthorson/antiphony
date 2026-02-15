import { describe, it, expect } from 'vitest';
import { UpdateAuthorDataRequestSchema, SubmitReplyRequestSchema } from './api-codecs';

describe('API Codecs Security Limits', () => {
  describe('UpdateAuthorDataRequestSchema', () => {
    it('should reject authorNotes longer than 5000 characters', () => {
      const longNotes = 'a'.repeat(5001);
      const input = {
        replyId: '123',
        data: {
          authorNotes: longNotes,
        },
      };
      const result = UpdateAuthorDataRequestSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('String must contain at most 5000 character(s)');
      }
    });

    it('should reject authorTags array with more than 20 items', () => {
      const manyTags = Array(21).fill('tag');
      const input = {
        replyId: '123',
        data: {
          authorTags: manyTags,
        },
      };
      const result = UpdateAuthorDataRequestSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Array must contain at most 20 element(s)');
      }
    });

    it('should reject authorTags items longer than 50 characters', () => {
      const longTag = 'a'.repeat(51);
      const input = {
        replyId: '123',
        data: {
          authorTags: [longTag],
        },
      };
      const result = UpdateAuthorDataRequestSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('String must contain at most 50 character(s)');
      }
    });

    it('should accept valid input', () => {
      const input = {
        replyId: '123',
        data: {
          authorNotes: 'Valid notes',
          authorTags: ['valid tag'],
        }
      };
      const result = UpdateAuthorDataRequestSchema.safeParse(input);
      expect(result.success).toBe(true);
    });
  });

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
