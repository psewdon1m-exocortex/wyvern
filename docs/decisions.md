# Accepted integration decisions

The owner accepted the v0.2 plan and authorized development/testing in this conversation on 2026-09-19. This record supplies the decision context required by Part 00; it does not authorize publication or paid provider tests.

1. One reusable Wyvern per host, automatically ensured by an LLM service installer; one reused/installed local Updater owns its lifecycle.
2. Adapter is the complete named API configuration. Driver is its protocol implementation. Consumers select an Adapter in their own Settings.
3. Host-wide operations and Adapter/key management belong in the existing Updater TUI, with CLI recovery and machine-readable output. Consumer web processes have no host-wide administrative socket.
4. Provider credentials are normally a single API key, stored in Volt and resolved through Kernel. Separate machine identity grants replace the legacy shared token for protected Wyvern values.
5. Register revision alone is insufficient for secret rotation. Configuration loading checks value versions and activates complete snapshots. Shared global Register rollback is prohibited.
6. Local UDS connectivity requires no Wyvern domain. Wyvern opens the outgoing provider connection; the provider authenticates the Adapter's API key account/project. Wyvern separately attributes the call to its authenticated internal client.
7. Existing client queues, prompts, extraction, local embeddings and result commits remain in the consumers. Gateway retries must not multiply their attempt budget.

The previous no-ACL Kernel behavior remains for unrelated legacy keys during migration. Protected Wyvern keys and aliases are denied to that token as soon as their bindings exist. Installers must provision distinct scoped identities before moving clients; failed authentication is not worked around with a shared provider key.

The intended shared-component update profile and recovery exception still require an implemented, verified typed Updater path. Until then the current head backup/receipt rules are unchanged, and the development image is not a supported production install.
