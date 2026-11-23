import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Checks if an IP address (IPv4 or IPv6) falls within private, loopback,
 * link-local, carrier-grade NAT, or reserved ranges per OWASP SSRF prevention.
 */
export function isPrivateIp(ip: string): boolean {
  // Normalize IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1)
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

  const family = net.isIP(normalized);
  if (!family) return false;

  if (family === 4) {
    const parts = normalized.split('.').map(Number);
    const [b0, b1] = parts;

    // 0.0.0.0/8
    if (b0 === 0) return true;
    // 127.0.0.0/8 (loopback)
    if (b0 === 127) return true;
    // 10.0.0.0/8 (RFC 1918)
    if (b0 === 10) return true;
    // 172.16.0.0/12 (RFC 1918)
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    // 192.168.0.0/16 (RFC 1918)
    if (b0 === 192 && b1 === 168) return true;
    // 169.254.0.0/16 (link-local, cloud metadata service)
    if (b0 === 169 && b1 === 254) return true;
    // 100.64.0.0/10 (carrier-grade NAT)
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;

    return false;
  }

  if (family === 6) {
    const lower = normalized.toLowerCase();
    // ::1 (loopback) or :: (unspecified)
    if (lower === '::1' || lower === '::') return true;
    // fc00::/7 (unique local address)
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    // fe80::/10 (link-local)
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;

    return false;
  }

  return false;
}

/**
 * Validates that a remote media locator URL:
 * 1. Uses an approved scheme ('http:' or 'https:').
 * 2. Does not resolve to private, loopback, or cloud-metadata IPs.
 * 3. Does not use localhost.
 *
 * Throws SSRF_DISALLOWED_SCHEME or SSRF_PRIVATE_IP on violation.
 */
export async function assertSafeRemoteUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('SSRF_INVALID_URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('SSRF_DISALLOWED_SCHEME');
  }

  const hostname = parsed.hostname.toLowerCase();

  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('SSRF_PRIVATE_IP');
  }

  // If hostname is directly an IP address
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error('SSRF_PRIVATE_IP');
    }
    return parsed;
  }

  // Resolve hostname via DNS to prevent DNS rebinding to private IPs
  try {
    const records = await dns.lookup(hostname, { all: true });
    for (const record of records) {
      if (isPrivateIp(record.address)) {
        throw new Error('SSRF_PRIVATE_IP');
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'SSRF_PRIVATE_IP') {
      throw err;
    }
    // DNS resolution failure
    throw new Error('SSRF_DNS_LOOKUP_FAILED');
  }

  return parsed;
}
