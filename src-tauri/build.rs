fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        link_libmpv();
    }
    tauri_build::build()
}

/// macOS plays through libmpv inside the app: compile the video layer and link the pinned LGPL libmpv
/// that `npm run prepare:libmpv` puts in resources/bin/libmpv.
fn link_libmpv() {
    let root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let libmpv = root.join("resources/bin/libmpv");
    let lib = libmpv.join("lib");
    println!("cargo:rerun-if-changed=src/mpv/macos_video.m");
    println!("cargo:rerun-if-changed=resources/bin/libmpv/version.txt");
    if !lib.join("libmpv.dylib").is_file() {
        panic!("libmpv is missing: run `npm run prepare:libmpv` first");
    }

    cc::Build::new()
        .file("src/mpv/macos_video.m")
        .include(libmpv.join("include"))
        .flag("-fobjc-arc")
        .define("GL_SILENCE_DEPRECATION", None)
        .compile("kinuza_video");

    println!("cargo:rustc-link-search=native={}", lib.display());
    for framework in ["AppKit", "QuartzCore", "OpenGL", "IOKit"] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    // The bundle carries the dylibs in Contents/Frameworks; debug builds run straight from target/ and use the downloaded copy.
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib.display());
    }
}
