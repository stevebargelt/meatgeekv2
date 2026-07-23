---
id: MG-35
type: story
status: active
title: "prod data-loss protection: prevent_destroy/backup for Cosmos + IoT Hub durable state (MG-25 prod hardening)"
created: 2026-07-23
---

Surfaced during MG-24 Flex/West US 2 migration (run run-flex-consumption-hosting-model-...-26a176, red-build 8ada27/d06d57). The region change is ForceNew on the Cosmos account AND IoT Hub, which destroy+recreate on a location change. Terraform prevent_destroy cannot be variable/env-gated (must be a literal), so a shared-module prevent_destroy=true blocks the intended greenfield DEV recreate. For MG-24 greenfield (no data yet) prevent_destroy is removed. PROD holds durable state (temperature history, cooks, sessions in Cosmos; device registry + device SAS in IoT Hub) and needs real data-loss protection designed as part of prod activation/hardening: e.g. a prod-specific resource instance with prevent_destroy, continuous/periodic backup policy, and/or an operator approval gate before any ForceNew. Belongs with MG-25 (prod activation). Do NOT re-add a global prevent_destroy to the shared modules.