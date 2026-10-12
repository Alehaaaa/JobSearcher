import Foundation
import AppKit
import SwiftSoup

public class JobScraper {
    public static let shared = JobScraper()

    private struct HTTPStatusError: LocalizedError {
        let status: Int
        let host: String
        var errorDescription: String? { "\(host) returned HTTP \(status)" }
    }

    public func fetchJobs(for studio: Studio, startingAt: Int = 1) async throws -> (jobs: [Job], total: Int) {
        guard let scraping = studio.scraping else {
            throw URLError(.unsupportedURL)
        }
        
        let (jobsList, failure) = await withTaskGroup(of: (Int, Result<[Job], Error>).self) { group -> ([Job], Error?) in
            for (index, url) in studio.careersUrl.enumerated() {
                group.addTask {
                    do {
                        let jobs: [Job]
                        switch scraping.strategy {
                        case "json":
                            jobs = try await self.fetchJSON(for: studio, from: url)
                        case "html":
                            jobs = try await self.fetchHTML(for: studio, from: url)
                        case "json_text":
                            jobs = try await self.fetchJSONText(for: studio, from: url)
                        case "remix":
                            jobs = try await self.fetchRemix(for: studio, from: url)
                        case "rss":
                            jobs = try await self.fetchRSS(for: studio, from: url)
                        case "static":
                            jobs = []
                        default:
                            throw URLError(.unsupportedURL)
                        }
                        return (index, .success(jobs))
                    } catch {
                        return (index, .failure(error))
                    }
                }
            }
            
            var collected: [Job] = []
            var seenLinks = Set<String>()
            var firstFailure: Error?
            var succeeded = false
            var results: [Int: Result<[Job], Error>] = [:]
            for await (index, result) in group { results[index] = result }
            // Preserve Python's configured URL priority even when responses
            // complete out of order, including which duplicate wins.
            for index in studio.careersUrl.indices {
                guard let result = results[index] else { continue }
                switch result {
                case .success(let jobs):
                    succeeded = true
                    for job in jobs {
                        // Match Python's title+URL identity, ignoring common tracking parameters.
                        var components = URLComponents(url: job.link, resolvingAgainstBaseURL: false)
                        let items = components?.queryItems
                        components?.queryItems = items?.filter {
                            let name = $0.name.lowercased()
                            return !name.hasPrefix("utm_") && !["portal", "ref", "source", "jobid"].contains(name)
                        }
                        let key = job.title.lowercased() + "|" + (components?.url ?? job.link).absoluteString.lowercased()
                        if seenLinks.insert(key).inserted {
                            collected.append(job)
                        }
                    }
                case .failure(let error):
                    if firstFailure == nil { firstFailure = error }
                }
            }
            // A broken endpoint does not discard results from other careers URLs.
            return (collected, succeeded ? nil : firstFailure)
        }
        if let failure { throw failure }
        
        let enriched = try await enrichFromDetailPages(jobsList, config: scraping.detailPage)
        return (enriched, enriched.count)
    }

    // MARK: - Generic Scrapers
    
    private func fetchJSON(for studio: Studio, from url: URL) async throws -> [Job] {
        guard let scraping = studio.scraping else { return [] }
        var request = try makeRequest(url: url, scraping: scraping)
        if let preVisit = scraping.preVisit {
            for (key, value) in try await headersFromPreVisit(preVisit) {
                request.setValue(value, forHTTPHeaderField: key)
            }
        }
        
        let data = try await responseData(for: request)
        let json = try JSONSerialization.jsonObject(with: data)
        
        return try await parseJSONItems(json, for: studio, from: url)
    }

    private func fetchRemix(for studio: Studio, from url: URL) async throws -> [Job] {
        guard let scraping = studio.scraping else { return [] }
        let request = try makeRequest(url: url, scraping: scraping)
        let data = try await responseData(for: request)
        let raw = try JSONSerialization.jsonObject(with: data)
        let decoded = decodeDevalue(raw)
        return try await parseJSONItems(decoded, for: studio, from: url)
    }
    
