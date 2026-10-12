import SwiftUI
import Combine
import Cocoa

@MainActor
class ImageCache: ObservableObject {
    static let shared = ImageCache()
    private let fileManager = FileManager.default
    private let cacheDirectory: URL

    private init() {
        let cachesURL = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first!
        cacheDirectory = cachesURL.appendingPathComponent("ImageCache")
        try? fileManager.createDirectory(at: cacheDirectory, withIntermediateDirectories: true, attributes: nil)
    }

    func loadImageData(for url: URL, studioId: String) async -> Data? {
        // Use .png for processed images in cache
        let fileURL = cacheDirectory.appendingPathComponent("\(studioId).png")
        
        // Check cache first
        if let data = await Task.detached(priority: .utility, operation: { () -> Data? in
            guard let cached = try? Data(contentsOf: fileURL), NSImage(data: cached) != nil else { return nil }
            return cached
        }).value {
            return data
        }

        // If not in cache, download
        do {
            var request = URLRequest(url: url)
            request.addValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36", forHTTPHeaderField: "User-Agent")
            request.addValue("image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8", forHTTPHeaderField: "Accept")
            request.timeoutInterval = 20
            let (data, response) = try await downloadWithRetry(request)
            
            guard let httpResponse = response as? HTTPURLResponse, (200...299).contains(httpResponse.statusCode) else {
                print("Failed to download image from \(url), status code: \((response as? HTTPURLResponse)?.statusCode ?? 0)")
                return nil
            }

            // Pixel scanning, background removal and TIFF conversion are expensive.
            // Perform them off the UI actor so a grid of logos can scroll smoothly.
            return await Task.detached(priority: .utility) { () -> Data? in
                guard let rawImage = NSImage(data: data) else { return nil }
                let prefix = String(data: data.prefix(512), encoding: .utf8)?.lowercased() ?? ""
                let isSVG = prefix.contains("<svg") || prefix.contains("<?xml") || url.pathExtension.lowercased() == "svg"
                var processedImage = rawImage
                if !isSVG, let backgroundRemoved = rawImage.removingBackground(tolerance: 0.05) {
                    processedImage = backgroundRemoved.croppedLeavingMargin(marginPercent: 0.1) ?? backgroundRemoved
                }
                let tintedImage = processedImage.tinted(with: .white)
                if let tiff = tintedImage.tiffRepresentation,
                   let bitmap = NSBitmapImageRep(data: tiff),
                   let pngData = bitmap.representation(using: .png, properties: [:]) {
                    try? pngData.write(to: fileURL, options: .atomic)
                    return pngData
                }
                return data
            }.value
        } catch {
            print("Failed to load image data from \(url): \(error)")
            return nil
        }
    }

    /// Recover from intermittent DNS/connectivity failures and server throttling.
    /// Certificate validation remains enforced by the system URLSession.
    private func downloadWithRetry(_ request: URLRequest) async throws -> (Data, URLResponse) {
        for attempt in 0..<3 {
            do {
                let result = try await URLSession.shared.data(for: request)
                let status = (result.1 as? HTTPURLResponse)?.statusCode ?? 0
                if (status == 429 || (500...599).contains(status)) && attempt < 2 {
                    try await Task.sleep(for: .milliseconds(350 * (attempt + 1)))
                    continue
                }
                return result
            } catch {
                let code = (error as NSError).code
                let transient = [-1001, -1003, -1004, -1005, -1009].contains(code)
                guard transient && attempt < 2 else { throw error }
                try await Task.sleep(for: .milliseconds(350 * (attempt + 1)))
            }
        }
        throw URLError(.cannotLoadFromNetwork)
    }
    
