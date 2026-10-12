import SwiftUI
import Combine
import UniformTypeIdentifiers

enum JobLocationRegion: String, CaseIterable, Identifiable {
    case all = "All locations"
    case europe = "Europe"
    case northAmerica = "North America"
    case southAmerica = "South America"
    case asia = "Asia"
    case africa = "Africa"
    case oceania = "Oceania"
    case remote = "Remote"
    case unknown = "Unspecified"

    var id: String { rawValue }

    // Country and city labels actually used by the configured job feeds.
    // Unrecognized locations remain unspecified rather than being assigned a guessed continent.
    private static let placeNames: [JobLocationRegion: [String]] = [
        .europe: "europe|europa|uk|united kingdom|england|scotland|ireland|france|paris|bordeaux|london|manchester|germany|berlin|munich|münchen|frankfurt|spain|españa|madrid|barcelona|tenerife|poland|warsaw|wroclaw|wrocław|czechia|czech republic|prague|slovakia|bratislava|italy|rome|portugal|netherlands|amsterdam|belgium|sweden|stockholm|norway|denmark|finland|austria|switzerland|zurich|zürich|luxembourg|contern|montpellier|kilkenny|dublin|newcastle upon tyne|bulgaria|sofia|romania|bucharest|ukraine|kyiv|odesa".components(separatedBy: "|"),
        .northAmerica: "united states|usa|us|canada|california|los angeles|burbank|glendale|san francisco|pasadena|universal city|new york|boston|atlanta|georgia|oregon|portland|hillsboro|vancouver|toronto|montreal|montréal|quebec|québec|ottawa|british columbia|bc|ontario|montpelier|vermont|mexico|méxico|mexico city|north america".components(separatedBy: "|"),
        .southAmerica: "brazil|brasil|argentina|chile|colombia|peru|perú|uruguay|paraguay|ecuador|venezuela|bolivia|south america|latin america".components(separatedBy: "|"),
        .asia: "asia|japan|tokyo|india|mumbai|bengaluru|bangalore|hyderabad|china|shanghai|beijing|hong kong|korea|seoul|singapore|taiwan|thailand|vietnam|philippines|malaysia|indonesia|united arab emirates|dubai|uae|israel|turkey|türkiye".components(separatedBy: "|"),
        .africa: "africa|south africa|cape town|johannesburg|morocco|egypt|nigeria|kenya|mauritius|saint pierre".components(separatedBy: "|"),
        .oceania: "oceania|australia|sydney|melbourne|brisbane|north lakes|adelaide|new zealand|wellington|auckland".components(separatedBy: "|")
    ]