    func parseJSONItems(_ json: Any, for studio: Studio, from url: URL) async throws -> [Job] {
        guard let scraping = studio.scraping else { return [] }
        let mapping = scraping.map ?? [:]
        
        var items = extractJSON(json, path: scraping.path ?? "")
        if !(items is [[String: Any]]) && !(items is [Any]) {
            if let single = items as? [String: Any] {
                items = [single]
            } else {
                return []
            }
        }
        
        var itemArray: [[String: Any]] = []
        if let directArray = items as? [[String: Any]] {
            itemArray = directArray
        } else if let anyArray = items as? [Any] {
            itemArray = anyArray.compactMap { $0 as? [String: Any] }
        } else {
            return []
        }
        
        // Filter
        if let filter = scraping.filter {
            itemArray = itemArray.filter { item in
                let val = stringify(extractJSON(item, path: filter.key))
                return val.hasPrefix(filter.startswith)
            }
        }
        
        var jobs: [Job] = []
        for item in itemArray {
            let title = applyMapping(to: "title", item: item, mapping: mapping, rootURL: url)
            let linkStr = applyMapping(to: "link", item: item, mapping: mapping, rootURL: url)
            let location = applyMapping(to: "location", item: item, mapping: mapping, rootURL: url)
            let extraLinkStr = applyMapping(to: "extra_link", item: item, mapping: mapping, rootURL: url)
            
            if let job = processJob(title: title, linkStr: linkStr, location: location, extraLinkStr: extraLinkStr, studio: studio, url: url, mapping: mapping) {
                jobs.append(job)
            }
        }
        
        return jobs
    }
    
    private func fetchJSONText(for studio: Studio, from url: URL) async throws -> [Job] {
        guard let scraping = studio.scraping else { return [] }
        let htmlResponse = try await fetchHTMLContent(from: url, scraping: scraping)
        let doc = try SwiftSoup.parse(htmlResponse)
        
        let regex: String
        if let customRegex = scraping.jsonText?.regex {
            regex = customRegex
        } else if let varName = scraping.jsonText?.variable {
            let escapedName = NSRegularExpression.escapedPattern(for: varName)
            regex = "(?:const|var|let|window\\.)\\s*\(escapedName)\\s*=\\s*(\\[.*?\\])\\s*(?:;|\\n|</script>)"
        } else {
            regex = "(?:const|var|let|window\\.)\\s*jobsData\\s*=\\s*(\\[.*?\\])\\s*(?:;|\\n|</script>)"
        }
        
        var text = ""
        // 1. Try script tags first
        if let scripts = try? doc.select(normalizeSelector(scraping.container ?? "script")) {
            let nsRegex = try? NSRegularExpression(pattern: regex, options: [.dotMatchesLineSeparators])
            for s in scripts {
                let contents = s.data()
                if !contents.isEmpty {
                    let nsRange = NSRange(contents.startIndex..., in: contents)
                    if let _ = nsRegex?.firstMatch(in: contents, range: nsRange) {
                        text = contents
                        break
                    }
                }
            }
        }
        
        // 2. Fallback: Search the entire raw HTML response
        if text.isEmpty {
            let nsRegex = try? NSRegularExpression(pattern: regex, options: [.dotMatchesLineSeparators])
            let nsRange = NSRange(htmlResponse.startIndex..., in: htmlResponse)
            if let _ = nsRegex?.firstMatch(in: htmlResponse, range: nsRange) {
                text = htmlResponse
            }
        }
        
        if !text.isEmpty {
            if let nsRegex = try? NSRegularExpression(pattern: regex, options: [.dotMatchesLineSeparators]) {
                let nsRange = NSRange(text.startIndex..., in: text)
                if let firstMatch = nsRegex.firstMatch(in: text, range: nsRange),
                   firstMatch.numberOfRanges > 1 {
                    let groupRange = firstMatch.range(at: 1)
                    if let r = Range(groupRange, in: text) {
                        var jsonStr = String(text[r])
                        if scraping.jsonText?.unescape == true {
                            jsonStr = (try? SwiftSoup.parse(jsonStr).text()) ?? jsonStr
                        }
                        if let jsonData = jsonStr.data(using: .utf8),
                           let json = try? JSONSerialization.jsonObject(with: jsonData) {
                            return try await parseJSONItems(json, for: studio, from: url)
                        }
                    }
                }
            }
        }
        return []
    }
    
