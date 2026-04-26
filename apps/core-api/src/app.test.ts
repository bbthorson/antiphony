import { describe, it, expect } from 'vitest';
import { parseAllowedOrigins } from './app.js';

describe('parseAllowedOrigins', () => {
    it('falls back to localhost dev port when env var is undefined', () => {
        expect(parseAllowedOrigins(undefined)).toEqual(['http://localhost:9002']);
    });

    it('falls back to localhost dev port when env var is an empty string', () => {
        expect(parseAllowedOrigins('')).toEqual(['http://localhost:9002']);
    });

    it('falls back to localhost dev port when env var is whitespace-only', () => {
        expect(parseAllowedOrigins('   ,  ,  ')).toEqual(['http://localhost:9002']);
    });

    it('parses a single origin', () => {
        expect(parseAllowedOrigins('https://example.com')).toEqual([
            'https://example.com',
        ]);
    });

    it('parses a comma-separated list', () => {
        expect(
            parseAllowedOrigins('https://example.com,https://app.example.com'),
        ).toEqual(['https://example.com', 'https://app.example.com']);
    });

    it('trims whitespace around entries', () => {
        expect(
            parseAllowedOrigins('  https://example.com , https://app.example.com  '),
        ).toEqual(['https://example.com', 'https://app.example.com']);
    });

    it('drops empty entries from the list', () => {
        expect(
            parseAllowedOrigins('https://example.com,,https://app.example.com,'),
        ).toEqual(['https://example.com', 'https://app.example.com']);
    });
});
