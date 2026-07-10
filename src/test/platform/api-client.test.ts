import { describe, expect, test } from 'vitest';
import { resolveApiBaseUrl } from '../../platform/api-client.js';

describe('resolveApiBaseUrl', () => {
  test('prefers the meta tag override when present', () => {
    expect(resolveApiBaseUrl({
      metaBaseUrl: 'https://api-meta.example.com/',
      storageBaseUrl: 'https://api-storage.example.com',
      hostname: 'play.example.com',
    })).toBe('https://api-meta.example.com');
  });

  test('uses the local storage override when there is no meta tag', () => {
    expect(resolveApiBaseUrl({
      metaBaseUrl: '',
      storageBaseUrl: 'https://api-storage.example.com/',
      hostname: 'play.example.com',
    })).toBe('https://api-storage.example.com');
  });

  test('maps local browser hosts to the local API origin', () => {
    expect(resolveApiBaseUrl({
      hostname: 'localhost',
    })).toBe('http://localhost:8787');
    expect(resolveApiBaseUrl({
      hostname: '127.0.0.1',
    })).toBe('http://localhost:8787');
    expect(resolveApiBaseUrl({
      hostname: '::1',
    })).toBe('http://localhost:8787');
  });

  test('strips a leading www for production hosts', () => {
    expect(resolveApiBaseUrl({
      hostname: 'www.disco.example',
    })).toBe('https://api.disco.example');
  });
});