    private func fetchHTML(for studio: Studio, from url: URL) async throws -> [Job] {
        guard let scraping = studio.scraping else { return [] }
        let mapping = scraping.map ?? [:]
        
        let responseData = try await responseData(for: makeRequest(url: url, scraping: scraping))
        var htmlResponse = decodeText(responseData, encoding: scraping.encoding)
        if let jsonHTMLField = scraping.jsonHTMLField,
           let json = try? JSONSerialization.jsonObject(with: responseData),
           let extracted = extractJSON(json, path: jsonHTMLField) {
            htmlResponse = stringify(extracted)
        }
        let doc = try SwiftSoup.parse(htmlResponse)
        
        guard let containerSelector = scraping.container else { return [] }
        let items = try doc.select(normalizeSelector(containerSelector))
        
        var jobs: [Job] = []
        for item in items {
            let title = applyMappingHTML(to: "title", element: item, mapping: mapping, rootURL: url)
            let linkStr = applyMappingHTML(to: "link", element: item, mapping: mapping, rootURL: url, defaultAttr: "href")
            let location = applyMappingHTML(to: "location", element: item, mapping: mapping, rootURL: url)
            let extraLinkStr = applyMappingHTML(to: "extra_link", element: item, mapping: mapping, rootURL: url, defaultAttr: "html")
            
            if let job = processJob(title: title, linkStr: linkStr, location: location, extraLinkStr: extraLinkStr, studio: studio, url: url, mapping: mapping, element: item) {
                jobs.append(job)
            }
        }
        
        return jobs
    }
    
    private func fetchRSS(for studio: Studio, from url: URL) async throws -> [Job] {
        guard let scraping = studio.scraping else { return [] }
        let mapping = scraping.map ?? [:]
        
        let xmlResponse = try await fetchHTMLContent(from: url, scraping: scraping)
        let doc = try SwiftSoup.parse(xmlResponse, "", Parser.xmlParser())
        
        let containerSelector = scraping.container ?? "item"
        let items = try doc.select(containerSelector)
        
        var jobs: [Job] = []
        for item in items {
            let title = applyMappingRSS(to: "title", element: item, mapping: mapping, rootURL: url, defaultTag: "title")
            let linkStr = applyMappingRSS(to: "link", element: item, mapping: mapping, rootURL: url, defaultTag: "link")
            let location = applyMappingRSS(to: "location", element: item, mapping: mapping, rootURL: url, defaultTag: "description")
            
            if let job = processJob(title: title, linkStr: linkStr, location: location, extraLinkStr: "", studio: studio, url: url, mapping: mapping) {
                jobs.append(job)
            }
        }
        
        return jobs
    }
    