    func clearCachedImage(studioId: String) async {
        // Remove all cached files for this studio ID (any extension)
        do {
            let files = try fileManager.contentsOfDirectory(at: cacheDirectory, includingPropertiesForKeys: nil)
            for file in files {
                if file.deletingPathExtension().lastPathComponent == studioId {
                    try? fileManager.removeItem(at: file)
                }
            }
        } catch {
            print("Failed to clear cached image for \(studioId): \(error)")
        }
    }
    
    func clearAllCachedImages() async {
        do {
            let files = try fileManager.contentsOfDirectory(at: cacheDirectory, includingPropertiesForKeys: nil)
            for file in files {
                try? fileManager.removeItem(at: file)
            }
        } catch {
            print("Failed to clear all cached images: \(error)")
        }
    }
}

struct CachedAsyncImage<Fallback: View>: View {
    let url: URL
    let studioId: String
    private let fallback: () -> Fallback
    @State private var image: NSImage?
    @State private var hasError = false

    init(url: URL, studioId: String, @ViewBuilder fallback: @escaping () -> Fallback) {
        self.url = url
        self.studioId = studioId
        self.fallback = fallback
    }

    var body: some View {
        Group {
            if let image = image {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
            } else if hasError {
                fallback()
            } else {
                ProgressView()
            }
        }
        .task(id: "\(studioId)|\(url.absoluteString)") {
            image = nil
            hasError = false
            if let data = await ImageCache.shared.loadImageData(for: url, studioId: studioId),
               let loadedImage = NSImage(data: data) {
                self.image = loadedImage
            } else {
                self.hasError = true
            }
        }

    }
}



extension NSImage {
    
    func tinted(with color: NSColor) -> NSImage {
        guard self.size.width > 0 && self.size.height > 0 else { return self }
        let newImage = NSImage(size: self.size, flipped: false) { (dstRect) -> Bool in
            self.draw(in: dstRect)
            NSGraphicsContext.current?.cgContext.setBlendMode(.sourceIn)
            color.setFill()
            dstRect.fill()
            return true
        }
        return newImage
    }
    
    func removingBackground(tolerance: CGFloat = 0.1) -> NSImage? {
        guard let tiffData = self.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffData) else {
            return nil
        }

        let width = bitmap.pixelsWide
        let height = bitmap.pixelsHigh

        // Check if it already has transparency (alpha < 255 in some pixel)
        for y in 0..<height {
            for x in 0..<width {
                let alpha = bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 1.0
                if alpha < 1.0 {
                    // Already has transparency, do nothing
                    return self
                }
            }
        }

        // Function to get the average color of the corners
        func averageCornerColor() -> NSColor? {
            guard let c1 = bitmap.colorAt(x: 0, y: 0),
                  let c2 = bitmap.colorAt(x: width - 1, y: 0),
                  let c3 = bitmap.colorAt(x: 0, y: height - 1),
                  let c4 = bitmap.colorAt(x: width - 1, y: height - 1) else {
                return nil
            }
            let r = (c1.redComponent + c2.redComponent + c3.redComponent + c4.redComponent) / 4.0
            let g = (c1.greenComponent + c2.greenComponent + c3.greenComponent + c4.greenComponent) / 4.0
            let b = (c1.blueComponent + c2.blueComponent + c3.blueComponent + c4.blueComponent) / 4.0
            return NSColor(calibratedRed: r, green: g, blue: b, alpha: 1.0)
        }

        guard let bgColor = averageCornerColor() else {
            return nil
        }

