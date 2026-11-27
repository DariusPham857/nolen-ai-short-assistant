import { describe, it, expect } from 'vitest';
import { assertSafeRemoteUrl, isPrivateIp, isPublicUnicastIp, resolveAndValidateRemoteUrl } from './ssrf.js';

describe('SSRF Protection (PD-AT-07 / PD-05b.2)', () => {
  it('fails closed on non-public unicast ranges, IPv4-mapped IPv6, and malformed strings', () => {
    // Malformed / invalid inputs MUST return false
    expect(isPublicUnicastIp('')).toBe(false);
    expect(isPublicUnicastIp('invalid')).toBe(false);
    expect(isPublicUnicastIp('999.999.999.999')).toBe(false);
    expect(isPublicUnicastIp('fe80::1%eth0')).toBe(false);

    // Loopback & current network
    expect(isPublicUnicastIp('127.0.0.1')).toBe(false);
    expect(isPublicUnicastIp('127.0.1.5')).toBe(false);
    expect(isPublicUnicastIp('0.0.0.0')).toBe(false);
    expect(isPublicUnicastIp('::1')).toBe(false);
    expect(isPublicUnicastIp('::')).toBe(false);

    // Private RFC 1918 & CGNAT
    expect(isPublicUnicastIp('10.0.0.1')).toBe(false);
    expect(isPublicUnicastIp('172.16.0.1')).toBe(false);
    expect(isPublicUnicastIp('172.31.255.255')).toBe(false);
    expect(isPublicUnicastIp('192.168.1.100')).toBe(false);
    expect(isPublicUnicastIp('100.64.0.1')).toBe(false);
    expect(isPublicUnicastIp('100.127.255.254')).toBe(false);

    // Cloud metadata & special RFC 6890 ranges
    expect(isPublicUnicastIp('169.254.169.254')).toBe(false);
    expect(isPublicUnicastIp('192.0.0.1')).toBe(false);
    expect(isPublicUnicastIp('192.0.2.1')).toBe(false);
    expect(isPublicUnicastIp('192.88.99.1')).toBe(false);
    expect(isPublicUnicastIp('198.18.0.1')).toBe(false);
    expect(isPublicUnicastIp('198.51.100.1')).toBe(false);
    expect(isPublicUnicastIp('203.0.113.1')).toBe(false);
    expect(isPublicUnicastIp('224.0.0.1')).toBe(false);
    expect(isPublicUnicastIp('240.0.0.1')).toBe(false);
    expect(isPublicUnicastIp('255.255.255.255')).toBe(false);

    // IPv6 private/ULA/link-local/multicast/doc/transition
    expect(isPublicUnicastIp('fc00::1')).toBe(false);
    expect(isPublicUnicastIp('fd12:3456::1')).toBe(false);
    expect(isPublicUnicastIp('fe80::1')).toBe(false);
    expect(isPublicUnicastIp('ff02::1')).toBe(false);
    expect(isPublicUnicastIp('2001:db8::1')).toBe(false);
    expect(isPublicUnicastIp('2002:7f00:0001::')).toBe(false);

    // IPv4-mapped IPv6 (both dotted and hex normalized forms)
    expect(isPublicUnicastIp('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicUnicastIp('::ffff:7f00:1')).toBe(false);
    expect(isPublicUnicastIp('::ffff:169.254.169.254')).toBe(false);

    // Valid public unicast IPs
    expect(isPublicUnicastIp('8.8.8.8')).toBe(true);
    expect(isPublicUnicastIp('1.1.1.1')).toBe(true);
    expect(isPublicUnicastIp('2606:4700:4700::1111')).toBe(true);
    expect(isPublicUnicastIp('::ffff:8.8.8.8')).toBe(true);

    // Backward-compatible isPrivateIp checks
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('100.64.0.1')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
  });

  it('rejects disallowed schemes and private loopback/metadata/IPv4-mapped targets', async () => {
    await expect(assertSafeRemoteUrl('file:///etc/passwd')).rejects.toThrow('SSRF_DISALLOWED_SCHEME');
    await expect(assertSafeRemoteUrl('ftp://example.com/asset.png')).rejects.toThrow('SSRF_DISALLOWED_SCHEME');
    await expect(assertSafeRemoteUrl('gopher://127.0.0.1:70/')).rejects.toThrow('SSRF_DISALLOWED_SCHEME');

    await expect(assertSafeRemoteUrl('http://127.0.0.1/keyframe.png')).rejects.toThrow('SSRF_PRIVATE_IP');
    await expect(assertSafeRemoteUrl('http://[::ffff:127.0.0.1]/keyframe.png')).rejects.toThrow('SSRF_PRIVATE_IP');
    await expect(assertSafeRemoteUrl('http://localhost:5432/db')).rejects.toThrow('SSRF_PRIVATE_IP');
    await expect(assertSafeRemoteUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow('SSRF_PRIVATE_IP');
    await expect(assertSafeRemoteUrl('http://10.0.1.20:8080/internal.mp4')).rejects.toThrow('SSRF_PRIVATE_IP');
    await expect(assertSafeRemoteUrl('http://100.64.0.10/internal.mp4')).rejects.toThrow('SSRF_PRIVATE_IP');
  });

  it('accepts valid public HTTPS media URLs and pins resolved public unicast IP', async () => {
    const validUrl = 'https://storage.googleapis.com/nolen-public-assets/sample.png';
    const result = await resolveAndValidateRemoteUrl(validUrl, async () => [
      { address: '142.250.190.144', family: 4 },
    ]);
    expect(result.url.hostname).toBe('storage.googleapis.com');
    expect(result.url.protocol).toBe('https:');
    expect(result.resolvedIp).toBe('142.250.190.144');
    expect(result.family).toBe(4);
  });
});