    private static let patterns: [JobLocationRegion: NSRegularExpression] = {
        var result: [JobLocationRegion: NSRegularExpression] = [:]
        for (region, places) in placeNames {
            let terms = places.map { NSRegularExpression.escapedPattern(for: $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)) }
            result[region] = try? NSRegularExpression(pattern: "(?<![\\p{L}])(?:" + terms.joined(separator: "|") + ")(?![\\p{L}])")
        }
        result[.remote] = try? NSRegularExpression(pattern: "(?<![\\p{L}])(?:remote|teletrabajo|work from home|anywhere)(?![\\p{L}])")
        return result
    }()

    // A job may mention multiple countries; preserve every match so a posting
    // for London/Vancouver appears in both country filters.
    private static let countryAliases: [String: String] = [
        "Australia": "australia|sydney|melbourne|brisbane|north lakes|adelaide",
        "Austria": "austria|vienna|wien",
        "Belgium": "belgium|brussels",
        "Brazil": "brazil|brasil|são paulo|sao paulo",
        "Bulgaria": "bulgaria|sofia",
        "Canada": "canada|vancouver|toronto|montreal|montréal|quebec|québec|ottawa|british columbia|ontario",
        "China": "china|shanghai|beijing|hong kong",
        "Czechia": "czechia|czech republic|prague",
        "Denmark": "denmark|copenhagen",
        "France": "france|paris|bordeaux|montpellier|lyon",
        "Germany": "germany|berlin|munich|münchen|frankfurt|hamburg",
        "India": "india|mumbai|bengaluru|bangalore|hyderabad|pune",
        "Ireland": "ireland|dublin|kilkenny",
        "Italy": "italy|rome|milan",
        "Japan": "japan|tokyo|osaka",
        "Luxembourg": "luxembourg|contern",
        "Mauritius": "mauritius|saint pierre",
        "Mexico": "mexico|méxico|mexico city",
        "Netherlands": "netherlands|amsterdam",
        "New Zealand": "new zealand|wellington|auckland",
        "Poland": "poland|warsaw|wroclaw|wrocław",
        "Portugal": "portugal|lisbon|porto",
        "Romania": "romania|bucharest",
        "Slovakia": "slovakia|bratislava",
        "South Korea": "south korea|korea|seoul",
        "Spain": "spain|españa|madrid|barcelona|tenerife|valencia",
        "Sweden": "sweden|stockholm",
        "Switzerland": "switzerland|zurich|zürich",
        "United Kingdom": "united kingdom|england|scotland|wales|uk|london|manchester|newcastle upon tyne|bristol",
        "United States": "united states|usa|us|california|los angeles|burbank|glendale|san francisco|pasadena|universal city|new york|boston|atlanta|oregon|portland|hillsboro|chicago|emeryville|montpelier|vermont",
        "United Arab Emirates": "united arab emirates|uae|dubai",
        "Ukraine": "ukraine|kyiv|odesa"
    ]

    private static let countryPatterns: [String: NSRegularExpression] = {
        countryAliases.compactMapValues { aliases in
            let terms = aliases.components(separatedBy: "|").map {
                NSRegularExpression.escapedPattern(for: $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current))
            }
            return try? NSRegularExpression(pattern: "(?<![\\p{L}])(?:" + terms.joined(separator: "|") + ")(?![\\p{L}])")
        }
    }()

    static func countries(for location: String?) -> Set<String> {
        guard let location, !location.isEmpty else { return [] }
        let normalized = location.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        let range = NSRange(normalized.startIndex..., in: normalized)
        return Set(countryPatterns.compactMap { name, pattern in
            pattern.firstMatch(in: normalized, range: range) != nil ? name : nil
        })
    }

    static func matchesCountry(_ country: String, location: String?) -> Bool {
        guard !country.isEmpty else { return true }
        guard let location, let pattern = countryPatterns[country] else { return false }
        let normalized = location.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        return pattern.firstMatch(in: normalized, range: NSRange(normalized.startIndex..., in: normalized)) != nil
    }

    private static func isMatch(_ region: JobLocationRegion, _ value: String) -> Bool {
        guard let expression = patterns[region] else { return false }
        return expression.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }

    static func matches(_ selection: JobLocationRegion, location: String?) -> Bool {
        if selection == .all { return true }
        let value = (location ?? "").folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        if selection == .unknown {
            return !patterns.keys.contains { isMatch($0, value) }
        }
        return isMatch(selection, value)
    }

    static func selectedRegions(from stored: String) -> Set<JobLocationRegion> {
        Set(stored.split(separator: "|").compactMap { JobLocationRegion(rawValue: String($0)) }.filter { $0 != .all })
    }

    static func storedRegions(_ selected: Set<JobLocationRegion>) -> String {
        allCases.filter { selected.contains($0) && $0 != .all }.map(\.rawValue).joined(separator: "|")
    }

    static func selectedCountries(from stored: String) -> Set<String> {
        Set(stored.split(separator: "|").map(String.init))
    }

    static func matchesAny(regions: Set<JobLocationRegion>, countries: Set<String>, location: String?) -> Bool {
        if regions.isEmpty && countries.isEmpty { return true }
        return regions.contains { matches($0, location: location) } ||
            countries.contains { matchesCountry($0, location: location) }
    }
}

struct LocationFilterCounts {
    let total: Int
    let regions: [JobLocationRegion: Int]
    let countries: [String: Int]

    init(jobs: [Job]) {
        total = jobs.count
        var regionCounts: [JobLocationRegion: Int] = [:]
        var countryCounts: [String: Int] = [:]
        for job in jobs {
            for region in JobLocationRegion.allCases where region != .all {
                if JobLocationRegion.matches(region, location: job.location) {
                    regionCounts[region, default: 0] += 1
                }
            }
            for country in JobLocationRegion.countries(for: job.location) {
                countryCounts[country, default: 0] += 1
            }
        }
        regions = regionCounts
        countries = countryCounts
    }

