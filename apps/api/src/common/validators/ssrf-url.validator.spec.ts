import {
  isPrivateIP,
  isCloudMetadataEndpoint,
  validateSsrfUrl,
  validateSsrfUrlAsync,
} from "./ssrf-url.validator";

describe("SSRF URL Validator", () => {
  describe("isPrivateIP", () => {
    describe("IPv4 private ranges", () => {
      // 10.0.0.0/8 - Class A private
      it("should block 10.x.x.x range", () => {
        expect(isPrivateIP("10.0.0.0")).toBe(true);
        expect(isPrivateIP("10.0.0.1")).toBe(true);
        expect(isPrivateIP("10.255.255.255")).toBe(true);
        expect(isPrivateIP("10.128.64.32")).toBe(true);
      });

      // 172.16.0.0/12 - Class B private
      it("should block 172.16-31.x.x range", () => {
        expect(isPrivateIP("172.16.0.0")).toBe(true);
        expect(isPrivateIP("172.16.0.1")).toBe(true);
        expect(isPrivateIP("172.31.255.255")).toBe(true);
        expect(isPrivateIP("172.20.10.5")).toBe(true);
      });

      it("should allow 172.x outside 16-31 range", () => {
        expect(isPrivateIP("172.15.0.1")).toBe(false);
        expect(isPrivateIP("172.32.0.1")).toBe(false);
      });

      // 192.168.0.0/16 - Class C private
      it("should block 192.168.x.x range", () => {
        expect(isPrivateIP("192.168.0.0")).toBe(true);
        expect(isPrivateIP("192.168.0.1")).toBe(true);
        expect(isPrivateIP("192.168.255.255")).toBe(true);
        expect(isPrivateIP("192.168.1.100")).toBe(true);
      });

      // 127.0.0.0/8 - Loopback
      it("should block 127.x.x.x loopback range", () => {
        expect(isPrivateIP("127.0.0.0")).toBe(true);
        expect(isPrivateIP("127.0.0.1")).toBe(true);
        expect(isPrivateIP("127.255.255.255")).toBe(true);
        expect(isPrivateIP("127.1.2.3")).toBe(true);
      });

      // 169.254.0.0/16 - Link-local
      it("should block 169.254.x.x link-local range", () => {
        expect(isPrivateIP("169.254.0.0")).toBe(true);
        expect(isPrivateIP("169.254.0.1")).toBe(true);
        expect(isPrivateIP("169.254.255.255")).toBe(true);
        expect(isPrivateIP("169.254.169.254")).toBe(true); // AWS metadata
      });

      // 0.0.0.0/8 - Current network
      it("should block 0.x.x.x range", () => {
        expect(isPrivateIP("0.0.0.0")).toBe(true);
        expect(isPrivateIP("0.0.0.1")).toBe(true);
        expect(isPrivateIP("0.255.255.255")).toBe(true);
      });

      // 100.64.0.0/10 - Carrier-grade NAT
      it("should block 100.64-127.x.x carrier-grade NAT range", () => {
        expect(isPrivateIP("100.64.0.0")).toBe(true);
        expect(isPrivateIP("100.64.0.1")).toBe(true);
        expect(isPrivateIP("100.127.255.255")).toBe(true);
        expect(isPrivateIP("100.100.100.100")).toBe(true);
      });

      it("should allow 100.x outside 64-127 range", () => {
        expect(isPrivateIP("100.63.0.1")).toBe(false);
        expect(isPrivateIP("100.128.0.1")).toBe(false);
      });

      // Multicast and reserved
      it("should block multicast range 224-239.x.x.x", () => {
        expect(isPrivateIP("224.0.0.0")).toBe(true);
        expect(isPrivateIP("239.255.255.255")).toBe(true);
      });

      it("should block reserved range 240+", () => {
        expect(isPrivateIP("240.0.0.0")).toBe(true);
        expect(isPrivateIP("255.255.255.254")).toBe(true);
        expect(isPrivateIP("255.255.255.255")).toBe(true);
      });
    });

    describe("IPv4 public addresses", () => {
      it("should allow valid public IPs", () => {
        expect(isPrivateIP("8.8.8.8")).toBe(false); // Google DNS
        expect(isPrivateIP("1.1.1.1")).toBe(false); // Cloudflare DNS
        expect(isPrivateIP("142.250.185.78")).toBe(false); // Google
        expect(isPrivateIP("151.101.1.140")).toBe(false); // Reddit
        expect(isPrivateIP("93.184.216.34")).toBe(false); // example.com
      });
    });

    describe("IPv6 addresses", () => {
      it("should block ::1 loopback", () => {
        expect(isPrivateIP("::1")).toBe(true);
        expect(isPrivateIP("0:0:0:0:0:0:0:1")).toBe(true);
      });

      it("should block :: unspecified", () => {
        expect(isPrivateIP("::")).toBe(true);
        expect(isPrivateIP("0:0:0:0:0:0:0:0")).toBe(true);
      });

      it("should block fe80::/10 link-local", () => {
        expect(isPrivateIP("fe80::1")).toBe(true);
        expect(isPrivateIP("fe80::")).toBe(true);
        expect(isPrivateIP("feb0::1")).toBe(true);
      });

      it("should block fc00::/7 unique local", () => {
        expect(isPrivateIP("fc00::1")).toBe(true);
        expect(isPrivateIP("fd00::1")).toBe(true);
        expect(isPrivateIP("fdff::1")).toBe(true);
      });

      it("should block ff00::/8 multicast", () => {
        expect(isPrivateIP("ff00::1")).toBe(true);
        expect(isPrivateIP("ff02::1")).toBe(true);
      });
    });

    describe("invalid IPs", () => {
      it("should treat invalid IPs as private for safety", () => {
        expect(isPrivateIP("256.1.1.1")).toBe(true);
        expect(isPrivateIP("1.2.3")).toBe(true);
        expect(isPrivateIP("not-an-ip")).toBe(true);
      });
    });
  });

  describe("isCloudMetadataEndpoint", () => {
    it("should block AWS metadata IP", () => {
      expect(isCloudMetadataEndpoint("169.254.169.254")).toBe(true);
    });

    it("should block GCP metadata hostname", () => {
      expect(isCloudMetadataEndpoint("metadata.google.internal")).toBe(true);
      expect(isCloudMetadataEndpoint("metadata.goog")).toBe(true);
    });

    it("should block generic metadata hostnames", () => {
      expect(isCloudMetadataEndpoint("metadata")).toBe(true);
      expect(isCloudMetadataEndpoint("instance-data")).toBe(true);
    });

    it("should block AWS ECS metadata", () => {
      expect(isCloudMetadataEndpoint("169.254.170.2")).toBe(true);
    });

    it("should block metadata paths", () => {
      expect(isCloudMetadataEndpoint("example.com", "/latest/meta-data")).toBe(true);
      expect(isCloudMetadataEndpoint("example.com", "/computeMetadata/v1")).toBe(true);
      expect(isCloudMetadataEndpoint("example.com", "/metadata/instance")).toBe(true);
    });

    it("should allow non-metadata hostnames", () => {
      expect(isCloudMetadataEndpoint("example.com")).toBe(false);
      expect(isCloudMetadataEndpoint("google.com")).toBe(false);
    });
  });

  describe("validateSsrfUrl", () => {
    describe("valid public URLs", () => {
      it("should allow valid HTTPS URLs", () => {
        expect(validateSsrfUrl("https://example.com")).toEqual({ valid: true });
        expect(validateSsrfUrl("https://google.com/search?q=test")).toEqual({ valid: true });
        expect(validateSsrfUrl("https://api.github.com/repos")).toEqual({ valid: true });
      });

      it("should allow valid HTTP URLs", () => {
        expect(validateSsrfUrl("http://example.com")).toEqual({ valid: true });
        expect(validateSsrfUrl("http://httpbin.org/get")).toEqual({ valid: true });
      });

      it("should allow URLs with ports", () => {
        expect(validateSsrfUrl("https://example.com:8080")).toEqual({ valid: true });
        expect(validateSsrfUrl("http://example.com:3000/api")).toEqual({ valid: true });
      });

      it("should allow URLs with public IPs", () => {
        expect(validateSsrfUrl("http://8.8.8.8")).toEqual({ valid: true });
        expect(validateSsrfUrl("https://1.1.1.1")).toEqual({ valid: true });
      });
    });

    describe("blocked protocols", () => {
      it("should block file:// protocol", () => {
        const result = validateSsrfUrl("file:///etc/passwd");
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Invalid protocol");
      });

      it("should block ftp:// protocol", () => {
        const result = validateSsrfUrl("ftp://ftp.example.com");
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Invalid protocol");
      });

      it("should block gopher:// protocol", () => {
        const result = validateSsrfUrl("gopher://example.com");
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Invalid protocol");
      });

      it("should block dict:// protocol", () => {
        const result = validateSsrfUrl("dict://example.com");
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Invalid protocol");
      });
    });

    describe("blocked private IPs", () => {
      it("should block 10.x.x.x range", () => {
        const result = validateSsrfUrl("http://10.0.0.1");
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Private/internal IP");
      });

      it("should block 172.16-31.x.x range", () => {
        const result = validateSsrfUrl("http://172.16.0.1");
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Private/internal IP");
      });

      it("should block 192.168.x.x range", () => {
        const result = validateSsrfUrl("http://192.168.1.1");
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Private/internal IP");
      });

      it("should block 127.x.x.x loopback", () => {
        const result = validateSsrfUrl("http://127.0.0.1");
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Localhost");
      });

      it("should block 169.254.x.x link-local", () => {
        const result = validateSsrfUrl("http://169.254.1.1");
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Private/internal IP");
      });
    });

    describe("blocked localhost variations", () => {
      it("should block localhost hostname", () => {
        const result = validateSsrfUrl("http://localhost");
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Localhost");
      });

      it("should block localhost with port", () => {
        const result = validateSsrfUrl("http://localhost:8080");
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Localhost");
      });

      it("should block localhost subdomains", () => {
        const result = validateSsrfUrl("http://api.localhost");
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Localhost");
      });

      it("should block .local domains", () => {
        const result = validateSsrfUrl("http://myserver.local");
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Localhost");
      });

      it("should block 0.0.0.0", () => {
        const result = validateSsrfUrl("http://0.0.0.0");
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Localhost");
      });
    });

    describe("blocked cloud metadata endpoints", () => {
      it("should block AWS metadata IP", () => {
        const result = validateSsrfUrl("http://169.254.169.254/latest/meta-data");
        expect(result.valid).toBe(false);
      });

      it("should block GCP metadata hostname", () => {
        const result = validateSsrfUrl("http://metadata.google.internal/computeMetadata/v1");
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Cloud metadata");
      });

      it("should block metadata hostname", () => {
        const result = validateSsrfUrl("http://metadata/latest/meta-data");
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Cloud metadata");
      });
    });

    describe("invalid URLs", () => {
      it("should reject malformed URLs", () => {
        const result = validateSsrfUrl("not-a-url");
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Invalid URL");
      });

      it("should reject URLs without protocol", () => {
        const result = validateSsrfUrl("example.com");
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Invalid URL");
      });

      it("should reject empty URLs", () => {
        const result = validateSsrfUrl("");
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Invalid URL");
      });
    });

    describe("bypass attempt prevention", () => {
      it("should block decimal IP representation of localhost", () => {
        // 127.0.0.1 = 2130706433 in decimal
        const result = validateSsrfUrl("http://2130706433");
        expect(result.valid).toBe(false);
      });

      it("should block IPv6 localhost", () => {
        const result = validateSsrfUrl("http://[::1]");
        expect(result.valid).toBe(false);
      });
    });
  });

  describe("validateSsrfUrlAsync", () => {
    it("should validate public URLs", async () => {
      const result = await validateSsrfUrlAsync("https://example.com");
      expect(result.valid).toBe(true);
    });

    it("should block private IPs", async () => {
      const result = await validateSsrfUrlAsync("http://192.168.1.1");
      expect(result.valid).toBe(false);
    });

    it("should block localhost", async () => {
      const result = await validateSsrfUrlAsync("http://localhost");
      expect(result.valid).toBe(false);
    });

    // Note: DNS resolution tests are harder to test reliably
    // In production, this would catch DNS rebinding attacks
  });
});
