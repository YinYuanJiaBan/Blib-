#!/usr/bin/env python3
"""
Для автодеплоя: находит (или создаёт) KV-хранилище библиотеки бота в Cloudflare
и дописывает его привязку BOOKS в bot/wrangler.toml.

Нужны CLOUDFLARE_API_TOKEN (шаблон «Edit Cloudflare Workers» уже даёт доступ к KV)
и CLOUDFLARE_ACCOUNT_ID. Если доступа нет, бот деплоится без библиотеки.
"""
import json
import os
import sys
import urllib.request

TITLE = "book-bot-library"
TOML = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wrangler.toml")


def api(method, path, body=None):
    acc = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{acc}/storage/kv/namespaces{path}",
        data=json.dumps(body).encode() if body is not None else None, method=method,
        headers={"Authorization": f"Bearer {os.environ['CLOUDFLARE_API_TOKEN']}",
                 "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["result"]


def main():
    ns_id, page = None, 1
    while not ns_id:
        items = api("GET", f"?per_page=100&page={page}")
        ns_id = next((n["id"] for n in items if n.get("title") == TITLE), None)
        if len(items) < 100:
            break
        page += 1
    if not ns_id:
        ns_id = api("POST", "", {"title": TITLE})["id"]
        print(f"Создано KV-хранилище {TITLE}")
    with open(TOML, "a", encoding="utf-8") as f:
        f.write(f'\n[[kv_namespaces]]\nbinding = "BOOKS"\nid = "{ns_id}"\n')
    print("Библиотека подключена (BOOKS)")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"::warning::Библиотека книг не подключена: нет доступа к Workers KV ({getattr(e, 'code', '')} {e})")
        sys.exit(0)
