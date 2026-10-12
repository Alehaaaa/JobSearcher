import Foundation
import Testing
import SwiftSoup
@testable import JobUI

struct ExtractionParityTests {
    @Test func seniorityTitleVariantsAndBoundaries() {
        let examples: [(JobSeniorityLevel, [String])] = [
            (.director, ["Art Director", "VP of Animation", "Directrice créative"]),
            (.lead, ["Lead Animator", "Principal Engineer", "Head of Animation"]),
            (.lead, ["VFX Supervisor", "Sup. Compositing", "Supervising Animator", "Production Manager", "Mgr. Operations", "Gerente de arte"]),
            (.senior, ["Senior Rigger", "Sr. Character Artist", "Sénior Developer"]),
            (.mid, ["Mid-Level Animator", "Intermediate Artist", "Medior Compositor"]),
            (.junior, ["Junior Artist", "Jr. Rigger", "Entry-level Developer"]),
            (.junior, ["Associate Producer", "Assoc. Editor", "Artista asociado"]),
            (.internship, ["Animation Internship", "VFX Trainee", "Stagiaire", "Prácticas de arte"])
        ]
        for (level, titles) in examples {
            for title in titles {
                #expect(JobSeniorityLevel.matches(level, title: title), "Expected \(title) to match \(level)")
                #expect(!JobSeniorityLevel.matches(.unspecified, title: title))
            }
        }
        #expect(JobSeniorityLevel.matches(.senior, title: "Senior Lead Animator"))
        #expect(JobSeniorityLevel.matches(.lead, title: "Senior Lead Animator"))
        #expect(!JobSeniorityLevel.matches(.internship, title: "International Marketing Artist"))
        #expect(!JobSeniorityLevel.matches(.lead, title: "Leadership Development"))
        #expect(JobSeniorityLevel.matches(.unspecified, title: "Lighting Artist"))
        #expect(JobSeniorityLevel.matches(.all, title: "Lighting Artist"))
        #expect(JobSeniorityLevel.allCases.map(\.rawValue) == ["All levels", "Director", "Lead", "Senior", "Mid", "Junior", "Intern", "Unspecified"])
        #expect(JobSeniorityLevel.migratedSelection("Supervisor") == .lead)
        #expect(JobSeniorityLevel.migratedSelection("Associate") == .junior)
        #expect(JobSeniorityLevel.migratedSelection("Mid-level") == .mid)
        let selected = Set<JobSeniorityLevel>([.senior, .junior, .internship])
        #expect(JobSeniorityLevel.selections(from: JobSeniorityLevel.storedSelection(selected)) == selected)
        #expect(JobSeniorityLevel.matchesAny(selected, title: "Junior Animator"))
        #expect(JobSeniorityLevel.matchesAny(selected, title: "Senior Animator"))
        #expect(!JobSeniorityLevel.matchesAny(selected, title: "Director of Animation"))
        #expect(JobSeniorityLevel.matchesAny([], title: "Director of Animation"))
    }

    @Test func seniorityCountsAndCombinedLocationFiltering() {
        let jobs = [
            Job(title: "Senior Lead Animator", link: URL(string: "https://example.com/1")!, location: "London"),
            Job(title: "Junior Artist", link: URL(string: "https://example.com/2")!, location: "Paris"),
            Job(title: "Animation Intern", link: URL(string: "https://example.com/3")!, location: "Remote"),
            Job(title: "Lighting Artist", link: URL(string: "https://example.com/4")!, location: "London")
        ]
        let counts = SeniorityFilterCounts(jobs: jobs)
        #expect(counts.total == 4)
        #expect(counts.levels[.senior] == 1)
        #expect(counts.levels[.lead] == 1)
        #expect(counts.levels[.junior] == 1)
        #expect(counts.levels[.internship] == 1)
        #expect(counts.levels[.unspecified] == 1)
        #expect(jobs.filter { JobLocationRegion.matches(.europe, location: $0.location) && JobSeniorityLevel.matches(.junior, title: $0.title) }.map(\.title) == ["Junior Artist"])
    }

