//! KNOX Music desktop binary entry — delegates to the shared library `run()`
//! so the same code also builds as a cdylib for Android (`tauri android build`).

fn main() {
    knox_music::run();
}
