// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "hshot",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "hshot", targets: ["hshot"]),
    ],
    targets: [
        .executableTarget(name: "hshot"),
    ]
)
