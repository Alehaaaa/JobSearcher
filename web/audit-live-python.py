#!/usr/bin/env python3
"""One-studio isolated probe for web/audit-live.mjs.

Imports the Python scraper extracted verbatim from a requested Git ref. All
external requests are performed by the original implementation, so its error
handling and extraction behavior are included in the comparison.
"""

import contextlib
import io
import json
import sys
import traceback


def main():
    sys.path.insert(0, sys.argv[1])
    studio = json.loads(sys.stdin.read())
    from core.job_scraper import JobScraper

    diagnostics = io.StringIO()
    with contextlib.redirect_stdout(diagnostics):
        jobs = JobScraper().fetch_jobs(studio)
    print("AUDIT_JSON:" + json.dumps({
        "ok": True,
        "jobs": [
            {
                "title": str(j.get("title") or ""),
                "link": str(j.get("link") or ""),
                "location": str(j.get("location") or ""),
                "extraLink": str(j.get("extra_link") or ""),
            }
            for j in jobs
        ],
        "warnings": [line for line in diagnostics.getvalue().splitlines() if line.strip()],
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("AUDIT_JSON:" + json.dumps({
            "ok": False,
            "error": f"{type(error).__name__}: {error}",
            "traceback": traceback.format_exc(limit=5),
        }, ensure_ascii=False))
        sys.exit(1)
