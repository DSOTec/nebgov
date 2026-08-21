use soroban_sdk::contracterror;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum SignalAnchorError {
    AlreadyInitialized = 1,
    AlreadyAnchored = 2,
    Unauthorized = 3,
    NotInitialized = 4,
}
