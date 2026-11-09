import { describe, expect, it } from "vitest";
import { isTunnelHost } from "./host";

describe("isTunnelHost", () => {
  it("*.trycloudflare.com 是對外模式", () => {
    expect(isTunnelHost("quiet-river-1234.trycloudflare.com")).toBe(true);
    expect(isTunnelHost("A-B.TryCloudflare.com")).toBe(true);
  });

  it("本機開發與其他網域都不是", () => {
    for (const h of ["localhost", "127.0.0.1", "[::1]", "trycloudflare.com", "evil-trycloudflare.com",
      "x.trycloudflare.com.evil.example", "example.org", ""]) {
      expect(isTunnelHost(h), h).toBe(false);
    }
  });
});
