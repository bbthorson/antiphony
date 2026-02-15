"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const api_codecs_1 = require("./api-codecs");
(0, vitest_1.describe)('API Codecs Security Limits', () => {
    (0, vitest_1.describe)('UpdateAuthorDataRequestSchema', () => {
        (0, vitest_1.it)('should reject authorNotes longer than 5000 characters', () => {
            const longNotes = 'a'.repeat(5001);
            const input = {
                replyId: '123',
                data: {
                    authorNotes: longNotes,
                },
            };
            const result = api_codecs_1.UpdateAuthorDataRequestSchema.safeParse(input);
            (0, vitest_1.expect)(result.success).toBe(false);
            if (!result.success) {
                (0, vitest_1.expect)(result.error.issues[0].message).toContain('String must contain at most 5000 character(s)');
            }
        });
        (0, vitest_1.it)('should reject authorTags array with more than 20 items', () => {
            const manyTags = Array(21).fill('tag');
            const input = {
                replyId: '123',
                data: {
                    authorTags: manyTags,
                },
            };
            const result = api_codecs_1.UpdateAuthorDataRequestSchema.safeParse(input);
            (0, vitest_1.expect)(result.success).toBe(false);
            if (!result.success) {
                (0, vitest_1.expect)(result.error.issues[0].message).toContain('Array must contain at most 20 element(s)');
            }
        });
        (0, vitest_1.it)('should reject authorTags items longer than 50 characters', () => {
            const longTag = 'a'.repeat(51);
            const input = {
                replyId: '123',
                data: {
                    authorTags: [longTag],
                },
            };
            const result = api_codecs_1.UpdateAuthorDataRequestSchema.safeParse(input);
            (0, vitest_1.expect)(result.success).toBe(false);
            if (!result.success) {
                (0, vitest_1.expect)(result.error.issues[0].message).toContain('String must contain at most 50 character(s)');
            }
        });
        (0, vitest_1.it)('should accept valid input', () => {
            const input = {
                replyId: '123',
                data: {
                    authorNotes: 'Valid notes',
                    authorTags: ['valid tag'],
                }
            };
            const result = api_codecs_1.UpdateAuthorDataRequestSchema.safeParse(input);
            (0, vitest_1.expect)(result.success).toBe(true);
        });
    });
    (0, vitest_1.describe)('SubmitReplyRequestSchema', () => {
        (0, vitest_1.it)('should reject phoneNumber longer than 20 characters', () => {
            const input = {
                phoneNumber: '1'.repeat(21),
                otp: '123456',
                promptId: 'p1',
                audioUrl: 'https://example.com/audio.webm',
                durationMs: 1000
            };
            const result = api_codecs_1.SubmitReplyRequestSchema.safeParse(input);
            (0, vitest_1.expect)(result.success).toBe(false);
            if (!result.success) {
                (0, vitest_1.expect)(result.error.issues[0].message).toContain('String must contain at most 20 character(s)');
            }
        });
        (0, vitest_1.it)('should reject otp longer than 10 characters', () => {
            const input = {
                phoneNumber: '+15555555555',
                otp: '1'.repeat(11),
                promptId: 'p1',
                audioUrl: 'https://example.com/audio.webm',
                durationMs: 1000
            };
            const result = api_codecs_1.SubmitReplyRequestSchema.safeParse(input);
            (0, vitest_1.expect)(result.success).toBe(false);
            if (!result.success) {
                (0, vitest_1.expect)(result.error.issues[0].message).toContain('String must contain at most 10 character(s)');
            }
        });
    });
});
