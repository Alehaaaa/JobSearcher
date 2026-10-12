import Foundation

public class ConfigManager {
    public static let shared = ConfigManager()
    
    private let studiosFilename = "studios.json"
    private let lastCheckKey = "lastConfigUpdateCheck"
    private let etagKey = "configETag"
    private let lastModifiedKey = "configLastModified"
    
    private var applicationSupportDirectory: URL {
        let paths = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
        let appSupportDir = paths[0].appendingPathComponent("JobUI")
        if !FileManager.default.fileExists(atPath: appSupportDir.path) {
            try? FileManager.default.createDirectory(at: appSupportDir, withIntermediateDirectories: true)
        }
        return appSupportDir
    }
    
    public var studiosConfigURL: URL {
        return applicationSupportDirectory.appendingPathComponent(studiosFilename)
    }

    /// Apply only migrations whose exact old rule is still present. This lets
    /// bundled fixes work with an older downloaded main config while respecting
    /// any future provider rule changes or user-edited configurations.
    func applyingBundledRuleMigrations(_ data: Data) -> Data {
        guard let url = Bundle.main.url(forResource: "location-rule-migrations", withExtension: "json"),
              let migrations = (try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [[String: Any]],
              var studios = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else {
            return data
        }
        var changed = false
        for index in studios.indices {
            guard let id = studios[index]["id"] as? String,
                  let migration = migrations.first(where: { $0["id"] as? String == id }),
                  let oldRule = migration["old"], let newRule = migration["new"],
                  var scraping = studios[index]["scraping"] as? [String: Any],
                  var mapping = scraping["map"] as? [String: Any],
                  let current = mapping["location"],
                  NSDictionary(dictionary: ["rule": current]).isEqual(to: ["rule": oldRule]) else {
                continue
            }
            mapping["location"] = newRule
            scraping["map"] = mapping
            studios[index]["scraping"] = scraping
            changed = true
        }
        guard changed, let updated = try? JSONSerialization.data(withJSONObject: studios) else { return data }
        return updated
    }
    
    public func loadStudios() -> [Studio] {
        let fileManager = FileManager.default
        let decoder = JSONDecoder()
        var loadedStudios: [Studio] = []
        
        // 1. Try Application Support first
        if fileManager.fileExists(atPath: studiosConfigURL.path) {
            do {
                let data = try Data(contentsOf: studiosConfigURL)
                loadedStudios = try decoder.decode([Studio].self, from: applyingBundledRuleMigrations(data))
            } catch {
                print("Failed to load studios from App Support: \(error)")
                // Preserve the user's file; use the bundled baseline until a valid update arrives.
            }
        }
        
        // 2. If nothing from App Support, try Bundle
        if loadedStudios.isEmpty, let bundleURL = Bundle.main.url(forResource: "studios", withExtension: "json") {
            do {
                let data = try Data(contentsOf: bundleURL)
                loadedStudios = try decoder.decode([Studio].self, from: applyingBundledRuleMigrations(data))
            } catch {
                print("Failed to load studios from Bundle: \(error)")
            }
        }
        
        // Handle sorting and deduplication
        let savedOrder = UserDefaults.standard.stringArray(forKey: "studioOrder") ?? []
        var seen = Set<String>()
        var studioDict: [String: Studio] = [:]
        for studio in loadedStudios { studioDict[studio.id] = studio }
        
        var sortedStudios = savedOrder.compactMap { id -> Studio? in
            if seen.contains(id) { return nil }
            seen.insert(id)
            return studioDict[id]
        }
        
        for studio in loadedStudios {
            if !seen.contains(studio.id) {
                sortedStudios.append(studio)
            }
        }
        
        return sortedStudios
    }
    
    public func updateConfigIfNeeded() async -> Bool {
        let rawContentUrl = URL(string: "https://raw.githubusercontent.com/Alehaaaa/JobUI/refs/heads/main/config/studios.json")!
        
        do {
            var request = URLRequest(url: rawContentUrl, cachePolicy: .reloadIgnoringLocalCacheData)
            request.setValue("JobUI-mac-Updater", forHTTPHeaderField: "User-Agent")
            request.setValue("application/json", forHTTPHeaderField: "Accept")

            // Conditional requests avoid GitHub API rate limits and unnecessary rewrites.
            if let cachedData = try? Data(contentsOf: studiosConfigURL),
               (try? JSONDecoder().decode([Studio].self, from: cachedData)) != nil {
                if let etag = UserDefaults.standard.string(forKey: etagKey) {
                    request.setValue(etag, forHTTPHeaderField: "If-None-Match")
                }
            }

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                return false
            }
            UserDefaults.standard.set(Date(), forKey: lastCheckKey)
            if httpResponse.statusCode == 304 { return false }
            guard httpResponse.statusCode == 200 else {
                return false
            }

            let decoded = try JSONDecoder().decode([Studio].self, from: data)
            guard !decoded.isEmpty else { return false }
            if let oldData = try? Data(contentsOf: studiosConfigURL), oldData == data {
                return false
            }
            try data.write(to: studiosConfigURL, options: .atomic)
            UserDefaults.standard.set(httpResponse.value(forHTTPHeaderField: "ETag"), forKey: etagKey)
            UserDefaults.standard.set(httpResponse.value(forHTTPHeaderField: "Last-Modified"), forKey: lastModifiedKey)
            return true
        } catch {
            print("Failed to update config: \(error)")
            return false
        }
    }
    
