pub mod close_pouch;
pub mod create_pouch;
pub mod freeze;
pub mod pay;
pub mod set_rules;
pub mod top_up;
pub mod withdraw;

// Anchor's macros need the glob re-exports; each file's `handler` is called by module path.
#[allow(ambiguous_glob_reexports)]
mod reexports {
    pub use super::close_pouch::*;
    pub use super::create_pouch::*;
    pub use super::freeze::*;
    pub use super::pay::*;
    pub use super::set_rules::*;
    pub use super::top_up::*;
    pub use super::withdraw::*;
}
pub use reexports::*;