    private func rule(_ json: String) throws -> ScrapingMapValue {
        try JSONDecoder().decode(ScrapingMapValue.self, from: Data(json.utf8))
    }

    @Test func nestedPathsFallbacksConcatenationAndWildcards() {
        let source: [String: Any] = [
            "jobs": [["title": "Animator", "office": ["city": "London"]],
                     ["title": "Rigger", "office": ["city": "Paris"]]],
            "empty": ""
        ]
        let scraper = JobScraper.shared
        #expect(scraper.extractJSON(source, path: "jobs[0].title") as? String == "Animator")
        #expect(scraper.extractJSON(source, path: "missing, jobs[1].title") as? String == "Rigger")
        #expect(scraper.extractJSON(source, path: "jobs[0].title + ' - ' + jobs[0].office.city") as? String == "Animator - London")
        #expect(scraper.extractJSON(source, path: "empty, jobs[0].title") as? String == "Animator")
        #expect((scraper.extractJSON(source, path: "jobs[*].title") as? [String]) == ["Animator", "Rigger"])
        #expect(scraper.extractJSON(source, path: "missing.key") == nil)
    }

    @Test func mappingTransformOrderAndDefaults() throws {
        let scraper = JobScraper.shared
        let transformed = try rule(#"{"split":{"sep":":","index":1},"regex":"([A-Z]+)","replace":{"old":"ART","new":"VFX"},"prefix":"Role: ","suffix":"!"}"#)
        #expect(scraper.finalizeValue("group:ARTIST", config: transformed) == "Role: VFXIST!")
        let missing = try rule(#"{"default":"Remote"}"#)
        #expect(scraper.finalizeValue("", config: missing) == "Remote")
        let noMatch = try rule(#"{"regex":"^XYZ$","default":"Unknown"}"#)
        #expect(scraper.finalizeValue("ABC", config: noMatch) == "Unknown")
        let listReplacement = try rule(#"{"replace":[{"old":"-","new":" "},{"old":"_","new":" "}],"title_case":true}"#)
        #expect(scraper.finalizeValue("senior-rig_artist", config: listReplacement) == "Senior Rig Artist")
    }

    @Test func htmlLocationDefaultsDoNotReadJobTileText() throws {
        let scraper = JobScraper.shared
        let document = try SwiftSoup.parse("<article><h2>3D Animator</h2><p>Senior 3D Animation Read More</p></article>")
        let tile = try #require(document.select("article").first())
        let mapping = ["location": try rule(#"{"default":"North Lakes, Brisbane, Australia"}"#)]
        let extracted = scraper.applyMappingHTML(to: "location", element: tile, mapping: mapping, rootURL: URL(string: "https://pixelzoo.com.au/careers")!)
        #expect(extracted == "North Lakes, Brisbane, Australia")

        let explicit = ["location": try rule(#"{"selector":"p","default":"Unknown"}"#)]
        #expect(scraper.applyMappingHTML(to: "location", element: tile, mapping: explicit, rootURL: URL(string: "https://example.com")!) == "Senior 3D Animation Read More")
    }

    @Test func locationRegionFiltersIncludeMultipleOfficesWithoutGuessing() {
        #expect(JobLocationRegion.matches(.oceania, location: "North Lakes, Brisbane, Australia"))
        #expect(JobLocationRegion.matches(.europe, location: "London / Vancouver"))
        #expect(JobLocationRegion.matches(.northAmerica, location: "London / Vancouver"))
        #expect(!JobLocationRegion.matches(.asia, location: "London / Vancouver"))
        #expect(JobLocationRegion.matches(.remote, location: "Remote - Worldwide"))
        #expect(!JobLocationRegion.matches(.remote, location: "London/Hybrid"))
        #expect(JobLocationRegion.matches(.unknown, location: "2 Locations"))
        #expect(JobLocationRegion.matches(.unknown, location: nil))
        #expect(!JobLocationRegion.matches(.europe, location: nil))
        #expect(JobLocationRegion.matches(.all, location: nil))
        #expect(JobLocationRegion.countries(for: "London / Vancouver") == Set(["United Kingdom", "Canada"]))
        #expect(JobLocationRegion.matchesCountry("Spain", location: "Madrid, España"))
        #expect(JobLocationRegion.matchesCountry("Australia", location: "North Lakes, Brisbane, Australia"))
        #expect(!JobLocationRegion.matchesCountry("Canada", location: "North Lakes, Brisbane, Australia"))
        #expect(JobLocationRegion.countries(for: "2 Locations").isEmpty)
        #expect(JobLocationRegion.matchesCountry("", location: nil))
    }

    @Test func locationCountsTreatMultiOfficePostingsAsOneResultPerChoice() {
        let jobs = [
            Job(title: "Animator", link: URL(string: "https://example.com/1")!, location: "London / Vancouver"),
            Job(title: "Rigger", link: URL(string: "https://example.com/2")!, location: "Remote"),
            Job(title: "Artist", link: URL(string: "https://example.com/3")!, location: nil)
        ]
        let counts = LocationFilterCounts(jobs: jobs)
        #expect(counts.total == 3)
        #expect(counts.regions[.europe] == 1)
        #expect(counts.regions[.northAmerica] == 1)
        #expect(counts.regions[.remote] == 1)
        #expect(counts.regions[.unknown] == 1)
        #expect(counts.countries["United Kingdom"] == 1)
        #expect(counts.countries["Canada"] == 1)
        #expect(counts.countries["United States"] == nil)
    }

    @Test func multipleLocationChoicesMatchAnySelectedRegionOrCountry() {
        let regions: Set<JobLocationRegion> = [.europe, .remote]
        let countries: Set<String> = ["Canada"]
        #expect(JobLocationRegion.matchesAny(regions: regions, countries: countries, location: "London"))
        #expect(JobLocationRegion.matchesAny(regions: regions, countries: countries, location: "Fully Remote"))
        #expect(JobLocationRegion.matchesAny(regions: regions, countries: countries, location: "Vancouver"))
        #expect(!JobLocationRegion.matchesAny(regions: regions, countries: countries, location: "Tokyo"))
        #expect(JobLocationRegion.matchesAny(regions: [], countries: [], location: nil))
        #expect(JobLocationRegion.selectedRegions(from: JobLocationRegion.storedRegions(regions)) == regions)
        #expect(JobLocationRegion.selectedCountries(from: "Canada|Spain") == Set(["Canada", "Spain"]))
    }

    @Test func configuredJSONExtractionKeepsProviderOrderAndFields() async throws {
        let configURL = try #require(Bundle.main.url(forResource: "studios", withExtension: "json"))
        let studios = try JSONDecoder().decode([Studio].self, from: Data(contentsOf: configURL))
        let pixar = try #require(studios.first { $0.id == "pixar" })
        let source: [String: Any] = ["jobPostings": [
            ["title": "Z Animator", "externalPath": "/job/a", "locationsText": "Emeryville"],
            ["title": "A Rigger", "externalPath": "/job/b", "locationsText": "Vancouver"]
        ]]
        let jobs = try await JobScraper.shared.parseJSONItems(source, for: pixar, from: pixar.careersUrl[0])
        #expect(jobs.map(\.title) == ["Z Animator", "A Rigger"])
        #expect(jobs.map(\.location) == ["Emeryville", "Vancouver"])
        #expect(jobs[0].link.path.hasSuffix("/job/a"))
        #expect(jobs[1].link.path.hasSuffix("/job/b"))
    }

    @Test func fixedLiveLocationRuleFamilies() async throws {
        let configURL = try #require(Bundle.main.url(forResource: "studios", withExtension: "json"))
        let studios = try JSONDecoder().decode([Studio].self, from: Data(contentsOf: configURL))
        let scraper = JobScraper.shared
        let teamtailor = try SwiftSoup.parse("<li><a>Animator</a><div class='text-md mt-4'><span>Art</span><span>·</span><span class='inline-flex items-center'>Fully Remote</span></div></li>")
        let row = try #require(teamtailor.select("li").first())
        for id in ["airshipinteractive", "hampa"] {
            let studio = try #require(studios.first { $0.id == id })
            #expect(scraper.applyMappingHTML(to: "location", element: row,
                mapping: studio.scraping?.map ?? [:], rootURL: studio.careersUrl[0]) == "Fully Remote")
        }

        let digitalDomain = try #require(studios.first { $0.id == "digitaldomain" })
        let codeRule = try #require(digitalDomain.scraping?.map?["location"])
        #expect(scraper.finalizeValue("VC", config: codeRule) == "Vancouver, Canada")
        #expect(scraper.finalizeValue("PL", config: codeRule) == "Playa Vista, United States")
        #expect(scraper.finalizeValue("MR", config: codeRule) == "Montreal, Canada")

        let ubisoft = try #require(studios.first { $0.id == "ubisoft" })
        let fixture: [String: Any] = ["results": [["hits": [
            ["title": "Artist", "link": "https://example.com/1", "city": "Bucharest", "countryCode": "ro"],
            ["title": "Animator", "link": "https://example.com/2", "city": "Barcelona", "countryCode": "es"]
        ]]]]
        let jobs = try await scraper.parseJSONItems(fixture, for: ubisoft, from: ubisoft.careersUrl[0])
        #expect(jobs.map(\.location) == ["Bucharest, Romania", "Barcelona, Spain"])
        #expect(JobLocationRegion.matches(.europe, location: jobs[0].location))
        #expect(JobLocationRegion.matchesCountry("Romania", location: jobs[0].location))
    }

    @Test func legacyDownloadedLocationsMigrateWithoutOverridingNewRules() throws {
        let source = #"[{"id":"hampa","scraping":{"map":{"location":{"selector":"span.text-base span","index":"2"}}}},{"id":"airshipinteractive","scraping":{"map":{"location":{"selector":".custom-new-source"}}}}]"#
        let migrated = ConfigManager.shared.applyingBundledRuleMigrations(Data(source.utf8))
        let items = try #require(JSONSerialization.jsonObject(with: migrated) as? [[String: Any]])
        let hampa = try #require(((items[0]["scraping"] as? [String: Any])?["map"] as? [String: Any])?["location"] as? [String: Any])
        let airship = try #require(((items[1]["scraping"] as? [String: Any])?["map"] as? [String: Any])?["location"] as? [String: Any])
        #expect(hampa["selector"] as? String == "div.mt-4 span.inline-flex")
        #expect(airship["selector"] as? String == ".custom-new-source")
    }

    @Test func firstSeenHistorySurvivesRefreshAndRestart() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("history.json")
        let job = Job(title: "Animator", link: URL(string: "https://example.com/job/1")!, location: "Paris")
        let firstDate = Date(timeIntervalSince1970: 1_700_000_000)
        let history = JobHistoryStore(fileURL: path)
        let first = await history.annotate([job], studioID: "studio", now: firstDate)
        #expect(first.first?.firstSeen == firstDate)

        let restarted = JobHistoryStore(fileURL: path)
        let second = await restarted.annotate([job], studioID: "studio", now: firstDate.addingTimeInterval(3_600))
        #expect(second.first?.firstSeen == firstDate)

        let later = await restarted.annotate([job], studioID: "studio", now: firstDate.addingTimeInterval(9 * 86_400))
        #expect(later.first?.firstSeen == firstDate.addingTimeInterval(9 * 86_400))
    }
}