    private func processJob(title: String, linkStr: String, location: String, extraLinkStr: String, studio: Studio, url: URL, mapping: [String: ScrapingMapValue], element: Element? = nil) -> Job? {
        var cleanedTitle = cleanText(title)
        let cleanedLocation = cleanText(location)
        
        if mapping["remove_location_from_title"]?.removeLocationFromTitle == true || mapping["title"]?.removeLocationFromTitle == true {
            cleanedTitle = cleanText(removeLocationFromTitle(title: cleanedTitle, location: cleanedLocation))
        }
        
        // Strategy-specific fallbacks
        if cleanedTitle.isEmpty, let element = element, studio.scraping?.container?.contains("h2") == true {
            cleanedTitle = cleanText((try? element.text()) ?? "")
        }
        
        if cleanedTitle.isEmpty || ["view job", "details", "read more", "apply", "careers", "unknown"].contains(cleanedTitle.lowercased()) {
            return nil
        }
        
        let link: URL
        if linkStr.isEmpty {
            link = url.absoluteURL
        } else if let l = URL(string: linkStr, relativeTo: studio.website ?? url) {
            link = l.absoluteURL
        } else {
            return nil
        }
        
        var extraLink: URL? = nil
        if !extraLinkStr.isEmpty {
            if let extraCfg = mapping["extra_link"], let regex = extraCfg.regexLink {
                if let nsRegex = try? NSRegularExpression(pattern: regex) {
                    let nsRange = NSRange(extraLinkStr.startIndex..., in: extraLinkStr)
                    if let firstMatch = nsRegex.firstMatch(in: extraLinkStr, range: nsRange) {
                        let matchRange = firstMatch.range(at: firstMatch.numberOfRanges > 1 ? 1 : 0)
                        if let r = Range(matchRange, in: extraLinkStr) {
                            extraLink = URL(string: String(extraLinkStr[r]), relativeTo: studio.website ?? url)
                        }
                    }
                }
            } else {
                extraLink = URL(string: extraLinkStr, relativeTo: studio.website ?? url)
            }
        }
        
        return Job(title: cleanedTitle, link: link, location: cleanedLocation.isEmpty ? nil : cleanedLocation, extraLink: extraLink?.absoluteURL)
    }

    // MARK: - Utilities
    
    func extractJSON(_ data: Any, path: String) -> Any? {
        if path.isEmpty { return data }

        // Like the Python extractor, alternatives have precedence over concatenation.
        if path.contains(",") {
            let paths = splitPath(path, separator: ",")
            if paths.count > 1 {
                for candidate in paths {
                    if let val = extractJSON(data, path: candidate), !(val is NSNull) {
                        if let text = val as? String, text.isEmpty { continue }
                        if let values = val as? [Any], values.isEmpty { continue }
                        return val
                    }
                }
                return nil
            }
        }
        if path.contains("+") {
            let parts = splitPath(path, separator: "+")
            if parts.count > 1 {
                var result = ""
                for part in parts {
                    let value: String
                    if (part.hasPrefix("'") && part.hasSuffix("'")) ||
                        (part.hasPrefix("\"") && part.hasSuffix("\"")) {
                        value = String(part.dropFirst().dropLast())
                    } else if let extracted = extractJSON(data, path: part) {
                        value = stringify(extracted)
                    } else {
                        return nil
                    }
                    result += value
                }
                return result
            }
        }
        
        
        let parts = path.components(separatedBy: ".")
        var current: [Any] = [data]
        var usedWildcard = false

        for part in parts {
            var key = part
            var index: Int? = nil
            var wildcard = false
            
            if part.contains("[") && part.contains("]") {
                let bits = part.components(separatedBy: "[")
                key = bits[0]
                let indexBit = bits[1].replacingOccurrences(of: "]", with: "")
                if indexBit == "*" {
                    wildcard = true
                    usedWildcard = true
                } else {
                    index = Int(indexBit)
                }
            }

            var next: [Any] = []
            for node in current {
                var value: Any? = node
                if !key.isEmpty {
                    value = (node as? [String: Any])?[key]
                }
                guard let unwrapped = value else { continue }
                if wildcard, let array = unwrapped as? [Any] {
                    next.append(contentsOf: array)
                } else if let idx = index, let array = unwrapped as? [Any] {
                    let resolved = idx >= 0 ? idx : array.count + idx
                    if array.indices.contains(resolved) { next.append(array[resolved]) }
                } else {
                    next.append(unwrapped)
                }
            }
            current = next
        }

        if usedWildcard { return current }
        return current.count == 1 ? current[0] : (current.isEmpty ? nil : current)
    }

    private func applyMapping(to field: String, item: [String: Any], mapping: [String: ScrapingMapValue], rootURL: URL) -> String {
        guard let mapValue = mapping[field] else { return "" }
        
        var rawValue: Any?
        if mapValue.source == "url" {
            rawValue = rootURL.absoluteString
        } else if let path = mapValue.path {
            rawValue = extractJSON(item, path: path)
        }

        let value: String
        if let array = rawValue as? [Any] {
            value = array.map(stringify).filter { !$0.isEmpty }.joined(separator: mapValue.join ?? ", ")
        } else {
            value = stringify(rawValue)
        }
        return finalizeValue(value, config: mapValue)
    }
    
