import { URL } from "url";
import * as dns from "dns";
import { promisify } from "util";

const dnsLookup = promisify(dns.lookup);

/**
 * SSRF URL Validator
 * Validates URLs against internal network addresses and cloud metadata endpoints
 * to prevent Server-Side Request Forgery (SSRF) attacks.
 */

// Cloud metadata endpoints that should be blocked
const CLOUD_METADATA_HOSTS = [
  "169.254.169.254", // AWS, GCP, Azure metadata
  "metadata.google.internal", // GCP
  "metadata.goog", // GCP alternative
  "metadata", // Generic metadata hostname
  "instance-data", // AWS alternative
  "169.254.170.2", // AWS ECS task metadata
  "fd00:ec2::254", // AWS IPv6 metadata
];

// Cloud metadata paths that indicate metadata access attempts
const CLOUD_METADATA_PATHS = [
  "/latest/meta-data",
  "/latest/user-data",
  "/latest/dynamic",
  "/computeMetadata",
  "/metadata/instance",
  "/metadata/v1",
  "/openstack",
  "/opc/v1",
  "/opc/v2",
];

export interface SsrfValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Check if an IP address is in a private/internal range
 * Covers RFC 1918, loopback, link-local, and other reserved ranges
 */
export function isPrivateIP(ip: string): boolean {
  // Handle IPv6
  if (ip.includes(":")) {
    return isPrivateIPv6(ip);
  }

  // Handle IPv4
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // Invalid IP, treat as private for safety
  }

  const [a, b, c, d] = parts;

  // 0.0.0.0/8 - Current network
  if (a === 0) return true;

  // 10.0.0.0/8 - Private network (RFC 1918)
  if (a === 10) return true;

  // 100.64.0.0/10 - Carrier-grade NAT (RFC 6598)
  if (a === 100 && b >= 64 && b <= 127) return true;

  // 127.0.0.0/8 - Loopback
  if (a === 127) return true;

  // 169.254.0.0/16 - Link-local
  if (a === 169 && b === 254) return true;

  // 172.16.0.0/12 - Private network (RFC 1918)
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.0.0.0/24 - IETF Protocol Assignments
  if (a === 192 && b === 0 && c === 0) return true;

  // 192.0.2.0/24 - TEST-NET-1
  if (a === 192 && b === 0 && c === 2) return true;

  // 192.88.99.0/24 - 6to4 Relay Anycast
  if (a === 192 && b === 88 && c === 99) return true;

  // 192.168.0.0/16 - Private network (RFC 1918)
  if (a === 192 && b === 168) return true;

  // 198.18.0.0/15 - Benchmark testing
  if (a === 198 && (b === 18 || b === 19)) return true;

  // 198.51.100.0/24 - TEST-NET-2
  if (a === 198 && b === 51 && c === 100) return true;

  // 203.0.113.0/24 - TEST-NET-3
  if (a === 203 && b === 0 && c === 113) return true;

  // 224.0.0.0/4 - Multicast
  if (a >= 224 && a <= 239) return true;

  // 240.0.0.0/4 - Reserved for future use
  if (a >= 240) return true;

  // 255.255.255.255 - Broadcast
  if (a === 255 && b === 255 && c === 255 && d === 255) return true;

  return false;
}

/**
 * Check if an IPv6 address is in a private/internal range
 */
function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // ::1 - Loopback
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;

  // :: - Unspecified
  if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return true;

  // fe80::/10 - Link-local
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;

  // fc00::/7 - Unique local address (ULA)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;

  // ff00::/8 - Multicast
  if (normalized.startsWith("ff")) return true;

  // ::ffff:0:0/96 - IPv4-mapped IPv6 addresses
  if (normalized.startsWith("::ffff:")) {
    const ipv4Part = normalized.slice(7);
    // Check if the IPv4 part is private
    if (ipv4Part.includes(".")) {
      return isPrivateIP(ipv4Part);
    }
  }

  // 64:ff9b::/96 - IPv4/IPv6 translation
  if (normalized.startsWith("64:ff9b:")) return true;

  // 100::/64 - Discard prefix
  if (normalized.startsWith("100:")) return true;

  // 2001:db8::/32 - Documentation
  if (normalized.startsWith("2001:db8:")) return true;

  // 2001::/32 - Teredo tunneling
  if (normalized.startsWith("2001:") && !normalized.startsWith("2001:db8:")) {
    const secondPart = normalized.split(":")[1];
    if (secondPart === "" || secondPart === "0") return true;
  }

  return false;
}

/**
 * Check if a hostname is a cloud metadata endpoint
 */
export function isCloudMetadataEndpoint(hostname: string, path?: string): boolean {
  const normalizedHost = hostname.toLowerCase();

  // Check against known metadata hostnames
  if (CLOUD_METADATA_HOSTS.some((h) => normalizedHost === h.toLowerCase())) {
    return true;
  }

  // Check for metadata-related hostnames
  if (normalizedHost.includes("metadata") || normalizedHost.includes("instance-data")) {
    return true;
  }

  // Check path for metadata access patterns
  if (path) {
    const normalizedPath = path.toLowerCase();
    if (CLOUD_METADATA_PATHS.some((p) => normalizedPath.startsWith(p.toLowerCase()))) {
      return true;
    }
  }

  return false;
}

