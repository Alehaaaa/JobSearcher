"""Run every studio through the Python/main reference scraper (read-only).

Requires requests and beautifulsoup4 plus a checkout/export of main's core package.
Usage: PYTHONPATH=/tmp/jobui-python-deps:/tmp/jobui-python-reference python3 scripts/audit_python_scrapers.py
"""
import concurrent.futures
import json
import sys
import time
import os
import types

# Bypass the Qt desktop package initializer; scraping itself has no Qt dependency.
package = types.ModuleType("core")
package.__path__ = [os.path.join(os.environ.get("JOBUI_PYTHON_REFERENCE", "/tmp/jobui-python-reference"), "core")]
sys.modules["core"] = package
from core.job_scraper import JobScraper


def test_studio(studio):
    scraper = JobScraper()
    original = scraper.session.request

    def limited_request(method, url, **kwargs):
        kwargs.setdefault("timeout", 12)
        return original(method, url, **kwargs)

    scraper.session.request = limited_request
    start = time.monotonic()
    try:
        jobs = scraper.fetch_jobs(studio)
        return {"id": studio["id"], "strategy": studio.get("scraping", {}).get("strategy"),
                "count": len(jobs), "sample": [j["title"] for j in jobs[:3]],
                "locations": [{"title": j["title"], "location": j.get("location", "")} for j in jobs[:8]],
                "jobs": [{"title": j.get("title", ""), "location": j.get("location", ""),
                          "link": j.get("link", ""), "extra_link": j.get("extra_link", "")}
                         for j in jobs],
                "seconds": round(time.monotonic() - start, 2)}
    except Exception as error:
        return {"id": studio["id"], "error": f"{type(error).__name__}: {error}",
                "seconds": round(time.monotonic() - start, 2)}


if __name__ == "__main__":
    with open(sys.argv[1] if len(sys.argv) > 1 else "JobUI/studios.json", encoding="utf-8") as source:
        studios = json.load(source)
    with concurrent.futures.ThreadPoolExecutor(max_workers=9) as executor:
        futures = [executor.submit(test_studio, studio) for studio in studios]
        for future in concurrent.futures.as_completed(futures):
            print("AUDIT_JSON " + json.dumps(future.result(), ensure_ascii=False), flush=True)
