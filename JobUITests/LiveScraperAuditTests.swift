import Foundation
import Testing
@testable import JobUI

struct LiveScraperAuditTests {
    /// Opt in with JOBUI_LIVE_AUDIT=1. All configured studios are exercised,
    /// including known temporarily offline and rate-limited providers.
    @Test func everyConfiguredScraper() async throws {
        guard ProcessInfo.processInfo.environment["JOBUI_LIVE_AUDIT"] == "1" else { return }
        let configURL = try #require(Bundle.main.url(forResource: "studios", withExtension: "json"))
        let studios = try JSONDecoder().decode([Studio].self, from: Data(contentsOf: configURL))
        var nonempty = 0
        var failures: [(String, String)] = []
        var counts: [String: Int] = [:]
        var locations: [String: [[String: String]]] = [:]
        var fullJobs: [String: [[String: String]]] = [:]
        for offset in stride(from: 0, to: studios.count, by: 4) {
            let batch = Array(studios[offset..<min(offset + 4, studios.count)])
            await withTaskGroup(of: (String, Result<[Job], Error>).self) { group in
                for studio in batch {
                    group.addTask {
                        do {
                            let result = try await JobScraper.shared.fetchJobs(for: studio)
                            return (studio.id, .success(result.jobs))
                        } catch { return (studio.id, .failure(error)) }
                    }
                }
                for await (id, result) in group {
                    switch result {
                    case .success(let jobs):
                        let count = jobs.count
                        locations[id] = Array(jobs.prefix(8)).map { ["title": $0.title, "location": $0.location ?? ""] }
                        fullJobs[id] = jobs.map { ["title": $0.title, "location": $0.location ?? "",
                                                     "link": $0.link.absoluteString,
                                                     "extra_link": $0.extraLink?.absoluteString ?? ""] }
                        counts[id] = count
                        if count > 0 { nonempty += 1 }
                        print("SCRAPER_AUDIT \(id) \(count)")
                    case .failure(let error):
                        counts[id] = -1
                        failures.append((id, error.localizedDescription))
                        print("SCRAPER_AUDIT \(id) ERROR \(error.localizedDescription)")
                    }
                }
            }
        }
        print("SCRAPER_AUDIT_TOTAL \(studios.count) NONEMPTY \(nonempty) FAILURES \(failures.count)")
        if let data = try? JSONSerialization.data(withJSONObject: counts, options: [.sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: "/tmp/jobui_swift_scraper_counts.json"))
        }
        if let data = try? JSONSerialization.data(withJSONObject: locations, options: [.sortedKeys, .prettyPrinted]) {
            try? data.write(to: URL(fileURLWithPath: "/tmp/jobui_swift_locations.json"))
        }
        if let data = try? JSONSerialization.data(withJSONObject: fullJobs, options: [.sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: "/tmp/jobui_swift_full_jobs.json"))
        }
        #expect(nonempty >= 50, "Most sources should still produce jobs; see SCRAPER_AUDIT output for the failed hosts")
    }
}