    func applyMappingHTML(to field: String, element: Element, mapping: [String: ScrapingMapValue], rootURL: URL, defaultAttr: String = "text") -> String {
        guard let mapValue = mapping[field] else { return "" }

        // A default-only HTML rule is a constant, matching Python's mapper.
        // Reading the whole container here accidentally displayed the job description
        // as the location for Pixel Zoo, Techland, Little Zoo and others.
        if let fallback = mapValue.defaultValue,
           mapValue.selector == nil, mapValue.path == nil,
           mapValue.source == nil, mapValue.findPrevious == nil,
           mapValue.findNextSibling == nil {
            return fallback
        }
        
        var result = ""
        
        if mapValue.source == "url" {
            result = rootURL.absoluteString
        } else if let findPrevious = mapValue.findPrevious {
            // Traverse previous siblings and ancestors' previous siblings to find the matching element
            var found = false
            var current: Element? = element
            
            while let currentElement = current {
                var sibling = currentElement
                while let prev = try? sibling.previousElementSibling() {
                    // Check if this element matches the selector
                    if let matched = try? prev.select(normalizeSelector(findPrevious)).first() {
                        result = (try? matched.text()) ?? ""
                        found = true
                        break
                    }
                    // Also check if the element itself matches
                    if prev.tagName().lowercased() == findPrevious.lowercased() {
                        result = (try? prev.text()) ?? ""
                        found = true
                        break
                    }
                    sibling = prev
                }
                if found { break }
                current = currentElement.parent()
            }
        } else if let siblingSelector = mapValue.findNextSibling {
            var sibling = try? element.nextElementSibling()
            while let candidate = sibling {
                let classMatch = (try? candidate.classNames().contains(siblingSelector)) ?? false
                if candidate.tagName() == siblingSelector || classMatch {
                    let nested = mapValue.selector.flatMap { try? candidate.select(normalizeSelector($0)).first() }
                    result = extractHTMLValue(from: nested ?? candidate, attr: mapValue.attr ?? defaultAttr)
                    break
                }
                sibling = try? candidate.nextElementSibling()
            }
        } else {
            let selector = mapValue.selector ?? ""
            let attr = mapValue.attr ?? defaultAttr
            
            do {
                let targets = selector.isEmpty ? nil : try element.select(normalizeSelector(selector))
                if let targets,
                   case .string(let slice)? = mapValue.index,
                   slice.contains(":") {
                    let parts = slice.split(separator: ":", omittingEmptySubsequences: false)
                    if parts.count == 2 {
                        let count = targets.size()
                        func boundary(_ part: Substring, fallback: Int) -> Int {
                            guard let raw = Int(part) else { return fallback }
                            return max(0, min(count, raw < 0 ? count + raw : raw))
                        }
                        let lower = boundary(parts[0], fallback: 0)
                        let upper = boundary(parts[1], fallback: count)
                        if lower < upper {
                            result = (lower..<upper).compactMap { targets.get($0) }
                                .map { target -> String in
                                    self.extractHTMLValue(from: target, attr: attr, exclude: mapValue.exclude)
                                }
                                .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                                .joined(separator: " ")
                        }
                        return finalizeValue(result, config: mapValue)
                    }
                }
                let target: Element?
                if selector.isEmpty {
                    target = element
                } else if let targets, let index = integerIndex(mapValue.index), !targets.isEmpty() {
                    let resolved = index >= 0 ? index : targets.size() + index
                    target = resolved >= 0 && resolved < targets.size() ? targets.get(resolved) : nil
                } else {
                    target = targets?.first()
                }
                if let target = target {
                    result = extractHTMLValue(from: target, attr: attr, exclude: mapValue.exclude)
                }
            } catch {
                print("HTML extraction error for \(field): \(error)")
            }
        }
        
        return finalizeValue(result, config: mapValue)
    }
    
