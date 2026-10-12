// Run on macOS: swiftc -parse-as-library scripts/audit_native.swift -o /tmp/jobui-audit
// Then: /tmp/jobui-audit JobUI/studios.json
// Probes every configured careers URL and logo with the same URLSession TLS stack as JobUI.
import Foundation
import AppKit

struct Studio: Decodable {
    let id: String
    let logo_url: URL
    let careers_url: URLList
    let scraping: Scraping?
}
struct URLList: Decodable {
    let urls: [URL]
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let one = try? c.decode(URL.self) { urls = [one] }
        else { urls = try c.decode([URL].self) }
    }
}
struct Scraping: Decodable {
    let strategy: String
    let method: String?
    let headers: [String: String]?
}
struct Probe: Sendable {
    let id: String
    let kind: String
    let url: URL
    let method: String
    let headers: [String: String]
}

@main struct Audit {
    static func main() async throws {
        let path = CommandLine.arguments.dropFirst().first ?? "JobUI/studios.json"
        let studios = try JSONDecoder().decode([Studio].self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        var probes: [Probe] = []
        for studio in studios {
            let scraping = studio.scraping
            for url in studio.careers_url.urls {
                probes.append(Probe(id: studio.id, kind: "scraper/\(scraping?.strategy ?? "none")", url: url,
                                    method: scraping?.method ?? "GET", headers: scraping?.headers ?? [:]))
            }
            probes.append(Probe(id: studio.id, kind: "logo", url: studio.logo_url, method: "GET", headers: [:]))
        }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.httpMaximumConnectionsPerHost = 4
        let session = URLSession(configuration: config)
        var successful = 0
        var failed = 0
        for batch in stride(from: 0, to: probes.count, by: 8) {
            let slice = Array(probes[batch..<min(batch + 8, probes.count)])
            await withTaskGroup(of: (Probe, String).self) { group in
                for probe in slice {
                    group.addTask {
                        do {
                            var request = URLRequest(url: probe.url)
                            request.httpMethod = probe.method
                            request.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/121 Safari/537.36", forHTTPHeaderField: "User-Agent")
                            for (key, value) in probe.headers { request.setValue(value, forHTTPHeaderField: key) }
                            let (data, response) = try await session.data(for: request)
                            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                            let decodable = probe.kind == "logo" ? (NSImage(data: data) != nil) : true
                            return (probe, "\(status) image=\(decodable) bytes=\(data.count)")
                        } catch {
                            return (probe, "ERROR \((error as NSError).domain) \((error as NSError).code): \(error.localizedDescription)")
                        }
                    }
                }
                for await (probe, result) in group {
                    let ok = result.hasPrefix("200 image=true") || (probe.kind != "logo" && result.hasPrefix("200 "))
                    if ok { successful += 1 } else { failed += 1 }
                    print("\(ok ? "OK" : "FAIL") \(probe.id) \(probe.kind) \(result)")
                    fflush(stdout)
                }
            }
        }
        print("TOTAL \(probes.count) OK \(successful) FAILED \(failed)")
    }
}
