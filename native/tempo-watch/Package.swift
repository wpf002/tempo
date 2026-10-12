// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "tempo-watch",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "tempo-watch", path: "Sources/tempo-watch")
    ]
)
