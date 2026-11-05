//   SPDX-License-Identifier: BSD-3-Clause

//! Test only, never deployed: a policy with no rules of its own. It holds a real badge and asks the Escrow to do
//! whatever a test says, which is how the tests check that the Escrow itself refuses a misbehaving approved policy.

use tari_template_lib::prelude::*;

#[template]
mod escrow_probe {
    use super::*;

    pub struct EscrowProbe {
        escrow: ComponentAddress,
        badge_vault: Vault,
    }

    impl EscrowProbe {
        pub fn new(escrow: ComponentAddress, badge_resource: ResourceAddress) -> Component<Self> {
            Component::new(Self { escrow, badge_vault: Vault::new_empty(badge_resource) }).with_access_rules(AccessRules::allow_all()).create()
        }

        pub fn receive_badge(&mut self, badge: Bucket) {
            self.badge_vault.deposit(badge);
        }

        pub fn release(&mut self, account_id: String, index: u32) -> Bucket {
            let proof = self.badge_vault.create_proof();
            let paid: Bucket = ComponentManager::get(self.escrow).call("release", args![proof, account_id, index]);
            proof.drop();
            paid
        }

        pub fn release_to(&mut self, account_id: String, index: u32, to: ComponentAddress) {
            let proof = self.badge_vault.create_proof();
            ComponentManager::get(self.escrow).invoke("release_to", args![proof, account_id, index, to]);
            proof.drop();
        }

        pub fn give_back(&mut self, account_id: String, index: u32) {
            let proof = self.badge_vault.create_proof();
            ComponentManager::get(self.escrow).invoke("return_to_sender", args![proof, account_id, index]);
            proof.drop();
        }

        pub fn draw_fee(&mut self, account_id: String, fee: Amount) {
            let proof = self.badge_vault.create_proof();
            ComponentManager::get(self.escrow).invoke("pay_fee_sponsored", args![proof, account_id, fee]);
            proof.drop();
        }
    }
}