    var signature: String {
        let regionParts = JobLocationRegion.allCases.map { "\($0.rawValue):\(regions[$0, default: 0])" }
        let countryParts = countries.keys.sorted().map { "\($0):\(countries[$0, default: 0])" }
        return (["total:\(total)"] + regionParts + countryParts).joined(separator: "|")
    }
}

enum JobSeniorityLevel: String, CaseIterable, Identifiable {
    case all = "All levels"
    case director = "Director"
    case lead = "Lead"
    case senior = "Senior"
    case mid = "Mid"
    case junior = "Junior"
    case internship = "Intern"
    case unspecified = "Unspecified"

    var id: String { rawValue }

    // Only explicit title markers count. Some titles legitimately have multiple
    // levels (for example, "Senior Lead Animator").
    private static let terms: [JobSeniorityLevel: String] = [
        .director: #"director|directora|directeur|directrice|vp|vice[ -]president|chief|cto|ceo|cfo|coo|executive director"#,
        .lead: #"lead|leader|team[ -]lead|head of|principal|lider|líder|tech lead|supervisor|supervisora|supervising|superviseur|superviseuse|supv?\.?|manager|management|mgr\.?|responsable|gerente"#,
        .senior: #"senior|sénior|sr\.?|sen\.?|staff|expert"#,
        .mid: #"mid(?:[ -]level)?|midlevel|middle|intermediate|medior|midsenior"#,
        .junior: #"junior|jr\.?|entry[ -]level|graduate|débutant|debutant|early career|associate|associated|assoc\.?|asociad[oa]|associé|associée"#,
        .internship: #"intern|internship|internships|intern(?:e)?|trainee|apprentice|apprenticeship|stagiaire|stage|prácticas|practicas|becari[oa]|working student|placement"#
    ]

    private static let patterns: [JobSeniorityLevel: NSRegularExpression] = {
        terms.compactMapValues { term in
            try? NSRegularExpression(pattern: #"(?<![\p{L}])(?:"# + term + #")(?![\p{L}])"#,
                                     options: [.caseInsensitive])
        }
    }()

    static func matches(_ level: JobSeniorityLevel, title: String) -> Bool {
        if level == .all { return true }
        let normalized = title.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        let range = NSRange(normalized.startIndex..., in: normalized)
        if level == .unspecified {
            return !patterns.values.contains { $0.firstMatch(in: normalized, range: range) != nil }
        }
        return patterns[level]?.firstMatch(in: normalized, range: range) != nil
    }

    static func migratedSelection(_ saved: String) -> JobSeniorityLevel {
        if let level = JobSeniorityLevel(rawValue: saved) { return level }
        switch saved {
        case "Director / Executive": return .director
        case "Lead / Principal", "Supervisor", "Manager": return .lead
        case "Mid-level": return .mid
        case "Junior / Entry", "Associate": return .junior
        case "Internship / Trainee": return .internship
        default: return .all
        }
    }

    static func selections(from stored: String) -> Set<JobSeniorityLevel> {
        let values = stored.split(separator: "|").map(String.init)
        let selected = Set(values.map(migratedSelection).filter { $0 != .all })
        return selected
    }

    static func storedSelection(_ levels: Set<JobSeniorityLevel>) -> String {
        allCases.filter { $0 != .all && levels.contains($0) }
            .map(\.rawValue).joined(separator: "|")
    }

    static func matchesAny(_ levels: Set<JobSeniorityLevel>, title: String) -> Bool {
        levels.isEmpty || levels.contains { matches($0, title: title) }
    }
}

struct SeniorityFilterCounts {
    let total: Int
    let levels: [JobSeniorityLevel: Int]

    init(jobs: [Job]) {
        total = jobs.count
        var counts: [JobSeniorityLevel: Int] = [:]
        for job in jobs {
            for level in JobSeniorityLevel.allCases where level != .all {
                if JobSeniorityLevel.matches(level, title: job.title) {
                    counts[level, default: 0] += 1
                }
            }
        }
        levels = counts
    }

    var signature: String {
        (["total:\(total)"] + JobSeniorityLevel.allCases.map { "\($0.rawValue):\(levels[$0, default: 0])" })
            .joined(separator: "|")
    }
}

// MARK: - View Model
@MainActor
class StudioViewModel: ObservableObject {
    @Published var jobs: [Job] = []
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published private(set) var hasFetched = false

    let studio: Studio
    init(studio: Studio) {
        self.studio = studio
    }

