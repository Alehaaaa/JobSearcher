import Foundation
import Testing
import JobUI

struct JobUITests {
    @Test func bundledConfigurationDecodesAllStrategies() throws {
        let url = try #require(Bundle.main.url(forResource: "studios", withExtension: "json"))
        let studios = try JSONDecoder().decode([Studio].self, from: Data(contentsOf: url))

        #expect(studios.count >= 80)
        #expect(Set(studios.map(\.id)).count == studios.count)
        let strategies = Set(studios.compactMap { $0.scraping?.strategy })
        #expect(strategies == Set(["json", "html", "json_text", "remix", "rss", "static"]))

        let mappedFields = studios.compactMap { $0.scraping?.map?.values }.flatMap { $0 }
        #expect(mappedFields.contains { $0.index != nil })
        #expect(mappedFields.contains { $0.replace != nil })
        #expect(mappedFields.contains { $0.findNextSibling != nil })
        #expect(studios.contains { $0.scraping?.detailPage != nil })
        #expect(studios.contains { $0.scraping?.preVisit != nil })
    }
}
