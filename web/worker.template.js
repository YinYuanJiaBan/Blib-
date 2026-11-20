// Cloudflare Worker: отдаёт страницу «Книга в EPUB» и загружает для неё
// страницы kanunu8.com (сам сайт не разрешает запросы из чужих страниц).
// Файл worker.js собирается командой: python3 build.py

const ALLOWED_HOSTS = ["kanunu8.com", "www.kanunu8.com"];
const PAGE = __PAGE__;

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/fetch") {
      let target;
      try {
        target = new URL(url.searchParams.get("url") || "");
      } catch {
        return new Response("Некорректная ссылка", { status: 400 });
      }
      if (!/^https?:$/.test(target.protocol) || !ALLOWED_HOSTS.includes(target.hostname)) {
        return new Response("Поддерживается только kanunu8.com", { status: 400 });
      }
      const upstream = await fetch(target.href, {
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          "accept-language": "zh-CN,zh;q=0.9"
        },
        cf: { cacheTtl: 86400, cacheEverything: true }
      });
      if (!upstream.ok) {
        return new Response(`Сайт ответил ошибкой ${upstream.status}`, { status: 502 });
      }
      return new Response(upstream.body, {
        headers: {
          "content-type": upstream.headers.get("content-type") || "text/html",
          "cache-control": "public, max-age=86400"
        }
      });
    }

    return new Response("Not found", { status: 404 });
  }
};