    private func applyMappingRSS(to field: String, element: Element, mapping: [String: ScrapingMapValue], rootURL: URL, defaultTag: String) -> String {
        guard let mapValue = mapping[field] else {
            return (try? element.select(defaultTag).first()?.text()) ?? ""
        }
        
        var result = ""
        if mapValue.source == "url" {
            result = rootURL.absoluteString
        } else {
            let selector = mapValue.selector ?? mapValue.path ?? defaultTag
            let attr = mapValue.attr ?? "text"
            
            do {
                if let target = try element.select(normalizeSelector(selector)).first() {
                    if attr == "text" {
                        result = try target.text()
                    } else {
                        result = try target.attr(attr)
                    }
                }
            } catch { }
        }
        
        return finalizeValue(result, config: mapValue)
    }
    
    func finalizeValue(_ input: String, config: ScrapingMapValue) -> String {
        var val = input

        if val.isEmpty { return config.defaultValue ?? "" }
        
        if let split = config.split {
            let parts = val.components(separatedBy: split.sep)
            if split.index >= 0 && split.index < parts.count {
                val = parts[split.index].trimmingCharacters(in: .whitespaces)
            }
        }
        
        if let regex = config.regex, !val.isEmpty {
            if let expression = try? NSRegularExpression(pattern: regex),
               let match = expression.firstMatch(in: val, range: NSRange(val.startIndex..., in: val)),
               let captured = Range(match.range(at: match.numberOfRanges > 1 ? 1 : 0), in: val) {
                val = String(val[captured])
            } else { val = "" }
        }

        for replacement in config.replace ?? [] {
            val = val.replacingOccurrences(of: replacement.old, with: replacement.new)
        }
        if config.titleCase == true { val = val.capitalized }
        
        if !val.isEmpty {
            if let prefix = config.prefix { val = prefix + val }
            if let suffix = config.suffix { val = val + suffix }
        }
        
        return val.isEmpty ? (config.defaultValue ?? "") : val
    }

    private func makeRequest(url: URL, scraping: ScrapingConfig) throws -> URLRequest {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        if let params = scraping.params {
            var items = components?.queryItems ?? []
            for (key, value) in params {
                if case .array(let values) = value {
                    items.append(contentsOf: values.map { URLQueryItem(name: key, value: $0.stringValue) })
                } else {
                    items.append(URLQueryItem(name: key, value: value.stringValue))
                }
            }
            components?.queryItems = items
        }
        guard let requestURL = components?.url else { throw URLError(.badURL) }
        var request = URLRequest(url: requestURL)
        request.httpMethod = scraping.method ?? "GET"
        request.addValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36", forHTTPHeaderField: "User-Agent")
        if let headers = scraping.headers {
            for (key, value) in headers {
                request.setValue(value, forHTTPHeaderField: key)
            }
        }
        if let formData = scraping.formData {
            let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
            request.httpBody = formData.map { key, value in
                let encodedKey = key.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
                let encoded = value.stringValue.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
                return "\(encodedKey)=\(encoded)"
            }.joined(separator: "&").data(using: .utf8)
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        } else if let payload = scraping.payload {
            request.httpBody = try JSONEncoder().encode(payload)
            if request.value(forHTTPHeaderField: "Content-Type") == nil {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }
        }
        return request
    }

