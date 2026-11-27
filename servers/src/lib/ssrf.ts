import dns from 'node:dns/promises';
import net from 'node:net';

export type DnsLookupRecord = { address: string; family: number };
export type DnsLookupFn = (hostname: string) => Promise<DnsLookupRecord[]>;

const defaultDnsLookup: DnsLookupFn = async (hostname: string) => {
  return dns.lookup(hostname, { all: true });
};

function parseIpv6Hextets(ip: string): number[] | null {
  if (ip.includes('%')) return null; // Reject zone IDs

  // Handle embedded IPv4 tail (e.g. ::ffff:127.0.0.1)
  let work = ip.toLowerCase();
  const lastColon = work.lastIndexOf(':');
  if (lastColon !== -1 && work.slice(lastColon + 1).includes('.')) {
    const ipv4Part = work.slice(lastColon + 1);
    if (net.isIP(ipv4Part) !== 4) return null;
    const octets = ipv4Part.split('.').map(Number);
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    work = `${work.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const doubleColonParts = work.split('::');
  if (doubleColonParts.length > 2) return null;

  const parseGroup = (segment: string): number[] | null => {
    if (!segment) return [];
    const parts = segment.split(':');
    const out: number[] = [];
    for (const p of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
      out.push(parseInt(p, 16));
    }
    return out;
  };

  if (doubleColonParts.length === 1) {
    const groups = parseGroup(doubleColonParts[0]);
    return groups && groups.length === 8 ? groups : null;
  }

  const head = parseGroup(doubleColonParts[0]);
  const tail = parseGroup(doubleColonParts[1]);
  if (!head || !tail) return null;
  const missing = 8 - (head.length + tail.length);
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function isPublicUnicastIpv4Octets(octets: [number, number, number, number]): boolean {
  const [b0, b1, b2] = octets;

  if (b0 === 0) return false; // 0.0.0.0/8 (Current network)
  if (b0 === 10) return false; // 10.0.0.0/8 (RFC 1918)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return false; // 100.64.0.0/10 (CGNAT)
  if (b0 === 127) return false; // 127.0.0.0/8 (Loopback)
  if (b0 === 169 && b1 === 254) return false; // 169.254.0.0/16 (Link-local / Cloud metadata)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return false; // 172.16.0.0/12 (RFC 1918)
  if (b0 === 192 && b1 === 0 && b2 === 0) return false; // 192.0.0.0/24 (IETF protocol assignments)
  if (b0 === 192 && b1 === 0 && b2 === 2) return false; // 192.0.2.0/24 (TEST-NET-1)
  if (b0 === 192 && b1 === 88 && b2 === 99) return false; // 192.88.99.0/24 (6to4 relay)
  if (b0 === 192 && b1 === 168) return false; // 192.168.0.0/16 (RFC 1918)
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return false; // 198.18.0.0/15 (Benchmarking)
  if (b0 === 198 && b1 === 51 && b2 === 100) return false; // 198.51.100.0/24 (TEST-NET-2)
  if (b0 === 203 && b1 === 0 && b2 === 113) return false; // 203.0.113.0/24 (TEST-NET-3)
  if (b0 >= 224) return false; // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved / Broadcast)

  return true;
}

/**
 * Strict fail-closed validator confirming an IP string is a valid public unicast address.
 * Rejects malformed strings, private/loopback/link-local/CGNAT/benchmarking/documentation/multicast/reserved ranges,
 * and IPv4-mapped IPv6 addresses targeting non-public IPv4 space.
 */
export function isPublicUnicastIp(ip: string): boolean {
  if (typeof ip !== 'string' || ip.length === 0) return false;
  const cleaned = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  const family = net.isIP(cleaned);

  if (family === 4) {
    const parts = cleaned.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
      return false;
    }
    return isPublicUnicastIpv4Octets(parts as [number, number, number, number]);
  }

  if (family === 6) {
    const h = parseIpv6Hextets(cleaned);
    if (!h) return false;

    // Check IPv4-mapped IPv6 (::ffff:0:0/96)
    if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
      const octets: [number, number, number, number] = [
        (h[6] >> 8) & 0xff,
        h[6] & 0xff,
        (h[7] >> 8) & 0xff,
        h[7] & 0xff,
      ];
      return isPublicUnicastIpv4Octets(octets);
    }

    // Must fall inside Global Unicast 2000::/3
    if ((h[0] & 0xe000) !== 0x2000) return false;

    // Reject special/transition/documentation prefixes inside 2000::/3
    if (h[0] === 0x2001 && h[1] === 0x0db8) return false; // 2001:db8::/32 Documentation
    if (h[0] === 0x2001 && h[1] === 0x0000) return false; // 2001::/32 Teredo
    if (h[0] === 0x2001 && h[1] === 0x0002 && h[2] === 0x0000) return false; // 2001:2::/48 Benchmarking
    if (h[0] === 0x2001 && (h[1] & 0xfff0) === 0x0010) return false; // 2001:10::/28 ORCHID
    if (h[0] === 0x2001 && (h[1] & 0xfff0) === 0x0020) return false; // 2001:20::/28 ORCHIDv2
    if (h[0] === 0x2002) return false; // 2002::/16 6to4 (can encapsulate private IPv4)

    return true;
  }

  return false;
}

/**
 * Checks if a valid IP address falls outside public unicast space.
 * Prefer isPublicUnicastIp() for fail-closed authorization checks.
 */
export function isPrivateIp(ip: string): boolean {
  const cleaned = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  if (!net.isIP(cleaned)) return false;
  return !isPublicUnicastIp(cleaned);
}

export interface ValidatedRemoteTarget {
  url: URL;
  resolvedIp: string;
  family: 4 | 6;
}

/**
 * Resolves and validates a remote URL against SSRF rules, returning the pinned public IP.
 */
export async function resolveAndValidateRemoteUrl(
  rawUrl: string,
  lookupFn: DnsLookupFn = defaultDnsLookup,
): Promise<ValidatedRemoteTarget> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('SSRF_INVALID_URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('SSRF_DISALLOWED_SCHEME');
  }

  const rawHost = parsed.hostname.toLowerCase();
  const hostname = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;

  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('SSRF_PRIVATE_IP');
  }

  const directFamily = net.isIP(hostname);
  if (directFamily === 4 || directFamily === 6) {
    if (!isPublicUnicastIp(hostname)) {
      throw new Error('SSRF_PRIVATE_IP');
    }
    return { url: parsed, resolvedIp: hostname, family: directFamily };
  }

  let records: DnsLookupRecord[];
  try {
    records = await lookupFn(hostname);
  } catch {
    throw new Error('SSRF_DNS_LOOKUP_FAILED');
  }

  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('SSRF_DNS_LOOKUP_FAILED');
  }

  for (const record of records) {
    if (!isPublicUnicastIp(record.address)) {
      throw new Error('SSRF_PRIVATE_IP');
    }
  }

  const primary = records[0];
  const primaryFamily = net.isIP(primary.address);
  if (primaryFamily !== 4 && primaryFamily !== 6) {
    throw new Error('SSRF_PRIVATE_IP');
  }

  return {
    url: parsed,
    resolvedIp: primary.address,
    family: primaryFamily,
  };
}

/**
 * Validates that a remote media locator URL uses an approved scheme and resolves
 * exclusively to public unicast IP addresses.
 */
export async function assertSafeRemoteUrl(
  rawUrl: string,
  lookupFn: DnsLookupFn = defaultDnsLookup,
): Promise<URL> {
  const validated = await resolveAndValidateRemoteUrl(rawUrl, lookupFn);
  return validated.url;
}
