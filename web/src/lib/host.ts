/**
 * 對外模式：經 Cloudflare Tunnel（*.trycloudflare.com）開放的開發／預覽伺服器。
 * 只有這時前面有登入閘道（auth-plugin.ts），才有 /__logout；本機開發時沒有。
 */
export function isTunnelHost(hostname: string): boolean {
  return hostname.toLowerCase().endsWith(".trycloudflare.com");
}
