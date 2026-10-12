import SwiftUI

struct StudioColumnView: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject var viewModel: StudioViewModel
    @Binding var filterText: String
    @Binding var locationRegions: String
    @Binding var locationCountries: String
    @Binding var seniorityLevels: String
    @State private var isRefreshingLogo = false

    private var filteredJobs: [Job] {
        viewModel.filteredJobs(filterText: filterText, regions: JobLocationRegion.selectedRegions(from: locationRegions), countries: JobLocationRegion.selectedCountries(from: locationCountries), levels: JobSeniorityLevel.selections(from: seniorityLevels))
    }

    private var careersURL: URL? {
        viewModel.studio.website ?? viewModel.studio.careersUrl.first
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()

            VStack(spacing: 0) {
                if let errorMessage = viewModel.errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .help(errorMessage)
                }

                Group {
                if viewModel.isLoading && !viewModel.hasFetched {
                    VStack(spacing: 10) {
                        ProgressView()
                        Text("Checking open positions…")
                            .foregroundStyle(.secondary)
                            .font(.caption)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if filteredJobs.isEmpty {
                    ContentUnavailableView(
                        viewModel.errorMessage == nil ? "No positions found" : "Could not load positions",
                        systemImage: viewModel.errorMessage == nil ? "tray" : "wifi.exclamationmark",
                        description: Text(filterText.isEmpty ? "Try refreshing or open the careers page." : "No positions match your search.")
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 4) {
                            ForEach(filteredJobs) { job in
                                JobRowView(job: job)
                            }
                        }
                        .padding(8)
                    }
                    .scrollIndicators(.visible)
                }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .frame(height: 310)
        }
        .frame(minWidth: 280, maxWidth: .infinity)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.65))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.09), lineWidth: 1)
        }
    }

    private var header: some View {
        ZStack {
            Group {
                if let careersURL {
                    Link(destination: careersURL) { studioLogo }
                        .buttonStyle(.plain)
                        .help("Open \(viewModel.studio.name) careers")
                } else {
                    studioLogo
                }
            }
            .frame(maxWidth: .infinity, alignment: .center)

            HStack(spacing: 8) {
                Spacer(minLength: 0)
                if viewModel.isLoading {
                ProgressView()
                    .controlSize(.small)
                    .help("Refreshing positions")
                } else if viewModel.hasFetched {
                Text("\(filteredJobs.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 4)
                    .background(Color.primary.opacity(0.06), in: Capsule())
                    .help("\(filteredJobs.count) matching positions")
                }
                Button {
                    Task { await viewModel.fetchJobs(isRefresh: true) }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .disabled(viewModel.isLoading)
                .help("Refresh \(viewModel.studio.name)")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 11)
    }

    private var studioLogo: some View {
        Group {
            if isRefreshingLogo || appState.isRefetchingLogos {
                ProgressView().controlSize(.small)
            } else {
                CachedAsyncImage(url: viewModel.studio.logoUrl, studioId: viewModel.studio.id) {
                    Text(viewModel.studio.name)
                        .font(.headline)
                        .lineLimit(2)
                }
            }
        }
        .frame(width: 128, height: 40, alignment: .center)
        .contextMenu {
            Button("Refresh Logo") {
                Task {
                    isRefreshingLogo = true
                    await ImageCache.shared.clearCachedImage(studioId: viewModel.studio.id)
                    isRefreshingLogo = false
                }
            }
            if let careersURL {
                Button("Open Careers Page") {
                    NSWorkspace.shared.open(careersURL)
                }
            }
        }
    }
}

struct JobRowView: View {
    let job: Job

    private var ageSeconds: TimeInterval? {
        job.firstSeen.map { max(0, Date().timeIntervalSince($0)) }
    }

    private var ageText: String? {
        guard let age = ageSeconds else { return nil }
        if age < 3_600 { return "New" }
        if age < 86_400 { return "\(Int(age / 3_600))h ago" }
        if age < 7 * 86_400 { return "\(Int(age / 86_400))d ago" }
        return "\(Int(age / (7 * 86_400)))w ago"
    }

    // Same ten-day progression as Python: green -> orange -> red -> neutral.
    private var ageColor: Color? {
        guard let age = ageSeconds, age <= 10 * 86_400 else { return nil }
        let fraction = age / (10 * 86_400)
        let stops: [(Double, (Double, Double, Double))] = [
            (0, (76, 175, 80)), (0.5, (255, 152, 0)),
            (0.8, (244, 67, 54)), (1, (85, 85, 85))
        ]
        let endpoint = stops.firstIndex { fraction <= $0.0 } ?? stops.count - 1
        let start = stops[max(0, endpoint - 1)]
        let end = stops[endpoint]
        let mix = end.0 == start.0 ? 0 : (fraction - start.0) / (end.0 - start.0)
        let vibrancy = 1 - 0.6 * min(1, age / 86_400)
        func channel(_ a: Double, _ b: Double) -> Double {
            ((a + (b - a) * mix) * vibrancy + 85 * (1 - vibrancy)) / 255
        }
        return Color(red: channel(start.1.0, end.1.0),
                     green: channel(start.1.1, end.1.1),
                     blue: channel(start.1.2, end.1.2))
    }

    var body: some View {
        HStack(spacing: 8) {
            Link(destination: job.link) {
                HStack(alignment: .center, spacing: 8) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(job.title)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.primary)
                            .lineLimit(3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        HStack(spacing: 8) {
                            if let location = job.location, !location.isEmpty {
                                Label(location.components(separatedBy: ",").first ?? location, systemImage: "mappin")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                            Spacer(minLength: 0)
                            if let ageText {
                                Text(ageText)
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(ageColor ?? .secondary)
                                    .help("First seen \(job.firstSeen?.formatted(date: .abbreviated, time: .shortened) ?? "")")
                            }
                        }
                    }
                    Image(systemName: "arrow.up.right")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .padding(10)
                .background((ageColor ?? Color.primary).opacity(ageColor == nil ? 0.045 : 0.10),
                            in: RoundedRectangle(cornerRadius: 8))
                .overlay {
                    RoundedRectangle(cornerRadius: 8)
                        .strokeBorder((ageColor ?? Color.primary).opacity(ageColor == nil ? 0.05 : 0.65), lineWidth: 1)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Open job listing")

            if let extraLink = job.extraLink {
                Link(destination: extraLink) {
                    Image(systemName: "doc.text")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .help("Open additional details")
            }
        }
    }
}
