import Foundation

// Represents a single job posting
public struct Job: Identifiable, Hashable, Equatable {
    public let id = UUID()
    public let title: String
    public let link: URL
    public let location: String?
    public let extraLink: URL?
    public let firstSeen: Date?

    public init(title: String, link: URL, location: String?, extraLink: URL? = nil, firstSeen: Date? = nil) {
        self.title = title
        self.link = link
        self.location = location
        self.extraLink = extraLink
        self.firstSeen = firstSeen
    }

    public static func == (lhs: Job, rhs: Job) -> Bool {
        return lhs.id == rhs.id && lhs.title == rhs.title && lhs.link == rhs.link && lhs.location == rhs.location && lhs.extraLink == rhs.extraLink && lhs.firstSeen == rhs.firstSeen
    }
}

public struct ScrapingMapValue: Codable, Hashable {
    public let path: String?
    public let selector: String?
    public let attr: String?
    public let prefix: String?
    public let suffix: String?
    public let regex: String?
    public let regexLink: String?
    public let source: String?
    public let findPrevious: String?
    public let findNextSibling: String?
    public let removeLocationFromTitle: Bool?
    public let split: SplitConfig?
    public let index: JSONValue?
    public let exclude: String?
    public let defaultValue: String?
    public let join: String?
    public let replace: [Replacement]?
    public let titleCase: Bool?

    public struct SplitConfig: Codable, Hashable {
        public let sep: String
        public let index: Int
    }

    public struct Replacement: Codable, Hashable {
        public let old: String
        public let new: String
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let stringValue = try? container.decode(String.self) {
            self.path = stringValue
            self.selector = stringValue
            self.attr = nil
            self.prefix = nil
            self.suffix = nil
            self.regex = nil
            self.regexLink = nil
            self.source = nil
            self.findPrevious = nil
            self.findNextSibling = nil
            self.removeLocationFromTitle = nil
            self.split = nil
            self.index = nil
            self.exclude = nil
            self.defaultValue = nil
            self.join = nil
            self.replace = nil
            self.titleCase = nil
        } else if let boolValue = try? container.decode(Bool.self) {
            self.path = nil
            self.selector = nil
            self.attr = nil
            self.prefix = nil
            self.suffix = nil
            self.regex = nil
            self.regexLink = nil
            self.source = nil
            self.findPrevious = nil
            self.findNextSibling = nil
            self.removeLocationFromTitle = boolValue
            self.split = nil
            self.index = nil
            self.exclude = nil
            self.defaultValue = nil
            self.join = nil
            self.replace = nil
            self.titleCase = nil
        } else {
            let dictContainer = try decoder.container(keyedBy: CodingKeys.self)
            self.path = try dictContainer.decodeIfPresent(String.self, forKey: .path)
            self.selector = try dictContainer.decodeIfPresent(String.self, forKey: .selector)
            self.attr = try dictContainer.decodeIfPresent(String.self, forKey: .attr)
            self.prefix = try dictContainer.decodeIfPresent(String.self, forKey: .prefix)
            self.suffix = try dictContainer.decodeIfPresent(String.self, forKey: .suffix)
            self.regex = try dictContainer.decodeIfPresent(String.self, forKey: .regex)
            self.regexLink = try dictContainer.decodeIfPresent(String.self, forKey: .regexLink)
            self.source = try dictContainer.decodeIfPresent(String.self, forKey: .source)
            self.findPrevious = try dictContainer.decodeIfPresent(String.self, forKey: .findPrevious)
            self.findNextSibling = try dictContainer.decodeIfPresent(String.self, forKey: .findNextSibling)
            self.removeLocationFromTitle = try dictContainer.decodeIfPresent(Bool.self, forKey: .removeLocationFromTitle)
            self.split = try dictContainer.decodeIfPresent(SplitConfig.self, forKey: .split)
            self.index = try dictContainer.decodeIfPresent(JSONValue.self, forKey: .index)
            self.exclude = try dictContainer.decodeIfPresent(String.self, forKey: .exclude)
            self.defaultValue = try dictContainer.decodeIfPresent(String.self, forKey: .defaultValue)
            self.join = try dictContainer.decodeIfPresent(String.self, forKey: .join)
            if let one = try? dictContainer.decode(Replacement.self, forKey: .replace) {
                self.replace = [one]
            } else {
                self.replace = try dictContainer.decodeIfPresent([Replacement].self, forKey: .replace)
            }
            self.titleCase = try dictContainer.decodeIfPresent(Bool.self, forKey: .titleCase)
        }
    }