/**
 * Validate a URL against SSRF attacks (synchronous hostname check only)
 * For full validation including DNS resolution, use validateSsrfUrlAsync
 */
export function validateSsrfUrl(urlString: string): SsrfValidationResult {
  try {
    const url = new URL(urlString);

    // Only allow http and https protocols
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return {
        valid: false,
        reason: `Invalid protocol: ${url.protocol}. Only http and https are allowed.`,
      };
    }

    const hostname = url.hostname.toLowerCase();

    // Check for empty hostname
    if (!hostname) {
      return {
        valid: false,
        reason: "Empty hostname is not allowed.",
      };
    }

    // Check if hostname is an IP address
    if (isIPAddress(hostname)) {
      // Remove brackets from IPv6
      const cleanIP = hostname.replace(/^\[|\]$/g, "");
      if (isPrivateIP(cleanIP)) {
        return {
          valid: false,
          reason: `Private/internal IP address is not allowed: ${hostname}`,
        };
      }
    }

    // Check for cloud metadata endpoints
    if (isCloudMetadataEndpoint(hostname, url.pathname)) {
      return {
        valid: false,
        reason: `Cloud metadata endpoint is not allowed: ${hostname}`,
      };
    }

    // Check for localhost variations
    if (isLocalhostVariation(hostname)) {
      return {
        valid: false,
        reason: `Localhost is not allowed: ${hostname}`,
      };
    }

    // Check for URL-encoded bypass attempts
    const decodedHostname = decodeURIComponent(hostname);
    if (decodedHostname !== hostname) {
      if (isIPAddress(decodedHostname)) {
        const cleanIP = decodedHostname.replace(/^\[|\]$/g, "");
        if (isPrivateIP(cleanIP)) {
          return {
            valid: false,
            reason: `URL-encoded private IP address is not allowed: ${hostname}`,
          };
        }
      }
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      reason: `Invalid URL: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

/**
 * Validate a URL against SSRF attacks with DNS resolution
 * This catches DNS rebinding attacks where a hostname resolves to a private IP
 */
export async function validateSsrfUrlAsync(urlString: string): Promise<SsrfValidationResult> {
  // First, perform synchronous validation
  const syncResult = validateSsrfUrl(urlString);
  if (!syncResult.valid) {
    return syncResult;
  }

  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();

    // Skip DNS resolution for IP addresses (already validated)
    if (isIPAddress(hostname)) {
      return { valid: true };
    }

    // Resolve hostname to IP and validate
    try {
      const result = await dnsLookup(hostname, { all: true });
      const addresses = Array.isArray(result) ? result : [result];

      for (const addr of addresses) {
        const ip = typeof addr === "string" ? addr : addr.address;
        if (isPrivateIP(ip)) {
          return {
            valid: false,
            reason: `Hostname ${hostname} resolves to private IP: ${ip}`,
          };
        }
      }
    } catch (dnsError) {
      // DNS resolution failed - could be a non-existent domain
      // We allow this as the request will fail anyway
      return { valid: true };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      reason: `URL validation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

/**
 * Check if a string is an IP address (IPv4 or IPv6)
 */
function isIPAddress(hostname: string): boolean {
  // IPv6 in brackets
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return true;
  }

  // IPv4 pattern
  const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4Pattern.test(hostname)) {
    return true;
  }

  // IPv6 pattern (simplified check)
  if (hostname.includes(":") && !hostname.includes(".")) {
    return true;
  }

  return false;
}

/**
 * Check for localhost variations
 */
function isLocalhostVariation(hostname: string): boolean {
  const localhostPatterns = [
    "localhost",
    "localhost.localdomain",
    "local",
    "127.0.0.1",
    "::1",
    "[::1]",
    "0.0.0.0",
    "0",
  ];

  const normalized = hostname.toLowerCase();

  // Direct match
  if (localhostPatterns.includes(normalized)) {
    return true;
  }

  // Check for localhost subdomains
  if (normalized.endsWith(".localhost") || normalized.endsWith(".local")) {
    return true;
  }

  // Check for decimal/octal/hex IP representations of 127.0.0.1
  // Decimal: 2130706433
  // Octal: 0177.0.0.1, 0x7f.0.0.1
  if (/^0x7f/i.test(normalized) || /^0177\./.test(normalized)) {
    return true;
  }

  // Check for decimal representation
  if (/^\d+$/.test(normalized)) {
    const num = parseInt(normalized, 10);
    // 127.0.0.1 = 2130706433
    // 127.255.255.255 = 2147483647
    if (num >= 2130706433 && num <= 2147483647) {
      return true;
    }
    // 0.0.0.0 = 0
    if (num === 0) {
      return true;
    }
  }

  return false;
}