    public func updateDatabase() async -> (success: Bool, message: String) {
        let rawContentUrl = URL(string: "https://raw.githubusercontent.com/Alehaaaa/JobUI/refs/heads/main/config/studios.json")!
        
        do {
            // Download new config
            var request = URLRequest(url: rawContentUrl, cachePolicy: .reloadIgnoringLocalCacheData)
            request.setValue("JobUI-mac-Updater", forHTTPHeaderField: "User-Agent")
            let (newData, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            let decoder = JSONDecoder()
            let newStudios = try decoder.decode([Studio].self, from: newData)
            guard !newStudios.isEmpty else { throw URLError(.cannotParseResponse) }
            
            // Load current studios
            let currentStudios = loadStudios()
            
            // Compare and merge
            let existingIDs = Set(currentStudios.map(\.id))
            let incomingByID = Dictionary(newStudios.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
            var addedCount = 0
            var merged = currentStudios.map { incomingByID[$0.id] ?? $0 }
            for newStudio in newStudios where !existingIDs.contains(newStudio.id) {
                merged.append(newStudio)
                addedCount += 1
            }
            let updatedCount = newStudios.count - addedCount
            
            // Save merged config
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let mergedData = try encoder.encode(merged)
            try mergedData.write(to: studiosConfigURL, options: .atomic)
            
            UserDefaults.standard.set(Date(), forKey: lastCheckKey)
            
            let message: String
            if addedCount > 0 && updatedCount > 0 {
                message = "Database updated! Added \(addedCount) new studio(s), updated \(updatedCount) existing."
            } else if addedCount > 0 {
                message = "Database updated! Added \(addedCount) new studio(s)."
            } else if updatedCount > 0 {
                message = "Database updated! Refreshed \(updatedCount) studio(s)."
            } else {
                message = "Database is already up to date."
            }
            
            return (true, message)
        } catch {
            print("Failed to update database: \(error)")
            return (false, "Failed to update database: \(error.localizedDescription)")
        }
    }
}

/// First-seen history for the read-only job browser. The data is local and
/// independent of the downloaded studios configuration.
actor JobHistoryStore {
    static let shared = JobHistoryStore()

    private struct Entry: Codable {
        let firstSeen: Date
        var lastSeen: Date
    }

    private let fileURL: URL
    private var entries: [String: Entry]

    init(fileURL: URL? = nil) {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("JobUI", isDirectory: true)
        self.fileURL = fileURL ?? base.appendingPathComponent("job-history.json")
        if let data = try? Data(contentsOf: self.fileURL),
           let loaded = try? JSONDecoder().decode([String: Entry].self, from: data) {
            entries = loaded
        } else {
            entries = [:]
        }
    }

    func annotate(_ jobs: [Job], studioID: String, now: Date = Date()) -> [Job] {
        let retention = now.addingTimeInterval(-7 * 86_400)
        entries = entries.filter { $0.value.lastSeen >= retention }
        let annotated = jobs.map { job -> Job in
            let key = "\(studioID)|\(job.link.absoluteString)|\(job.title)"
            let firstSeen = entries[key]?.firstSeen ?? now
            entries[key] = Entry(firstSeen: firstSeen, lastSeen: now)
            return Job(title: job.title, link: job.link, location: job.location,
                       extraLink: job.extraLink, firstSeen: firstSeen)
        }
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(entries)
            try data.write(to: fileURL, options: .atomic)
        } catch {
            print("Could not persist job first-seen history: \(error)")
        }
        return annotated
    }
}