    public enum CodingKeys: String, CodingKey {
        case path, selector, attr, prefix, suffix, regex, regexLink = "regex_link", source
        case findPrevious = "find_previous", findNextSibling = "find_next_sibling"
        case removeLocationFromTitle = "remove_location_from_title", split, index, exclude
        case defaultValue = "default", join, replace, titleCase = "title_case"
    }
}

public struct ScrapingConfig: Codable, Hashable {
    public let strategy: String
    public let container: String?
    public let path: String?
    public let method: String?
    public let params: [String: JSONValue]?
    public let payload: [String: JSONValue]?
    public let headers: [String: String]?
    public let formData: [String: JSONValue]?
    public let filter: FilterConfig?
    public let map: [String: ScrapingMapValue]?
    public let jsonText: JSONTextConfig?
    public let jsonHTMLField: String?
    public let encoding: String?
    public let detailPage: DetailPageConfig?
    public let preVisit: PreVisitConfig?
    
    public struct FilterConfig: Codable, Hashable {
        public let key: String
        public let startswith: String
    }

    public struct JSONTextConfig: Codable, Hashable {
        public let variable: String?
        public let regex: String?
        public let unescape: Bool?
    }

    public struct DetailPageConfig: Codable, Hashable {
        public let maxWorkers: Int?
        public let timeout: Double?
        public let headers: [String: String]?
        public let map: [String: ScrapingMapValue]

        public enum CodingKeys: String, CodingKey {
            case maxWorkers = "max_workers", timeout, headers, map
        }
    }

    public struct PreVisitConfig: Codable, Hashable {
        public let url: URL?
        public let csrf: CSRFConfig?

        public struct CSRFConfig: Codable, Hashable {
            public let cookie: String?
            public let unescape: Bool?
            public let split: String?
            public let header: String?
        }
    }
    
    public enum CodingKeys: String, CodingKey {
        case strategy, container, path, method, params, payload, headers, formData = "form_data", filter, map
        case jsonText = "json_text", jsonHTMLField = "json_html_field", encoding
        case detailPage = "detail_page", preVisit = "pre_visit"
    }
}

public enum JSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case dictionary([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .dictionary(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if container.decodeNil() {
            self = .null
        } else {
            throw DecodingError.typeMismatch(JSONValue.self, DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Unsupported JSONValue type"))
        }
    }
    
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .bool(let value):
            try container.encode(value)
        case .dictionary(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }
    public var stringValue: String {
        switch self {
        case .string(let s): return s
        case .number(let n):
            if n == floor(n) {
                return String(format: "%.0f", n)
            }
            return String(n)
        case .bool(let b): return String(b)
        case .dictionary(let d):
            if let data = try? JSONEncoder().encode(d), let s = String(data: data, encoding: .utf8) {
                return s
            }
            return String(describing: d)
        case .array(let a):
            if let data = try? JSONEncoder().encode(a), let s = String(data: data, encoding: .utf8) {
                return s
            }
            return String(describing: a)
        case .null: return ""
        }
    }
}

// Represents a studio, decoded from the JSON file
public struct Studio: Identifiable, Codable, Hashable, Equatable {
    public let id: String
    public let name: String
    public let logoUrl: URL
    public let careersUrl: [URL]
    public let website: URL?
    public let scraping: ScrapingConfig?

    public enum CodingKeys: String, CodingKey {
        case id, name, logoUrl = "logo_url", careersUrl = "careers_url", website, scraping
    }
    
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        logoUrl = try container.decode(URL.self, forKey: .logoUrl)
        
        // careersUrl can be a single string or an array of strings
        if let singleUrl = try? container.decode(URL.self, forKey: .careersUrl) {
            careersUrl = [singleUrl]
        } else {
            careersUrl = try container.decode([URL].self, forKey: .careersUrl)
        }
        
        if let websiteString = try? container.decodeIfPresent(String.self, forKey: .website),
           !websiteString.isEmpty {
            website = URL(string: websiteString)
        } else if let websiteURL = try? container.decodeIfPresent(URL.self, forKey: .website) {
            website = websiteURL
        } else {
            website = nil
        }
        scraping = try container.decodeIfPresent(ScrapingConfig.self, forKey: .scraping)
    }

    public static func == (lhs: Studio, rhs: Studio) -> Bool {
        return lhs.id == rhs.id
    }
}
