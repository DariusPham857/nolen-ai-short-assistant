import { describe, it, expect } from 'vitest';
import { assertSafeRemoteUrl, isPrivateIp } from './ssrf.js';

describe('SSRF Protection (PD-AT-07)', () => {
  it('identifies private, loopback, and link-local IP addresses', () => {
    // Loopback
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('127.0.1.5')).toBe(true);
    expect(isPrivateIp('::1')).toBe(true);

    // Private networks
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('192.168.1.100')).toBe(true);

    // Cloud metadata link-local
    expect(isPrivateIp('169.254.169.254')).toBe(true);
    expect(isPrivateIp('169.254.0.1')).toBe(true);

    // Public IPs should NOT be private
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
  });

  it('rejects disallowed schemes and private loopback/metadata targets', async () => {
    // Disallowed schemes
    await expect(assertSafeRemoteUrl('file:///etc/passwd')).rejects.toThrow('SSRF_DISALLOWED_SCHEME');
    await expect(assertSafeRemoteUrl('ftp://example.com/asset.png')).rejects.toThrow('SSRF_DISALLOWED_SCHEME');
    await expect(assertSafeRemoteUrl('gopher://127.0.0.1:70/')).rejects.toThrow('SSRF_DISALLOWED_SCHEME');

    // Loopback & metadata
    await expect(assertSafeRemoteUrl('http://127.0.0.1/keyframe.png')).rejects.toThrow('SSRF_PRIVATE_IP');
    await expect(assertSafeRemoteUrl('http://localhost:5432/db')).rejects.toThrow('SSRF_PRIVATE_IP');
    await expect(assertSafeRemoteUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow('SSRF_PRIVATE_IP');
    await expect(assertSafeRemoteUrl('http://10.0.1.20:8080/internal.mp4')).rejects.toThrow('SSRF_PRIVATE_IP');
  });

  it('accepts valid public HTTPS media URLs', async () => {
    const validUrl = 'https://storage.googleapis.com/nolen-public-assets/sample.png';
    const result = await assertSafeRemoteUrl(validUrl);
    expect(result.hostname).toBe('storage.googleapis.com');
    expect(result.protocol).toBe('https:');
  });
});