    private func responseData(for request: URLRequest) async throws -> Data {
        for attempt in 0..<3 {
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
                if (200...299).contains(http.statusCode) { return data }
                if request.httpMethod?.uppercased() == "GET", attempt < 2,
                   (http.statusCode == 429 || (500...599).contains(http.statusCode)) {
                    let retrySeconds = http.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init)
                    try await Task.sleep(for: .seconds(min(retrySeconds ?? Double(attempt + 1), 5)))
                    continue
                }
                throw HTTPStatusError(status: http.statusCode, host: request.url?.host ?? "Server")
            } catch {
                let code = (error as NSError).code
                if request.httpMethod?.uppercased() == "GET", attempt < 2,
                   (error as NSError).domain == NSURLErrorDomain,
                   [-1001, -1003, -1004, -1005, -1009].contains(code) {
                    try await Task.sleep(for: .milliseconds(350 * (attempt + 1)))
                    continue
                }
                throw error
            }
        }
        throw URLError(.cannotLoadFromNetwork)
    }

    private func fetchHTMLContent(from url: URL, scraping: ScrapingConfig) async throws -> String {
        let data = try await responseData(for: makeRequest(url: url, scraping: scraping))
        return decodeText(data, encoding: scraping.encoding)
    }

    private func decodeText(_ data: Data, encoding: String?) -> String {
        let selected: String.Encoding
        switch encoding?.lowercased() {
        case "iso-8859-1", "latin-1", "latin1": selected = .isoLatin1
        case "windows-1252", "cp1252": selected = .windowsCP1252
        case "ascii", "us-ascii": selected = .ascii
        default: selected = .utf8
        }
        return String(data: data, encoding: selected)
            ?? String(data: data, encoding: .utf8)
            ?? String(decoding: data, as: UTF8.self)
    }

    private func headersFromPreVisit(_ config: ScrapingConfig.PreVisitConfig) async throws -> [String: String] {
        guard let url = config.url else { return [:] }
        var request = URLRequest(url: url)
        request.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36", forHTTPHeaderField: "User-Agent")
        _ = try await responseData(for: request)
        guard let csrf = config.csrf,
              let cookieName = csrf.cookie,
              let headerName = csrf.header,
              let cookie = HTTPCookieStorage.shared.cookies(for: url)?.first(where: { $0.name == cookieName })
        else { return [:] }
        var value = cookie.value
        if csrf.unescape == true { value = value.removingPercentEncoding ?? value }
        if let separator = csrf.split { value = value.components(separatedBy: separator).first ?? value }
        return [headerName: value]
    }

    private func enrichFromDetailPages(_ jobs: [Job], config: ScrapingConfig.DetailPageConfig?) async throws -> [Job] {
        guard let config, !config.map.isEmpty else { return jobs }
        let batchSize = max(1, min(config.maxWorkers ?? 6, 16))
        var output = jobs
        for start in stride(from: 0, to: jobs.count, by: batchSize) {
            await withTaskGroup(of: (Int, Job).self) { group in
                for index in start..<min(start + batchSize, jobs.count) {
                    let job = jobs[index]
                    group.addTask {
                        do {
                            var request = URLRequest(url: job.link, timeoutInterval: config.timeout ?? 10)
                            request.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36", forHTTPHeaderField: "User-Agent")
                            config.headers?.forEach { request.setValue($0.value, forHTTPHeaderField: $0.key) }
                            let data = try await self.responseData(for: request)
                            let document = try SwiftSoup.parse(String(data: data, encoding: .utf8) ?? "")
                            var title = job.title
                            var location = job.location
                            for (field, rule) in config.map {
                                let value = self.applyMappingHTML(to: field, element: document, mapping: [field: rule], rootURL: job.link)
                                guard !value.isEmpty else { continue }
                                if field == "title" { title = self.cleanText(value) }
                                if field == "location" { location = self.cleanText(value) }
                            }
                            return (index, Job(title: title, link: job.link, location: location, extraLink: job.extraLink))
                        } catch {
                            return (index, job)
                        }
                    }
                }
                for await (index, job) in group { output[index] = job }
            }
        }
        return output
    }

    private func decodeDevalue(_ root: Any) -> Any {
        guard let values = root as? [Any] else { return root }
        var visiting = Set<Int>()
        func decode(_ reference: Any) -> Any {
            guard let number = reference as? NSNumber,
                  CFGetTypeID(number) != CFBooleanGetTypeID() else { return reference }
            let index = number.intValue
            if index < 0 { return NSNull() }
            guard values.indices.contains(index), !visiting.contains(index) else { return NSNull() }
            visiting.insert(index)
            defer { visiting.remove(index) }
            let value = values[index]
            if let dictionary = value as? [String: Any] {
                var decoded: [String: Any] = [:]
                for (keyReference, child) in dictionary {
                    let rawKey = keyReference.hasPrefix("_") ? String(keyReference.dropFirst()) : keyReference
                    let key = Int(rawKey).map { stringify(decode($0)) } ?? rawKey
                    decoded[key] = decode(child)
                }
                return decoded
            }
            if let array = value as? [Any] { return array.map(decode) }
            return value
        }
        return decode(0)
    }

    private func stringify(_ value: Any?) -> String {
        guard let value, !(value is NSNull) else { return "" }
        if let string = value as? String { return string }
        if let number = value as? NSNumber { return number.stringValue }
        return String(describing: value)
    }

    private func integerIndex(_ value: JSONValue?) -> Int? {
        guard let value else { return nil }
        switch value {
        case .number(let number): return Int(number)
        case .string(let string): return Int(string)
        default: return nil
        }
    }

    private func extractHTMLValue(from element: Element, attr: String, exclude: String? = nil) -> String {
        if attr == "text" {
            if let exclude {
                let clone = element.copy() as! Element
                _ = try? clone.select(normalizeSelector(exclude)).remove()
                return (try? clone.text()) ?? ""
            }
            return (try? element.text()) ?? ""
        }
        if attr == "html" { return (try? element.outerHtml()) ?? "" }
        return (try? element.attr(attr)) ?? ""
    }

    private func splitPath(_ value: String, separator: Character) -> [String] {
        var quote: Character?
        var current = ""
        var output: [String] = []
        for character in value {
            if character == "'" || character == "\"" {
                quote = quote == character ? nil : (quote == nil ? character : quote)
            }
            if character == separator && quote == nil {
                output.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            } else {
                current.append(character)
            }
        }
        if !current.isEmpty { output.append(current.trimmingCharacters(in: .whitespaces)) }
        return output
    }

    private func normalizeSelector(_ selector: String) -> String {
        guard !selector.isEmpty else { return selector }
        // Escape colons in CSS selectors for SwiftSoup compatibility
        return selector.replacingOccurrences(of: "\\\\", with: "\\")
    }

    private func removeLocationFromTitle(title: String, location: String?) -> String {
        guard let location = location, !location.isEmpty, !title.isEmpty else { return title }
        
        var result = title
        
        // 1. Basic removal of the full location string
        let escapedLocation = NSRegularExpression.escapedPattern(for: location)
        if let regex = try? NSRegularExpression(pattern: escapedLocation, options: .caseInsensitive) {
            result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "")
        }
        
        // 2. Comma separated components
        if location.contains(",") {
            let parts = location.components(separatedBy: ",")
            for p in parts {
                let pStrip = p.trimmingCharacters(in: .whitespaces)
                if !pStrip.isEmpty {
                    let escapedPart = NSRegularExpression.escapedPattern(for: pStrip)
                    if let regex = try? NSRegularExpression(pattern: "\\b" + escapedPart + "\\b", options: .caseInsensitive) {
                        result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "")
                    }
                }
            }
        }
        
        // 3. Collapse multiple separators
        if let regex = try? NSRegularExpression(pattern: "\\s*([ \\-\\|/\\\\·•])\\s*([ \\-\\|/\\\\·•]\\s*)+") {
            result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: " $1 ")
        }
        
        // 4. Remove empty brackets
        if let regex = try? NSRegularExpression(pattern: "\\(\\s*\\)|\\[\\s*\\]|\\{\\s*\\}") {
            result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "")
        }
        
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func cleanText(_ text: String) -> String {
        guard !text.isEmpty else { return "" }
        // Use SwiftSoup for reliable entity decoding and tag stripping
        let cleaned = (try? SwiftSoup.parse(text).text()) ?? text
        return cleaned.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "·•| -:"))
    }
}


// MARK: - Collection Extension for Async Operations
extension Collection {
    func asyncMap<T>(_ transform: (Element) async throws -> T) async rethrows -> [T] {
        var result = [T]()
        for element in self {
            result.append(try await transform(element))
        }
        return result
    }
}