    func fetchJobs(isRefresh: Bool) async {
        guard isRefresh, !isLoading else { return }
        isLoading = true
        
        do {
            let result = try await JobScraper.shared.fetchJobs(for: studio)
            var unique: [String: Job] = [:]
            for job in result.jobs {
                let key = "\(job.title.lowercased())|\(job.link.absoluteString.lowercased())"
                unique[key] = job
            }
            let sorted = unique.values.sorted {
                $0.title.localizedStandardCompare($1.title) == .orderedAscending
            }
            jobs = await JobHistoryStore.shared.annotate(sorted, studioID: studio.id)
            errorMessage = nil
        } catch {
            self.errorMessage = error.localizedDescription
            print("Error fetching jobs for \(studio.name): \(error)")
        }
        hasFetched = true
        isLoading = false
    }
    
    func filteredJobs(filterText: String, regions: Set<JobLocationRegion> = [], countries: Set<String> = [], levels: Set<JobSeniorityLevel> = []) -> [Job] {
        guard !filterText.isEmpty || !regions.isEmpty || !countries.isEmpty || !levels.isEmpty else { return jobs }
        // Match the Python app's regex search; invalid expressions become literal searches.
        let regex = try? NSRegularExpression(pattern: filterText, options: [.caseInsensitive])
        return jobs.filter {
            guard JobLocationRegion.matchesAny(regions: regions, countries: countries, location: $0.location) else { return false }
            guard JobSeniorityLevel.matchesAny(levels, title: $0.title) else { return false }
            if filterText.isEmpty { return true }
            let haystack = $0.title + " " + ($0.location ?? "")
            if let regex {
                return regex.firstMatch(in: haystack, range: NSRange(haystack.startIndex..., in: haystack)) != nil
            }
            return haystack.range(of: filterText, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
    }
}

// MARK: - Main Content View
struct ContentView: View {
    @EnvironmentObject var appState: AppState
    @State private var studios: [Studio] = []
    @AppStorage("jobFilterText") private var filterText = ""
    @AppStorage("jobLocationRegions") private var locationRegions = ""
    @AppStorage("jobLocationCountries") private var locationCountries = ""
    @AppStorage("jobSeniorityLevels") private var seniorityLevels = ""
    @State private var studioSearchText = ""
    @State private var disabledStudioIDs: Set<String> = []
    @State private var navigationVisibility = NavigationSplitViewVisibility.all
    @State private var viewModels: [String: StudioViewModel] = [:]
    @AppStorage("hideEmptyStudios") private var hideEmpty = true
    @AppStorage("autoRefreshSeconds") private var autoRefreshSeconds = 0
    @State private var scrollToStudioID: String? = nil
    
    @FocusState private var isJobFilterFocused: Bool

    private var filteredStudios: [Studio] {
        if studioSearchText.isEmpty {
            return studios
        }
        return studios.filter {
            $0.name.range(of: studioSearchText, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
    }
    
    private var visibleStudios: [Studio] {
        studios.filter { !disabledStudioIDs.contains($0.id) }
    }
    
    private var sidebarView: some View {
        VStack {
            ClearableTextField(placeholder: "Search studios...", text: $studioSearchText)
                .padding([.horizontal, .top])

            List {
                ForEach(filteredStudios) { studio in
                    studioToggleRow(for: studio)
                }
                .onMove(perform: studioSearchText.isEmpty ? moveStudioInSidebar : nil)
            }
            .scrollContentBackground(.hidden)
            .listStyle(.sidebar)
        }
        .padding(8)
        .navigationSplitViewColumnWidth(250)
        .navigationTitle("Studios")
        .background(Material.ultraThinMaterial)
    }
    
    private func studioToggleRow(for studio: Studio) -> some View {
        HStack {
            Image(systemName: "line.3.horizontal")
                .foregroundColor(.secondary)
            Toggle(isOn: Binding(
                get: { !disabledStudioIDs.contains(studio.id) },
                set: { isEnabled in
                    if isEnabled {
                        disabledStudioIDs.remove(studio.id)
                    } else {
                        disabledStudioIDs.insert(studio.id)
                    }
                    updateViewModels()
                    saveDisabledStudios()
                }
            )) {
                Text(studio.name)
                    .font(.headline)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        if !disabledStudioIDs.contains(studio.id) {
                            scrollToStudioID = studio.id
                        }
                    }
                    .pointingCursor()
            }
        }
        .listRowBackground(Color.clear)
    }

    var body: some View {
        NavigationSplitView(columnVisibility: $navigationVisibility) {
            sidebarView
        } detail: {
            StudioGridView(
                studios: $studios,
                visibleStudios: visibleStudios,
                viewModels: viewModels,
                filterText: $filterText,
                locationRegions: $locationRegions,
                locationCountries: $locationCountries,
                seniorityLevels: $seniorityLevels,
                hideEmpty: $hideEmpty,
                autoRefreshSeconds: $autoRefreshSeconds,
                scrollToID: $scrollToStudioID,
                isJobFilterFocused: $isJobFilterFocused,
                reloadAllAction: reloadAll,
                saveOrderAction: saveStudiosOrder
            )
            .background(Material.ultraThinMaterial)
        }
        .onAppear {
            if locationRegions.isEmpty, let old = UserDefaults.standard.string(forKey: "jobLocationRegion") {
                locationRegions = JobLocationRegion.storedRegions(JobLocationRegion.selectedRegions(from: old))
                UserDefaults.standard.removeObject(forKey: "jobLocationRegion")
            }
            if locationCountries.isEmpty, let old = UserDefaults.standard.string(forKey: "jobLocationCountry"), !old.isEmpty {
                locationCountries = old
                UserDefaults.standard.removeObject(forKey: "jobLocationCountry")
            }
            if seniorityLevels.isEmpty, let old = UserDefaults.standard.string(forKey: "jobSeniorityLevel") {
                seniorityLevels = JobSeniorityLevel.storedSelection([JobSeniorityLevel.migratedSelection(old)])
                UserDefaults.standard.removeObject(forKey: "jobSeniorityLevel")
            }
            loadData()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                isJobFilterFocused = true
            }
        }
        .task(id: autoRefreshSeconds) {
            guard autoRefreshSeconds > 0 else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(autoRefreshSeconds) * 1_000_000_000)
                guard !Task.isCancelled else { return }
                await reloadAll()
            }
        }
        .onChange(of: appState.disabledStudioIDs) { _, newValue in
            disabledStudioIDs = newValue
            updateViewModels()
        }
        .onChange(of: disabledStudioIDs) { _, newValue in
            appState.disabledStudioIDs = newValue
            saveDisabledStudios()
        }
        .sheet(isPresented: $appState.showAbout) {
            AboutView()
        }
        .alert("Database Update", isPresented: $appState.showUpdateAlert) {
            Button("OK") {
                if appState.updateMessage?.contains("updated") == true {
                    loadData()
                }
            }
        } message: {
            Text(appState.updateMessage ?? "")
        }
        .alert("Refetch All Logos", isPresented: $appState.showLogoRefreshAlert) {
            Button("Cancel", role: .cancel) { }
            Button("Refetch", role: .destructive) {
                Task {
                    await appState.refetchAllLogos()
                }
            }
        } message: {
            Text("This will clear all cached studio logos and download them again. Are you sure?")
        }
        .onChange(of: appState.studios) { _, newValue in
            studios = newValue
            updateViewModels()
        }
        .overlay {
            if appState.isUpdatingDatabase {
                ZStack {
                    Color.black.opacity(0.4)
                        .ignoresSafeArea()
                    
                    VStack(spacing: 20) {
                        ProgressView()
                            .scaleEffect(1.5)
                        
                        Text("Updating Studios Database...")
                            .font(.headline)
                        
                        Text("Fetching latest studio configurations from GitHub")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    }
                    .padding(40)
                    .background(.ultraThinMaterial)
                    .cornerRadius(20)
                    .overlay(
                        RoundedRectangle(cornerRadius: 20)
                            .stroke(Color.white.opacity(0.2), lineWidth: 1)
                    )
                    .shadow(radius: 20)
                }
                .transition(.opacity)
            }
        }
        .animation(.default, value: appState.isUpdatingDatabase)
    }