        // Create context to modify the image
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return nil
        }

        guard let cgImage = self.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return nil
        }

        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

        guard let data = context.data else { return nil }
        let pixelBuffer = data.bindMemory(to: UInt8.self, capacity: width * height * 4)

        // Tolerance threshold (0 to 1) to define "close" to the background color
        func colorCloseToBackground(r: UInt8, g: UInt8, b: UInt8) -> Bool {
            // Convert bgColor to 0-255 values
            let br = UInt8(bgColor.redComponent * 255)
            let bg = UInt8(bgColor.greenComponent * 255)
            let bb = UInt8(bgColor.blueComponent * 255)

            // Calculate simple normalized Euclidean distance
            let dr = Int(r) - Int(br)
            let dg = Int(g) - Int(bg)
            let db = Int(b) - Int(bb)
            let distance = sqrt(Double(dr*dr + dg*dg + db*db)) / sqrt(3 * 255 * 255) // Normalize to [0,1]

            return distance < Double(tolerance)
        }

        for y in 0..<height {
            for x in 0..<width {
                let i = (y * width + x) * 4
                let r = pixelBuffer[i]
                let g = pixelBuffer[i + 1]
                let b = pixelBuffer[i + 2]
                let a = pixelBuffer[i + 3]

                if a == 0 { continue } // Already transparent

                if colorCloseToBackground(r: r, g: g, b: b) {
                    // Make pixel transparent
                    pixelBuffer[i + 3] = 0
                }
            }
        }

        guard let outputCGImage = context.makeImage() else { return nil }
        return NSImage(cgImage: outputCGImage, size: self.size)
    }
    
    func croppedLeavingMargin(marginPercent: CGFloat = 0.1) -> NSImage? {
            guard let cgImage = self.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
            let width = cgImage.width
            let height = cgImage.height

            guard let dataProvider = cgImage.dataProvider,
                  let data = dataProvider.data else { return nil }

            let ptr = CFDataGetBytePtr(data)
            let bytesPerPixel = 4
            let bytesPerRow = cgImage.bytesPerRow

            // Find left bound: first column with any pixel alpha > 0
            var leftBound = 0
            outerLeft: for x in 0..<width {
                for y in 0..<height {
                    let idx = y * bytesPerRow + x * bytesPerPixel
                    let alpha = ptr![idx + 3]
                    if alpha > 0 {
                        leftBound = x
                        break outerLeft
                    }
                }
            }

            // Find right bound: last column with any pixel alpha > 0
            var rightBound = width - 1
            outerRight: for x in (0..<width).reversed() {
                for y in 0..<height {
                    let idx = y * bytesPerRow + x * bytesPerPixel
                    let alpha = ptr![idx + 3]
                    if alpha > 0 {
                        rightBound = x
                        break outerRight
                    }
                }
            }

            // Find top bound: first row with any pixel alpha > 0
            var topBound = 0
            outerTop: for y in 0..<height {
                for x in 0..<width {
                    let idx = y * bytesPerRow + x * bytesPerPixel
                    let alpha = ptr![idx + 3]
                    if alpha > 0 {
                        topBound = y
                        break outerTop
                    }
                }
            }

            // Find bottom bound: last row with any pixel alpha > 0
            var bottomBound = height - 1
            outerBottom: for y in (0..<height).reversed() {
                for x in 0..<width {
                    let idx = y * bytesPerRow + x * bytesPerPixel
                    let alpha = ptr![idx + 3]
                    if alpha > 0 {
                        bottomBound = y
                        break outerBottom
                    }
                }
            }

            let marginX = Int(CGFloat(width) * marginPercent)
            let marginY = Int(CGFloat(height) * marginPercent)

            let cropX = max(leftBound - marginX, 0)
            let cropY = max(topBound - marginY, 0)
            let cropWidth = min(rightBound + marginX, width - 1) - cropX + 1
            let cropHeight = min(bottomBound + marginY, height - 1) - cropY + 1

            let cropRect = CGRect(x: cropX, y: cropY, width: cropWidth, height: cropHeight)

            guard let croppedCGImage = cgImage.cropping(to: cropRect) else { return nil }

            let croppedRep = NSBitmapImageRep(cgImage: croppedCGImage)
            let croppedImage = NSImage(size: NSSize(width: cropWidth, height: cropHeight))
            croppedImage.addRepresentation(croppedRep)
            croppedImage.size = NSSize(width: cropWidth, height: cropHeight)

            return croppedImage
        }
}
