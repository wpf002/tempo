// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "tempo-watch",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "TempoAX", path: "Sources/TempoAX"),
        .executableTarget(name: "tempo-watch", dependencies: ["TempoAX"], path: "Sources/tempo-watch"),
        .executableTarget(name: "tempo-overlay", dependencies: ["TempoAX"], path: "Sources/tempo-overlay"),
    ]
)