    // MARK: Data Helpers
    private func loadData() {
        // Initial load from whatever we have (App Support or Bundle)
        self.studios = ConfigManager.shared.loadStudios()
        appState.studios = self.studios
        loadDisabledStudios()
        disabledStudioIDs = appState.disabledStudioIDs
        updateViewModels()
        
        // Force an update check every time we load data
        Task {
            let updated = await ConfigManager.shared.updateConfigIfNeeded()
            if updated {
                await MainActor.run {
                    self.studios = ConfigManager.shared.loadStudios()
                    appState.studios = self.studios
                    updateViewModels()
                }
            }
        }
    }

    private func loadDisabledStudios() {
        if let savedIDs = UserDefaults.standard.stringArray(forKey: "disabledStudioIDs") {
            self.disabledStudioIDs = Set(savedIDs)
        }
    }

    private func saveStudiosOrder() {
        let orderedIDs = studios.map { $0.id }
        UserDefaults.standard.set(orderedIDs, forKey: "studioOrder")
    }
    
    private func saveDisabledStudios() {
        UserDefaults.standard.set(Array(disabledStudioIDs), forKey: "disabledStudioIDs")
    }
    
    private func updateViewModels() {
        let visibleIDs = Set(studios.filter { !disabledStudioIDs.contains($0.id) }.map { $0.id })
        var needsInitialFetch = false
        
        // Remove view models for studios that are no longer visible
        for id in viewModels.keys {
            if !visibleIDs.contains(id) {
                viewModels.removeValue(forKey: id)
            }
        }
        
        // Replace models when a downloaded studio config changes its extraction rules.
        for studio in studios where visibleIDs.contains(studio.id) {
            if let current = viewModels[studio.id],
               current.studio.name == studio.name,
               current.studio.careersUrl == studio.careersUrl,
               current.studio.logoUrl == studio.logoUrl,
               current.studio.website == studio.website,
               current.studio.scraping == studio.scraping {
                continue
            }
            viewModels[studio.id] = StudioViewModel(studio: studio)
            needsInitialFetch = true
        }
        if needsInitialFetch {
            Task { await loadMissing() }
        }
    }

