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

The typed Updater deployment/update/rollback/repair path is implemented. Its fixed external-state exception is specific to Wyvern: runtime recovery does not roll back global Kernel/Volt. Published, qualified producer releases and an actual host rehearsal remain deployment prerequisites.

On 2026-09-19, after the compliance review, the owner explicitly excluded Settings/Initialize/job-observation/component-update cards and decorative changes from this work because Wyvern is headless. Existing consumer UI is preserved; no Wyvern web UI is introduced. Functional transport, deployment, recovery, security and executable verification remain in scope. This owner instruction supersedes W08 for this implementation increment; it does not authorize expanding consumer privileges.

Consumer logical backups preserve non-secret own-client Adapter/profile/function intent. Restore records it as pending verification, retains target credentials and never writes shared gateway configuration. Inference cannot use a conflicting restored selection; an explicit scoped binding change reconciles it. Laboratory exports backup.v4 and still reads v1–v3; Mastermind stores the additional intent in its existing logical metadata inventory. Old archives retain the target's existing intent.

Container diagnostics use Docker json-file rotation (3 x 10 MiB) and a dedicated volatile systemd journal namespace (16 MiB, 30-day age ceiling). Durable security audit has two 512 KiB files, up to 5000 records each, and 30-day age retention. This intentionally smaller byte budget suits a shared headless gateway; neither prompts nor provider bodies are diagnostic state.
