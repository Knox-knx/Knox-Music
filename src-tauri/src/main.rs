//! KNOX Music desktop binary — thin wrapper over the shared host library.
//! All host logic lives in `lib.rs` so the Android build (cdylib) and the
//! desktop build (binary) run the exact same code.

fn main() {
    knox_music::run();
}