    private func loadMissing() async {
        let models = visibleStudios.compactMap { viewModels[$0.id] }.filter { !$0.hasFetched }
        for start in stride(from: 0, to: models.count, by: 8) {
            await withTaskGroup(of: Void.self) { group in
                for model in models[start..<min(start + 8, models.count)] {
                    group.addTask { await model.fetchJobs(isRefresh: true) }
                }
            }
        }
    }
    
    private func reloadAll() async {
        let models = visibleStudios.compactMap { viewModels[$0.id] }
        // Bound simultaneous requests so refreshing many studios stays responsive.
        for start in stride(from: 0, to: models.count, by: 8) {
            await withTaskGroup(of: Void.self) { group in
                for model in models[start..<min(start + 8, models.count)] {
                    group.addTask { await model.fetchJobs(isRefresh: true) }
                }
            }
        }
    }
    
    private func moveStudioInSidebar(from source: IndexSet, to destination: Int) {
        studios.move(fromOffsets: source, toOffset: destination)
        saveStudiosOrder()
    }
}

// MARK: - Grid View
struct StudioGridView: View {
    @Binding var studios: [Studio]
    let visibleStudios: [Studio]
    let viewModels: [String: StudioViewModel]
    @Binding var filterText: String
    @Binding var locationRegions: String
    @Binding var locationCountries: String
    @Binding var seniorityLevels: String
    @Binding var hideEmpty: Bool
    @Binding var autoRefreshSeconds: Int
    @Binding var scrollToID: String?
    var isJobFilterFocused: FocusState<Bool>.Binding
    let reloadAllAction: () async -> Void
    let saveOrderAction: () -> Void
    @State private var updateVersion = 0
    @State private var lastGridSignature: String = ""

    private var hasActiveLocationFilters: Bool {
        !selectedRegions.isEmpty || !selectedCountries.isEmpty
    }

    private var locationFilterDescription: String {
        let filters = selectedRegions.map(\.rawValue) + Array(selectedCountries)
        return filters.isEmpty ? "All locations" : "Filtering: " + filters.joined(separator: " · ")
    }

    private var selectedRegions: Set<JobLocationRegion> {
        JobLocationRegion.selectedRegions(from: locationRegions)
    }

    private var selectedCountries: Set<String> {
        JobLocationRegion.selectedCountries(from: locationCountries)
    }

    private func toggleRegion(_ region: JobLocationRegion, enabled: Bool) {
        var values = selectedRegions
        if enabled { values.insert(region) } else { values.remove(region) }
        locationRegions = JobLocationRegion.storedRegions(values)
    }

    private func toggleCountry(_ country: String, enabled: Bool) {
        var values = selectedCountries
        if enabled { values.insert(country) } else { values.remove(country) }
        locationCountries = values.sorted().joined(separator: "|")
    }

