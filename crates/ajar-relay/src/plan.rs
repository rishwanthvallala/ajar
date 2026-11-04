//! Who gets which limits: the free plan, or the paid one.
//!
//! Every limit a person meets has two values (`deploy/limits.env`): the free
//! plan's, for everyone not signed in and every account not paying, and the
//! paid plan's, higher. A pad is held to its owner's plan, so an anonymous pad
//! is a free one; what an address may add in a day follows whoever is
//! writing; an account's own room follows its plan. The store's ceiling and
//! an anonymous pad's lease are the server's, and have one value.
//!
//! An account is on the paid plan while a payment holds it there (billing.rs:
//! ₹99 for 30 days, with UPI), or when the relay's configuration names it —
//! `AJAR_PAID_ACCOUNTS`, comma-separated, each an email or `provider:id`,
//! matched as `AJAR_ADMINS` is, and kept on the box with the other secrets
//! rather than in the repository. `Accounts::standing` says which.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Plan {
    Free,
    Paid,
}

/// One limit, or a set of them, for each plan.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Tiered<T> {
    pub free: T,
    pub paid: T,
}

impl<T: Copy> Tiered<T> {
    pub fn of(&self, plan: Plan) -> T {
        match plan {
            Plan::Free => self.free,
            Plan::Paid => self.paid,
        }
    }
}

/// The accounts on the paid plan, as configured.
#[derive(Debug, Clone, Default)]
pub struct PaidList(Vec<String>);

impl PaidList {
    /// `AJAR_PAID_ACCOUNTS` as written: commas between, case and spaces aside.
    pub fn parse(text: &str) -> Self {
        PaidList(
            text.split(',')
                .map(|a| a.trim().to_lowercase())
                .filter(|a| !a.is_empty())
                .collect(),
        )
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether this person is named: by `provider:id`, which needs no email,
    /// or by email, which is only stored when the provider vouches for it.
    pub fn includes(&self, provider: &str, provider_id: Option<&str>, email: Option<&str>) -> bool {
        let by_id = provider_id.map(|id| format!("{provider}:{id}").to_lowercase());
        let email = email.map(str::to_lowercase);
        self.0
            .iter()
            .any(|a| Some(a) == by_id.as_ref() || (a.contains('@') && Some(a) == email.as_ref()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_paid_account_is_named_by_email_or_provider_id() {
        let paid = PaidList::parse(" Ana@Example.com, github:583231 ,,");
        assert_eq!(paid.len(), 2);
        assert!(paid.includes("google", Some("1"), Some("ana@example.com")));
        assert!(paid.includes("github", Some("583231"), None));
        assert!(
            !paid.includes("google", Some("583231"), None),
            "an id is a provider's"
        );
        assert!(!paid.includes("github", Some("2"), Some("bo@example.com")));
        assert!(!PaidList::default().includes("github", Some("583231"), Some("ana@example.com")));
    }

    #[test]
    fn each_plan_has_its_own_value() {
        let t = Tiered { free: 1, paid: 2 };
        assert_eq!(t.of(Plan::Free), 1);
        assert_eq!(t.of(Plan::Paid), 2);
    }
}
