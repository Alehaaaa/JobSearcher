import requests
from bs4 import BeautifulSoup
import urllib.parse
import ssl
import re
from .logger import logger
from .extractor import extract_json, extract_html, extract_items_html
import urllib3

import html
import json
from concurrent.futures import ThreadPoolExecutor, as_completed

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
ssl._create_default_https_context = ssl._create_unverified_context


class JobScraper:
    def __init__(self):
        self.session = requests.Session()
        self.session.verify = False
        self.session.headers.update(
            {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36"
            }
        )

    def fetch_jobs(self, studio):
        """Main entry point for fetching jobs for a studio."""
        scraping = studio.get("scraping", {})
        strategy = scraping.get("strategy")
        careers_urls = studio.get("careers_url")

        if not isinstance(careers_urls, list):
            careers_urls = [careers_urls]

        all_jobs = []
        seen_links = set()

        for url in careers_urls:
            if not url:
                continue

            studio_for_url = studio.copy()
            studio_for_url["careers_url"] = url

            try:
                if strategy == "json":
                    jobs = self.fetch_json(studio_for_url)
                elif strategy == "html":
                    jobs = self.fetch_html(studio_for_url)
                elif strategy == "json_text":
                    jobs = self.fetch_json_text(studio_for_url)
                elif strategy == "remix":
                    jobs = self.fetch_remix(studio_for_url)
                elif strategy == "static":
                    jobs = []
                elif strategy == "rss":
                    jobs = self.fetch_rss(studio_for_url)
                else:
                    logger.warning(f"No valid strategy for {studio.get('id')}: {strategy}")
                    continue
            except Exception as e:
                logger.error(f"Error fetching jobs from {url}: {e}")
                continue

            for job in jobs:
                title = job.get("title", "").strip()
                link = job.get("link", "").strip()

                # Normalize title and link for reliable matching
                t_key = title.lower()
                l_key = ""
                if link:
                    # Strip common tracking params and normalize
                    l_key = re.sub(r"[?&](utm_|portal|ref|source|jobid)=[^&]*", "", link).rstrip("?&").lower()

                # Per-studio deduplication: we skip if we've seen this exact title+link combo
                dup_key = (t_key, l_key)
                if dup_key in seen_links:
                    continue

                all_jobs.append(job)
                seen_links.add(dup_key)

        detail_page = scraping.get("detail_page")
        if detail_page and all_jobs:
            all_jobs = self._enrich_from_detail_pages(all_jobs, detail_page)

        return all_jobs

    def _enrich_from_detail_pages(self, jobs, config):
        """Fill selected job fields from their linked detail pages in parallel."""
        mapping = config.get("map", {})
        if not mapping:
            return jobs

        def enrich(job):
            link = job.get("link")
            if not link:
                return job

            try:
                response = requests.get(
                    link,
                    headers={**self.session.headers, **config.get("headers", {})},
                    timeout=config.get("timeout", 10),
                    verify=False,
                )
                response.raise_for_status()
                soup = BeautifulSoup(response.text, "html.parser")

                for field, field_config in mapping.items():
                    if isinstance(field_config, str):
                        selector, attr = field_config, "text"
                    else:
                        selector = field_config.get("selector")
                        attr = field_config.get("attr", "text")
                    if not selector:
                        continue

                    value = extract_html(
                        soup,
                        selector,
                        attr=attr,
                        index=field_config.get("index") if isinstance(field_config, dict) else None,
                        default="",
                    )
                    value = self._apply_mapping_logic(str(value or ""), field_config)
                    value = self._clean_text(value)
                    if value:
                        job[field] = value
            except Exception as e:
                logger.warning(f"Could not enrich job detail {link}: {e}")
            return job

        max_workers = min(config.get("max_workers", 6), len(jobs))
        enriched = [None] * len(jobs)
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(enrich, job.copy()): index for index, job in enumerate(jobs)}
            for future in as_completed(futures):
                enriched[futures[future]] = future.result()
        return enriched

    def _handle_pre_visit(self, config):
        """Visits a URL to set cookies and optionally extracts CSRF token."""
        url = config.get("url")
        if url:
            try:
                self.session.get(url)
            except Exception as e:
                logger.error(f"Pre-visit failed for {url}: {e}")

        csrf = config.get("csrf")
        if csrf:
            cookie_name = csrf.get("cookie")
            header_name = csrf.get("header")
            if cookie_name and header_name:
                cookie_val = self.session.cookies.get(cookie_name)
                if cookie_val:
                    if csrf.get("unescape"):
                        cookie_val = urllib.parse.unquote(cookie_val)

                    if csrf.get("split"):
                        cookie_val = cookie_val.split(csrf["split"])[0]

                    self.session.headers.update({header_name: cookie_val})

    def _apply_mapping_logic(self, val, m):
        """Centralized logic for split, regex, prefix, and suffix."""
        if not isinstance(m, dict):
            return str(val or "")

        if isinstance(val, list):
            val = m.get("join", ", ").join(str(item) for item in val if item not in (None, ""))
        elif val is not None and not isinstance(val, str):
            val = str(val)

        # If mapping only contains "default", return it immediately
        if set(m.keys()) == {"default"}:
            return m["default"]

        if not val:
            # Return default if no value provided
            return m.get("default", "")

        # 1. Split
        split_cfg = m.get("split")
        if split_cfg:
            sep = split_cfg.get("sep", ":")
            idx = split_cfg.get("index", 0)
            parts = val.split(sep)
            val = parts[idx].strip() if 0 <= idx < len(parts) else ""

        # 2. Regex
        regex = m.get("regex")
        if regex and val:
            match = re.search(regex, val)
            if match:
                val = match.group(1) if match.groups() else match.group(0)
            else:
                val = ""

        # 3. Lightweight transforms for feeds that expose slugs instead of titles.
        replace_cfg = m.get("replace")
        if replace_cfg and val:
            replacements = replace_cfg if isinstance(replace_cfg, list) else [replace_cfg]
            for replacement in replacements:
                if isinstance(replacement, dict):
                    val = val.replace(replacement.get("old", ""), replacement.get("new", ""))

        if m.get("title_case") and val:
            val = val.title()

        # 4. Prefix/Suffix
        prefix = m.get("prefix", "")
        suffix = m.get("suffix", "")
        if val:
            val = f"{prefix}{val}{suffix}"

        # 5. Default if empty
        if not val and "default" in m:
            val = m["default"]

        return val

    def _finalize_job(self, title, link, location, extra_link, studio, careers_url, mapping):
        """Common cleanup and normalization for all scraping strategies."""
        title = self._clean_text(title)
        location = self._clean_text(location)

        if mapping.get("remove_location_from_title") and location:
            title = self._remove_location_from_title(title, location)
            title = self._clean_text(title)

        if not title or title.lower() in ["view job", "details", "read more", "apply", "careers", "unknown"]:
            return None

        if not link:
            link = careers_url
        elif not str(link).startswith("http"):
            base = studio.get("website") or careers_url
            link = urllib.parse.urljoin(base, str(link))

        if extra_link and not str(extra_link).startswith("http"):
            base = studio.get("website") or careers_url
            extra_link = urllib.parse.urljoin(base, str(extra_link))

        return {"title": title, "link": link, "location": location, "extra_link": extra_link}

    def _remove_location_from_title(self, title, location):
        """Removes the location from the title and cleans up orphaned separators like ' - - '."""
        if not title or not location:
            return title

        # 1. Basic removal of the full location string
        title = re.sub(re.escape(location), "", title, flags=re.I).strip()

        # 2. If it's a comma-separated location (like 'London, UK'), remove components
        if "," in location:
            for p in location.split(","):
                p_strip = p.strip()
                if p_strip:
                    title = re.sub(r"\b" + re.escape(p_strip) + r"\b", "", title, flags=re.I).strip()

        # 3. Collapse multiple separators (e.g. ' -  - ' -> ' - ')
        # This handles symbols like -, |, /, \, ·, •
        title = re.sub(r"\s*([ \-\|/\\·•])\s*([ \-\|/\\·•]\s*)+", r" \1 ", title)

        # 4. Remove empty brackets left behind
        title = re.sub(r"\(\s*\)|\[\s*\]|\{\s*\}", "", title).strip()

        # 5. Final cleanup from ends is handled by _clean_text later
        return title.strip()

    def _clean_text(self, text):
        """Cleans common HTML noise from extracted text."""
        if not text:
            return ""
        # Remove HTML tags if present
        if "<" in text and ">" in text:
            text = BeautifulSoup(text, "html.parser").get_text(strip=True)
        # Normalize whitespace
        text = " ".join(text.split())
        return text.strip("·•| -:").strip()

    def fetch_json(self, studio):
        careers_url = studio.get("careers_url")
        scraping = studio.get("scraping", {})

        # Pre-visit logic
        pre_visit = scraping.get("pre_visit")
        if pre_visit:
            self._handle_pre_visit(pre_visit)

        # Request
        method = scraping.get("method", "GET").upper()
        params = scraping.get("params", {})
        payload = scraping.get("payload")
        headers = scraping.get("headers", {})

        if method == "POST":
            form_data = scraping.get("form_data")
            response = self.session.post(
                careers_url,
                data=form_data if form_data else None,
                json=payload if not form_data else None,
                params=params,
                headers={**self.session.headers, **headers},
            )
        else:
            response = self.session.get(careers_url, params=params, headers=headers)

        response.raise_for_status()
        data = response.json()

        items = extract_json(data, scraping.get("path", ""), default=[])
        if not items:
            return []
        if not isinstance(items, list):
            items = [items]

        return self._parse_json_items(items, studio, careers_url)

    def _parse_json_items(self, items, studio, careers_url):
        scraping = studio.get("scraping", {})
        mapping = scraping.get("map", {})

        # Filter
        filter_cfg = scraping.get("filter")
        if filter_cfg:
            key, sw = filter_cfg.get("key"), filter_cfg.get("startswith")
            if key and sw:
                items = [it for it in items if str(extract_json(it, key, "")).startswith(sw)]

        jobs = []
        for item in items:

            def get_val(field_key):
                m = mapping.get(field_key)
                if not m:
                    return ""
                if isinstance(m, dict) and m.get("source") == "url":
                    val = careers_url
                else:
                    path = m.get("path") if isinstance(m, dict) else m
                    val = extract_json(item, path, "") or ""
                return self._apply_mapping_logic(val, m)

            job = self._finalize_job(
                title=get_val("title"),
                link=get_val("link"),
                location=get_val("location"),
                extra_link=get_val("extra_link"),
                studio=studio,
                careers_url=careers_url,
                mapping=mapping,
            )
            if job:
                jobs.append(job)

        return jobs

    def fetch_remix(self, studio):
        """Fetch and decode Remix `.data` responses serialized with devalue."""
        careers_url = studio.get("careers_url")
        scraping = studio.get("scraping", {})
        response = self.session.get(
            careers_url,
            params=scraping.get("params", {}),
            headers=scraping.get("headers", {}),
        )
        response.raise_for_status()
        data = self._decode_devalue(response.json())
        items = extract_json(data, scraping.get("path", ""), default=[])
        if not items:
            return []
        if not isinstance(items, list):
            items = [items]
        return self._parse_json_items(items, studio, careers_url)

    def _decode_devalue(self, values):
        """Expand the reference table used by Remix/devalue JSON responses."""
        if not isinstance(values, list):
            return values

        cache = {}
        special_values = {
            -1: None,  # undefined
            -2: None,  # sparse-array hole
            -3: float("nan"),
            -4: float("inf"),
            -5: float("-inf"),
            -6: -0.0,
        }

        def decode(reference):
            if isinstance(reference, bool) or not isinstance(reference, int):
                return reference
            if reference < 0:
                return special_values.get(reference)
            if reference in cache:
                return cache[reference]

            value = values[reference]
            if isinstance(value, dict):
                decoded = {}
                cache[reference] = decoded
                for key_reference, child_reference in value.items():
                    key = decode(int(key_reference.lstrip("_")))
                    decoded[str(key)] = decode(child_reference)
                return decoded
            if isinstance(value, list):
                decoded = []
                cache[reference] = decoded
                decoded.extend(decode(child_reference) for child_reference in value)
                return decoded
            return value

        return decode(0)

    def fetch_json_text(self, studio):
        careers_url = studio.get("careers_url")
        scraping = studio.get("scraping", {})

        method = scraping.get("method", "GET").upper()
        params, payload, headers = scraping.get("params", {}), scraping.get("payload"), scraping.get("headers", {})

        if method == "POST":
            response = self.session.post(careers_url, json=payload, params=params, headers=headers)
        else:
            response = self.session.get(careers_url, params=params, headers=headers)
        response.raise_for_status()

        if scraping.get("encoding"):
            response.encoding = scraping["encoding"]

        jt_cfg = scraping.get("json_text", {})
        json_regex = jt_cfg.get("regex")
        json_var = jt_cfg.get("variable")

        if json_regex:
            regex = json_regex
        elif json_var:
            # Supports: var x = [...], const x = [...], let x = [...], window.x = [...]
            regex = (
                r"(?:const|var|let|window\.)\s*"
                + re.escape(json_var)
                + r"\s*=\s*(\[.*?\])\s*(?:;|\n|<\/script>)"
            )
        else:
            regex = r"(?:const|var|let|window\.)\s*jobsData\s*=\s*(\[.*?\])\s*(?:;|\n|<\/script>)"

        # Use re.DOTALL to match across lines
        soup = BeautifulSoup(response.text, "html.parser")
        text = ""

        # 1. Search in scripts matching container or all script tags
        container_sel = scraping.get("container", "script")
        for s in soup.select(container_sel):
            contents = s.get_text()
            if re.search(regex, contents, re.DOTALL):
                text = contents
                break

        # 2. Fallback: Search all HTML if not found in scripts
        if not text:
            if re.search(regex, response.text, re.DOTALL):
                text = response.text

        if not text:
            logger.error(f"Could not find JSON text matching {regex}")
            return []

        match = re.search(regex, text, re.DOTALL)
        if not match:
            return []

        try:
            json_str = match.group(1).strip()
            if jt_cfg.get("unescape"):
                json_str = html.unescape(json_str)

            data = json.loads(json_str)
            items = extract_json(data, scraping.get("path", ""), default=[])
            if not isinstance(items, list):
                items = [items]

            return self._parse_json_items(items, studio, careers_url)
        except Exception as e:
            logger.error(f"Error parsing JSON: {e}")
            return []

    def fetch_html(self, studio):
        careers_url = studio.get("careers_url")
        scraping = studio.get("scraping", {})
        mapping = scraping.get("map", {})

        method = scraping.get("method", "GET").upper()
        params, payload, headers = (
            scraping.get("params", {}),
            scraping.get("payload"),
            scraping.get("headers", {}),
        )
        form_data = scraping.get("form_data")

        if method == "POST":
            # Support both JSON payload and form_data
            if form_data:
                response = self.session.post(careers_url, data=form_data, params=params, headers=headers)
            else:
                response = self.session.post(careers_url, json=payload, params=params, headers=headers)
        else:
            response = self.session.get(careers_url, params=params, headers=headers)

        response.raise_for_status()

        # Handle JSON response with HTML field (e.g. Hireify)
        html_content = response.text
        json_html_field = scraping.get("json_html_field")
        if json_html_field:
            try:
                data = response.json()
                html_content = extract_json(data, json_html_field, response.text)
            except Exception:
                pass

        soup = BeautifulSoup(html_content, "html.parser")

        container_sel = scraping.get("container")
        if not container_sel:
            return []

        # Items Extraction
        split_cfg = scraping.get("split_items")
        if split_cfg:
            container = soup.select_one(container_sel)
            if not container:
                return []
            text = str(container) if split_cfg.get("use_html") else container.get_text("\n")
            delim = split_cfg.get("delimiter", "<br>")
            items = [BeautifulSoup(p.strip(), "html.parser") for p in text.split(delim) if p.strip()]
        else:
            items = extract_items_html(soup, container_sel)

        jobs = []
        for item in items:

            def get_val(field_key, def_attr="text"):
                m = mapping.get(field_key)
                if m is None:
                    return ""
                if isinstance(m, dict) and m.get("source") == "url":
                    val = careers_url
                elif isinstance(m, dict) and "find_previous" in m:
                    node = item.find_previous(m["find_previous"])
                    return node.get_text(separator=" ", strip=True) if node else ""
                elif isinstance(m, dict) and "find_next_sibling" in m:
                    # Find next sibling matching the selector
                    sibling_sel = m["find_next_sibling"]
                    node = None

                    # Iterate through next siblings to find one matching the selector
                    if isinstance(sibling_sel, str):
                        current = item.next_sibling
                        while current:
                            if hasattr(current, "name"):  # It's a tag, not a string
                                # Check if it matches the selector (class or tag)
                                if current.select_one(f":scope.{sibling_sel}") or current.name == sibling_sel:
                                    node = current
                                    break
                                # Also try matching if the class is in the element's classes
                                if hasattr(current, "get") and sibling_sel in current.get("class", []):
                                    node = current
                                    break
                            current = current.next_sibling
                    else:
                        node = item.find_next_sibling()

                    if node:
                        # If there's a nested selector, search within the sibling
                        nested_sel = m.get("selector")
                        if nested_sel:
                            nested = node.select_one(nested_sel)
                            if nested:
                                if def_attr == "text":
                                    return nested.get_text(separator=" ", strip=True)
                                else:
                                    return nested.get(def_attr, "")
                        # Otherwise return the sibling's text or attribute
                        if def_attr == "text":
                            return node.get_text(separator=" ", strip=True)
                        else:
                            return node.get(def_attr, "")
                    return ""
                else:
                    selector = m.get("selector") if isinstance(m, dict) else m
                    attr = m.get("attr", def_attr) if isinstance(m, dict) else def_attr
                    val = extract_html(
                        item,
                        selector,
                        attr=attr,
                        index=m.get("index") if isinstance(m, dict) else None,
                        exclude=m.get("exclude") if isinstance(m, dict) else None,
                    )
                return self._apply_mapping_logic(str(val or ""), m)

            # Strategy-specific fallback (Little Zoo)
            raw_title = get_val("title")
            if not raw_title and scraping.get("container", "").endswith("h2"):
                raw_title = item.get_text(strip=True)

            job = self._finalize_job(
                title=raw_title,
                link=get_val("link", "href"),
                location=get_val("location"),
                extra_link=get_val("extra_link", "html"),
                studio=studio,
                careers_url=careers_url,
                mapping=mapping,
            )
            if job:
                # Handle extra_link regex if needed
                if job.get("extra_link") and isinstance(mapping.get("extra_link"), dict):
                    extra_cfg = mapping["extra_link"]
                    match = re.search(extra_cfg.get("regex_link", ""), job["extra_link"])
                    if match:
                        job["extra_link"] = match.group(1) if match.groups() else match.group(0)
                        if not job["extra_link"].startswith("http"):
                            job["extra_link"] = urllib.parse.urljoin(
                                studio.get("website") or careers_url, job["extra_link"]
                            )
                jobs.append(job)

        return jobs

    def fetch_rss(self, studio):
        rss_url = studio.get("careers_url") or studio.get("website")
        scraping = studio.get("scraping", {})
        mapping = scraping.get("map", {})

        method = scraping.get("method", "GET").upper()
        params, payload, headers = scraping.get("params", {}), scraping.get("payload"), scraping.get("headers", {})

        if method == "POST":
            response = self.session.post(rss_url, json=payload, params=params, headers=headers)
        else:
            response = self.session.get(rss_url, params=params, headers=headers)
        response.raise_for_status()

        # Always use html.parser to avoid requiring the 'lxml' or 'xml' feature of BS4
        soup = BeautifulSoup(response.text, "html.parser")

        items = soup.select(scraping.get("container") or "item") or soup.find_all(["item", "entry"])
        jobs = []

        for item in items:

            def get_val(field_key, def_tag):
                m = mapping.get(field_key)
                if not m:
                    node = item.find(def_tag) or (item.find("guid") if def_tag == "link" else None)
                    return node.get_text(strip=True) if node else ""

                val = ""
                # Support source="url"
                if isinstance(m, dict) and m.get("source") == "url":
                    val = rss_url
                elif isinstance(m, dict):
                    sel = m.get("selector") or m.get("path") or def_tag
                    node = item.find(sel) or (item.find("guid") if def_tag == "link" else None)
                    if node:
                        val = (
                            node.get_text(strip=True)
                            if m.get("attr", "text") == "text"
                            else node.get(m.get("attr"))
                        )
                    else:
                        val = extract_html(item, sel, attr=m.get("attr", "text"), default="")
                    return self._apply_mapping_logic(str(val or ""), m)

                node = item.find(m) or (item.find("guid") if m == "link" else None)
                if node:
                    return node.get_text(strip=True)
                return str(extract_html(item, m, attr="text", default=""))

            job = self._finalize_job(
                title=get_val("title", "title"),
                link=get_val("link", "link"),
                location=get_val("location", "description"),
                extra_link=get_val("extra_link", "description"),
                studio=studio,
                careers_url=rss_url,
                mapping=mapping,
            )
            if job:
                # Handle extra_link regex if needed
                if job.get("extra_link") and isinstance(mapping.get("extra_link"), dict):
                    extra_cfg = mapping["extra_link"]
                    match = re.search(extra_cfg.get("regex_link", ""), job["extra_link"])
                    if match:
                        job["extra_link"] = match.group(1) if match.groups() else match.group(0)
                        if not job["extra_link"].startswith("http"):
                            job["extra_link"] = urllib.parse.urljoin(
                                studio.get("website") or rss_url, job["extra_link"]
                            )
                jobs.append(job)

        return jobs