    private var locationCounts: LocationFilterCounts {
        let matching = visibleStudios.compactMap { viewModels[$0.id] }
            .filter { $0.errorMessage == nil }
            .flatMap { $0.filteredJobs(filterText: filterText, levels: selectedLevels) }
        return LocationFilterCounts(jobs: matching)
    }

    private var selectedLevels: Set<JobSeniorityLevel> {
        JobSeniorityLevel.selections(from: seniorityLevels)
    }

    private var autoRefreshLabel: String {
        switch autoRefreshSeconds {
        case 10: return "10s"
        case 30: return "30s"
        case 60: return "1m"
        case 300: return "5m"
        case 600: return "10m"
        case 3600: return "1h"
        default: return autoRefreshSeconds > 0 ? "\(autoRefreshSeconds)s" : "Off"
        }
    }

    private func toggleLevel(_ level: JobSeniorityLevel) {
        var values = selectedLevels
        if values.contains(level) { values.remove(level) }
        else { values.insert(level) }
        seniorityLevels = JobSeniorityLevel.storedSelection(values)
    }

    private var seniorityCounts: SeniorityFilterCounts {
        let matching = visibleStudios.compactMap { viewModels[$0.id] }
            .filter { $0.errorMessage == nil }
            .flatMap { $0.filteredJobs(filterText: filterText, regions: selectedRegions, countries: selectedCountries) }
        return SeniorityFilterCounts(jobs: matching)
    }

    private var displayedStudios: [Studio] {
        visibleStudios.filter { studio in
            guard let viewModel = viewModels[studio.id] else { return false }
            guard hideEmpty else { return true }
            return viewModel.errorMessage == nil &&
                !viewModel.filteredJobs(filterText: filterText, regions: selectedRegions, countries: selectedCountries, levels: selectedLevels).isEmpty
        }
    }

    private var isWaitingForResults: Bool {
        hideEmpty && visibleStudios.contains { studio in
            guard let model = viewModels[studio.id] else { return false }
            return !model.hasFetched || model.isLoading
        }
    }

