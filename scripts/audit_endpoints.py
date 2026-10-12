"""Read-only health audit for all configured JobUI scrapers and studio logos.

Usage: python3 scripts/audit_endpoints.py [config.json]
Produces JSON lines with status and TLS diagnosis; never modifies remote data.
"""
import concurrent.futures
import json
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

CONFIG = sys.argv[1] if len(sys.argv) > 1 else "JobUI/studios.json"


def probe(studio, kind, url):
    scraping = studio.get("scraping") or {}
    headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/121 Safari/537.36"}
    if kind == "scraper":
        headers.update(scraping.get("headers") or {})
        params = scraping.get("params") or {}
        if params:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params, doseq=True)
    else:
        headers["Accept"] = "image/png,image/jpeg,image/webp,image/svg+xml,image/*;q=0.8"
    method = (scraping.get("method") or "GET") if kind == "scraper" else "GET"
    payload = scraping.get("form_data") or scraping.get("payload")
    body = None
    if method.upper() == "POST" and payload:
        if scraping.get("form_data"):
            body = urllib.parse.urlencode(payload).encode()
            headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
        else:
            body = json.dumps(payload).encode()
            headers.setdefault("Content-Type", "application/json")
    result = {"id": studio["id"], "kind": kind, "url": url, "strategy": scraping.get("strategy")}
    for unverified in (False, True):
        try:
            req = urllib.request.Request(url, data=body, headers=headers, method=method.upper())
            context = ssl._create_unverified_context() if unverified else ssl.create_default_context()
            with urllib.request.urlopen(req, timeout=12, context=context) as response:
                content = response.read(32768)
                result.update(status=response.status, bytes_sample=len(content), content_type=response.headers.get("Content-Type", ""))
                if kind == "logo":
                    result["image_signature"] = content[:12].hex()
                if unverified:
                    result["tls"] = "certificate-failed"
                else:
                    result["tls"] = "ok"
                break
        except Exception as exc:
            result["error"] = f"{type(exc).__name__}: {str(exc)[:180]}"
            if not unverified or not isinstance(exc, (ssl.SSLError, urllib.error.URLError)) or "CERTIFICATE_VERIFY_FAILED" not in str(exc):
                break
    return result


def main():
    with open(CONFIG, encoding="utf-8") as source:
        studios = json.load(source)
    tasks = []
    for studio in studios:
        careers = studio.get("careers_url") or []
        if isinstance(careers, str):
            careers = [careers]
        for url in careers:
            tasks.append((studio, "scraper", url))
        if studio.get("logo_url"):
            tasks.append((studio, "logo", studio["logo_url"]))
    with concurrent.futures.ThreadPoolExecutor(max_workers=14) as pool:
        futures = [pool.submit(probe, *task) for task in tasks]
        for future in concurrent.futures.as_completed(futures):
            print(json.dumps(future.result(), ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
