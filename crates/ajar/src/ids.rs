//! Link ids. Readable enough to say out loud, wide enough not to guess.
//!
//! adjective-noun-4digits over 64 x 64 x 10000 ≈ 4.1e7 combinations. That is
//! nowhere near enough to be a security boundary on its own — the session is
//! ephemeral and the host sees every join — but it does make casual
//! enumeration unrewarding.

use rand::seq::IndexedRandom;
use rand::RngExt;

const ADJECTIVES: &[&str] = &[
    "quiet", "amber", "brisk", "candid", "dusky", "eager", "fluent", "gentle", "hazel", "ivory",
    "jolly", "keen", "lucid", "mellow", "nimble", "opal", "plain", "quick", "rustic", "solar",
    "tidal", "umber", "vivid", "warm", "yellow", "zesty", "arctic", "bronze", "cobalt", "dapper",
    "ember", "frosty", "golden", "humble", "indigo", "jade", "kindly", "lively", "misty", "noble",
    "olive", "polar", "quaint", "ruddy", "sage", "teal", "upbeat", "velvet", "witty", "azure",
    "balmy", "clear", "downy", "even", "fleet", "grand", "hardy", "inky", "just", "lunar", "maple",
    "north", "onyx", "pearl",
];

const NOUNS: &[&str] = &[
    "ember", "harbor", "meadow", "cedar", "lantern", "canyon", "willow", "beacon", "thicket",
    "cobble", "anvil", "birch", "cinder", "dune", "estuary", "fjord", "grotto", "hollow", "inlet",
    "juniper", "kettle", "lagoon", "marsh", "notch", "orchard", "prairie", "quarry", "ridge",
    "summit", "tundra", "vale", "wharf", "alcove", "brook", "cliff", "delta", "eddy", "fern",
    "glade", "heath", "isle", "knoll", "ledge", "moss", "nook", "oasis", "plateau", "reef",
    "shoal", "trail", "vista", "wick", "arbor", "basin", "creek", "dell", "flint", "gorge",
    "haven", "islet", "jetty", "kiln", "loch", "mesa",
];

pub fn generate() -> String {
    let mut rng = rand::rng();
    let adjective = ADJECTIVES.choose(&mut rng).copied().unwrap_or("quiet");
    let noun = NOUNS.choose(&mut rng).copied().unwrap_or("ember");
    let n: u16 = rng.random_range(1000..10000);
    format!("{adjective}-{noun}-{n}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_three_parts() {
        let id = generate();
        let parts: Vec<_> = id.split('-').collect();
        assert_eq!(parts.len(), 3, "{id}");
        assert_eq!(parts[2].len(), 4, "{id}");
    }

    #[test]
    fn is_not_constant() {
        let a: std::collections::HashSet<_> = (0..64).map(|_| generate()).collect();
        assert!(a.len() > 32, "ids look far too repetitive");
    }
}