    var body: some View {
        let _ = updateVersion
        let counts = locationCounts
        let levelCounts = seniorityCounts
        VStack {
            if visibleStudios.isEmpty {
                ContentUnavailableView(
                    "No studios enabled",
                    systemImage: "building.2.crop.circle",
                    description: Text("Enable studios in the sidebar to see their open positions.")
                )
            } else if displayedStudios.isEmpty {
                if isWaitingForResults {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("Checking studios for open positions…")
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    VStack(spacing: 12) {
                        ContentUnavailableView(
                            "No matching positions",
                            systemImage: "line.3.horizontal.decrease.circle",
                            description: Text("No enabled studios have positions matching your search.")
                        )
                        Button("Show all studios") { hideEmpty = false }
                            .buttonStyle(.bordered)
                    }
                }
            } else {
                let columns = [GridItem(.adaptive(minimum: 300))]
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVGrid(columns: columns, spacing: 16) {
                            ForEach(displayedStudios) { studio in
                                if let viewModel = viewModels[studio.id] {
                                    StudioColumnView(viewModel: viewModel, filterText: $filterText, locationRegions: $locationRegions, locationCountries: $locationCountries, seniorityLevels: $seniorityLevels)
                                        .id(studio.id)
                                }
                            }
                        }
                        .padding()
                    }
                    .onChange(of: scrollToID) { _, newValue in
                        if let id = newValue {
                            withAnimation {
                                proxy.scrollTo(id, anchor: .top)
                            }
                            // Reset state after scrolling
                            scrollToID = nil
                        }
                    }
                }
            }
        }
        .navigationTitle("Job Browser")
        .searchable(text: $filterText, placement: .toolbar, prompt: "Search jobs or locations")
        .searchFocused(isJobFilterFocused)
        .onReceive(Publishers.MergeMany(viewModels.values.map { $0.objectWillChange })
            .debounce(for: .milliseconds(120), scheduler: RunLoop.main)) { _ in
            // Child tiles observe their own models. Rebuild the entire grid only
            // when a tile enters/leaves the visible set or the empty-state changes.
            let signature = displayedStudios.map(\.id).joined(separator: "|") +
                "|waiting:\(isWaitingForResults)|locations:\(locationCounts.signature)|levels:\(seniorityCounts.signature)"
            if signature != lastGridSignature {
                lastGridSignature = signature
                updateVersion &+= 1
            }
        }
        .toolbar {
            ToolbarItemGroup {
                Menu {
                    Button("Clear locations") {
                        locationRegions = ""
                        locationCountries = ""
                    }
                    Divider()
                    Text("Continents & remote")
                    ForEach(JobLocationRegion.allCases.filter { $0 != .all }) { region in
                        Toggle(isOn: Binding(
                            get: { selectedRegions.contains(region) },
                            set: { toggleRegion(region, enabled: $0) }
                        )) {
                            Text("\(region.rawValue) (\(counts.regions[region, default: 0]))")
                        }
                    }
                    Divider()
                    Menu("Countries") {
                        ForEach(Set(counts.countries.keys).union(selectedCountries).sorted(), id: \.self) { country in
                            Toggle(isOn: Binding(
                                get: { selectedCountries.contains(country) },
                                set: { toggleCountry(country, enabled: $0) }
                            )) {
                                Text("\(country) (\(counts.countries[country, default: 0]))")
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "globe.europe.africa")
                            .foregroundStyle(hasActiveLocationFilters ? Color.accentColor : Color.primary)
                        if hasActiveLocationFilters {
                            Text("\(selectedRegions.count + selectedCountries.count)")
                                .font(.caption2.monospacedDigit().weight(.semibold))
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                    .accessibilityLabel("Location filters. \(locationFilterDescription)")
                }
                .help(locationFilterDescription)

                Menu {
                    Button("Clear levels") { seniorityLevels = "" }
                    Divider()
                    ForEach(JobSeniorityLevel.allCases.filter { $0 != .all }) { level in
                        Toggle(isOn: Binding(
                            get: { selectedLevels.contains(level) },
                            set: { enabled in
                                if enabled != selectedLevels.contains(level) { toggleLevel(level) }
                            }
                        )) {
                            Text("\(level.rawValue) (\(levelCounts.levels[level, default: 0]))")
                        }
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "person.crop.rectangle.stack")
                            .foregroundStyle(selectedLevels.isEmpty ? Color.primary : Color.accentColor)
                        if !selectedLevels.isEmpty {
                            Text("\(selectedLevels.count)")
                                .font(.caption2.monospacedDigit().weight(.semibold))
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                    .accessibilityLabel("Seniority filter: \(selectedLevels.isEmpty ? "All levels" : selectedLevels.map(\.rawValue).sorted().joined(separator: ", "))")
                }
                .help(selectedLevels.isEmpty ? "All experience levels" : "Filtering: \(selectedLevels.map(\.rawValue).sorted().joined(separator: ", "))")

                Toggle(isOn: $hideEmpty) {
                    Label("Hide Empty", systemImage: "line.3.horizontal.decrease.circle")
                }
                .toggleStyle(.button)
                .labelStyle(.iconOnly)
                .help("Hide studios with no matching jobs or a loading error")

                Menu {
                    Picker("Auto Refresh", selection: $autoRefreshSeconds) {
                        Text("Never").tag(0)
                        Text("10 seconds").tag(10)
                        Text("30 seconds").tag(30)
                        Text("1 minute").tag(60)
                        Text("5 minutes").tag(300)
                        Text("10 minutes").tag(600)
                        Text("1 hour").tag(3600)
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "clock.arrow.circlepath")
                            .foregroundStyle(autoRefreshSeconds > 0 ? Color.accentColor : Color.primary)
                        if autoRefreshSeconds > 0 {
                            Text(autoRefreshLabel)
                                .font(.caption2.monospacedDigit().weight(.semibold))
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                    .accessibilityLabel("Auto Refresh: \(autoRefreshLabel)")
                }
                .help(autoRefreshSeconds > 0 ? "Automatically refreshing every \(autoRefreshLabel)" : "Auto Refresh is off")

                Button(action: {
                    Task { await reloadAllAction() }
                }) {
                    Label("Refresh All", systemImage: "arrow.clockwise")
                }
                .help("Refresh all visible job lists")
            }
        }
    }
}

struct ClearableTextField: View {
    var placeholder: String
    @Binding var text: String

    var body: some View {
        HStack {
            TextField(placeholder, text: $text)
                .textFieldStyle(.roundedBorder)
            
            if !text.isEmpty {
                Button(action: { self.text = "" }) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
    }
}
