# MeatGeek V2 — Architecture Diagrams

These five diagrams show what is on `main` and nothing else: a component,
route or edge that the code and Terraform on `main` do not have is left out,
not drawn in a special style.

Each diagram has a prose legend immediately above it.

---

## 1. System Architecture (C4 Context + Container)

**Legend.** The Pi-side binaries (`device-controller`, `data-pusher`), the
Azure managed plane (IoT Hub, Event Hub, CosmosDB, SignalR, Functions) and
the observability sinks. IoT Hub writes every reading straight into the
`temperatures` container through its `cosmos-storage-route`; its
`eventhub-realtime-route` feeds an Event Hub that nothing consumes yet. The
API reads and writes the five Cosmos containers under its managed identity
and emits cook lifecycle events to SignalR. The mobile and web apps are
scaffolds that make no API or SignalR calls yet. The Go OTel SDKs export
OTLP to an OpenTelemetry Collector whose Terraform module is on `main` but
off by default (`enable_native_otlp = false`); with no
`OTEL_EXPORTER_OTLP_ENDPOINT` set they export nothing.

```mermaid
flowchart TB
    subgraph Pi["Raspberry Pi (ARM64)"]
        Sensors[(5 RTD Sensors<br/>grill + 4 probes)]
        DC[device-controller<br/>Go / Gobot<br/>:3000 local API]
        DP[data-pusher<br/>Go + disk-backed queue<br/>+ cooksession.Store]
        LCD[LCD Display]
        OTEL_DC[OTel Go SDK<br/>AlwaysSample, OTLP/HTTP]
        OTEL_DP[OTel Go SDK<br/>AlwaysSample, OTLP/HTTP]
    end

    subgraph AzureIngest["Azure - Ingest"]
        IoTHub[IoT Hub<br/>2 parallel routes]
        EventHub[Event Hub<br/>temperature-data<br/>no consumer yet]
    end

    subgraph AzureProcess["Azure - Compute and Data"]
        Funcs[Azure Functions API<br/>TypeScript / Node 24<br/>Flex Consumption]
        OTEL_FN["@azure/monitor-opentelemetry<br/>samplingRatio 0.5"]
        Cosmos[(CosmosDB shared-throughput db<br/>devices /id, temperatures /deviceId,<br/>cooks /userId, users /id, recipes /userId)]
        SignalR[SignalR Service<br/>temperatureHub]
    end

    subgraph Observability["Azure - Observability"]
        Collector[OTel Collector<br/>native-otlp module<br/>enable_native_otlp, default off]
        AppI[Application Insights]
        LAW[Log Analytics Workspace<br/>diagnostic settings<br/>for IoTHub/Cosmos/SignalR/Func]
    end

    Clients[Mobile + Web<br/>scaffolds, no API calls yet]

    Sensors --> DC
    DC --> LCD
    DC -- "HTTP poll 5s" --> DP
    DP -- "telemetry +<br/>correlation.id property" --> IoTHub

    IoTHub -- "cosmos route<br/>writes temperatures, partition {deviceid}" --> Cosmos
    IoTHub -- "route: eventhub-realtime-route" --> EventHub

    Funcs -- "managed identity<br/>cooks, devices, temperatures (read),<br/>users, recipes" --> Cosmos
    Funcs -- "negotiate; cook_started/stopped<br/>to userId=deviceId, after ownership check" --> SignalR
    SignalR -. "cook lifecycle events<br/>temperatureHub, group userId=deviceId<br/>live path pending MG-24" .-> DP

    OTEL_DC -- instruments --- DC
    OTEL_DP -- instruments --- DP
    OTEL_FN -- instruments --- Funcs

    OTEL_DC -- "OTLP/HTTP" --> Collector
    OTEL_DP -- "OTLP/HTTP" --> Collector
    Collector -- "native OTLP" --> AppI
    OTEL_FN -- "50 pct sampled" --> AppI
    AppI --- LAW
```

---

## 2. Deployment

**Legend.** What runs where. Pi binaries are cross-compiled to ARM64 and
copied to the device. The API deploys as a Flex Consumption Function App.
Every Azure resource is provisioned by Terraform in
`apps/infrastructure/modules/`. The Function App reaches Cosmos and SignalR
with its system-assigned managed identity and gets one app setting per
Cosmos container. The Event Hub namespace is provisioned and the Function
App holds its namespace setting, but no function in `apps/api` consumes it.
The OTel Collector Container App comes from the `native-otlp` module, which
is count-guarded off by default.

```mermaid
flowchart LR
    subgraph PiHost["Raspberry Pi linux/arm64 - physical device per smoker"]
        direction TB
        dcBin[device-controller binary<br/>built via nx build-arm]
        dpBin[data-pusher binary<br/>built via nx build-arm<br/>queue at /var/lib/meatgeek-pusher/queue<br/>state at cooksession.DefaultStatePath]
        otelGo1[OTel Go SDK<br/>OTLP/HTTP exporter]
        otelGo2[OTel Go SDK<br/>OTLP/HTTP exporter]
        envPi[/env: IOTHUB_CONNECTION_STRING<br/>SIGNALR_HUB_URL, API_BASE_URL<br/>OTEL_EXPORTER_OTLP_ENDPOINT/]
    end

    subgraph AzurePaaS["Azure - meatgeek-env-rg"]
        direction TB

        subgraph FnHost["Flex Consumption Function App<br/>FC1 plan<br/>node 24<br/>system-assigned managed identity"]
            apiBin[apps/api bundle<br/>HTTP triggers: cooks, devices, temperatures current/history,<br/>users/me, recipes, negotiate, health/cosmos<br/>timer: storageHeartbeat]
            otelFn["@azure/monitor-opentelemetry<br/>useAzureMonitor, samplingRatio 0.5"]
            envFn[/APPLICATIONINSIGHTS_CONNECTION_STRING<br/>APPLICATIONINSIGHTS_SAMPLING_PERCENTAGE=50<br/>COSMOSDB__accountEndpoint<br/>COSMOSDB_DATABASE_NAME<br/>COSMOSDB_COOKS_CONTAINER_NAME<br/>COSMOSDB_DEVICES_CONTAINER_NAME<br/>COSMOSDB_TEMPERATURES_CONTAINER_NAME<br/>COSMOSDB_USERS_CONTAINER_NAME<br/>COSMOSDB_RECIPES_CONTAINER_NAME<br/>IOTHUB_EVENTS__fullyQualifiedNamespace<br/>AzureSignalRConnectionString__serviceUri<br/>identity-based non-secret endpoints, plus Terraform-owned database and container names/]
        end

        iotMgd[IoT Hub<br/>system-assigned identity<br/>cosmos-storage-route<br/>eventhub-realtime-route]
        ehMgd[Event Hub Namespace<br/>temperature-data, 2 partitions<br/>no consumer yet]
        cosmosMgd[(CosmosDB Account<br/>shared-throughput db, 5 containers)]
        signalrMgd[SignalR Service<br/>Serverless]
        collector[OTel Collector Container App<br/>native-otlp module<br/>enable_native_otlp, default off]
        appiMgd[Application Insights<br/>workspace-based]
        lawMgd[Log Analytics Workspace<br/>2 GB/day cap]
        wb[Workbook]
        ag[Action Group<br/>email receiver]
    end

    subgraph ClientHosts["Client devices"]
        clients[Mobile + Web<br/>scaffolds, no API calls yet]
    end

    dpBin -- "AMQP/MQTT" --> iotMgd
    dpBin -- "WebSocket" --> signalrMgd
    iotMgd -- "eventhub-realtime-route" --> ehMgd
    iotMgd -- "cosmos-storage-route" --> cosmosMgd
    apiBin -- "identity-based (RBAC)" --> cosmosMgd
    apiBin -- "identity-based (RBAC)" --> signalrMgd

    otelGo1 -- instruments --- dcBin
    otelGo2 -- instruments --- dpBin
    otelFn -- instruments --- apiBin

    otelGo1 -- "OTLP/HTTP, AlwaysSample" --> collector
    otelGo2 -- "OTLP/HTTP, AlwaysSample" --> collector
    collector -- "native OTLP" --> appiMgd
    otelFn -- "samplingRatio 0.5" --> appiMgd

    iotMgd -- diagnostic settings --> lawMgd
    cosmosMgd -- diagnostic settings --> lawMgd
    signalrMgd -- diagnostic settings --> lawMgd
    FnHost -- diagnostic settings --> lawMgd

    lawMgd --- appiMgd
    appiMgd --- wb
    appiMgd -- metric alerts --> ag
```

---

## 3. Cook Lifecycle Sequence — Two Correlation Axes

**Legend.** This sequence shows a cook starting, readings flowing while it
runs, and a caller reading the history back. The caller is any client
holding an Easy Auth principal; the mobile and web apps do not call the API
yet. Two independent correlation identifiers ride on each reading:

- **`correlation.id`** — *cook-scoped*. It originates in the SignalR
  `CorrelationContext.id` envelope when the API publishes `cook_started`.
  The data-pusher captures it in `correlationHolder`
  (`apps/data-pusher/cmd/main.go`) and stamps it on **every** outbound IoT
  Hub message via the `correlation.id` message property (constant
  `iothub.CorrelationIDPropertyName`). It is constant for the duration of a
  cook.
- **`traceparent`** — *per-message*, W3C Trace Context. The data-pusher's
  `publisher.publish` span context is injected into the `traceparent`
  property of each IoT Hub message. Every published message gets its own
  traceparent. No function on `main` reads it back: the Event Hub has no
  consumer, and the readings land in Cosmos without a Function in the path.

`startCook` and `stopCook` (registered in `apps/api/src/main.ts`) first do
one point read on `devices` to check that the caller owns the device. A
foreign or unregistered device gets `403 DEVICE_NOT_OWNED`, with no write
and no event. An owned device gets the cook written to `cooks` (partition =
the caller's `userId`), then a `cook_started` / `cook_stopped` event on the
`temperatureHub` SignalR hub to `userId = deviceId`. The data-pusher's
SignalR consumer latches the cook id and correlation id. The **live**
end-to-end SignalR path still awaits the MG-24 greenfield SignalR Service
bootstrap (AC5, see `docs/api/signalr-cook-events-smoke.md`); until an
operator runs it against live infrastructure, `cooksession.Reconcile`
against the REST API on startup remains the practical cook-id source.

```mermaid
sequenceDiagram
    autonumber
    participant User as Caller (Easy Auth principal)
    participant API as Functions API
    participant SR as SignalR Service
    participant DP as data-pusher (Pi)
    participant DC as device-controller (Pi)
    participant IoT as IoT Hub
    participant Cos as CosmosDB
    participant AI as App Insights

    Note over User,SR: Cook start - producer shipped (MG-14), live SignalR path pending MG-24 bootstrap
    User->>API: POST /cooks (deviceId)
    API->>Cos: point-read devices (ownership)
    alt device foreign or unregistered
        API-->>User: 403 DEVICE_NOT_OWNED, no write, no event
    else device owned by caller
        API->>Cos: insert cook doc
        API-->>SR: cook_started to userId=deviceId<br/>envelope correlation.id = "corr-xyz"
        API-->>User: 201 cook
        SR-->>DP: cook_started event<br/>(cookId, correlation.id="corr-xyz")
        Note over DP: cooksession.Store.SetActiveCookID(cook-abc123)<br/>correlationHolder.Set("corr-xyz")
    end

    Note over DC,DP: Steady state - every 5s

    DC->>DC: poll 5 RTD sensors (10ms loop)
    DP->>DC: HTTP GET /api/.../get_temps
    DC-->>DP: 5 temps
    Note over DP: enqueuer attaches:<br/>cookId = cooksession.ActiveCookID()<br/>queueRecord.Correlation = correlationHolder.Get()
    Note over DP: OTel Go SDK starts span publisher.publish and injects traceparent per message

    DP->>IoT: PublishTelemetry payload + properties with messageId, correlation.id=corr-xyz, traceparent=00-traceId-spanId-01

    IoT->>Cos: cosmos-storage-route<br/>(identity-based, no Function)
    Note over Cos: IoT Hub envelope stored in temperatures /deviceId

    DP-->>AI: spans, AlwaysSample, OTLP via collector (default off)

    User->>API: GET /temperatures/history?deviceId
    API->>Cos: ownership read + single-partition count + page
    API-->>User: 200 page, or 404 for a foreign or unknown device
    API-->>AI: spans, samplingRatio 0.5
```

---

## 4. Telemetry & Observability Flow

**Legend.** Drawn from `apps/infrastructure/modules/monitoring/main.tf` and
the three OTel setups. The API exports straight to Application Insights
through `@azure/monitor-opentelemetry` at a 0.5 sampling ratio. The two Go
services export OTLP/HTTP with `AlwaysSample` to the OTel Collector, which
forwards to Application Insights by native OTLP ingestion; the collector
module is off by default, and with no `OTEL_EXPORTER_OTLP_ENDPOINT` the Go
exporters are no-ops. IoT Hub, Cosmos, the Function App and SignalR send
diagnostic settings to Log Analytics. Four metric alerts and three
activity-log alerts notify one action group. The budgets email the admin
address directly through their own `contact_emails`, not the action group;
the subscription credit budget exists only when `manage_subscription_budget`
is set.

```mermaid
flowchart TB
    subgraph Emitters["OTel emitters"]
        direction TB
        fnSDK["Functions API<br/>@azure/monitor-opentelemetry<br/>samplingRatio 0.5"]
        dpSDK[data-pusher<br/>OTel Go SDK, AlwaysSample]
        dcSDK[device-controller<br/>OTel Go SDK, AlwaysSample]
    end

    collector[OTel Collector<br/>enable_native_otlp, default off]

    subgraph DiagSources["Diagnostic settings sources"]
        direction TB
        iot[IoT Hub]
        cos[CosmosDB]
        fnApp[Function App]
        sr[SignalR Service]
    end

    subgraph Sinks["Sinks"]
        AI[(Application Insights<br/>workspace-based)]
        LAW[("Log Analytics Workspace<br/>cap: 2 GB per day")]
        WB[Workbook]
    end

    subgraph MetricAlerts["Metric alerts"]
        m1[function-failure-rate<br/>App Insights requests/failed]
        m2[cosmos-429-rate<br/>Cosmos TotalRequests, StatusCode 429]
        m3[signalr-connection-failure-rate<br/>SignalR SystemErrors]
        m4[ingestion-cap-reached<br/>workspace Heartbeat]
    end

    subgraph ActivityAlerts["Activity-log alerts"]
        l1[role-assignment-write]
        l2[user-assigned-identity-write]
        l3[cosmos-sql-role-assignment-write]
    end

    subgraph Budgets["Budgets, 80 and 100 pct"]
        b1[resource-group budget]
        b2[subscription credit budget<br/>if manage_subscription_budget]
    end

    AG[Action Group<br/>email receiver]
    Admin([admin email])

    fnSDK -- "spans + logs" --> AI
    dpSDK -- "OTLP/HTTP" --> collector
    dcSDK -- "OTLP/HTTP" --> collector
    collector -- "native OTLP traces" --> AI

    iot -- diagnostic settings --> LAW
    cos -- diagnostic settings --> LAW
    fnApp -- diagnostic settings --> LAW
    sr -- diagnostic settings --> LAW

    AI --- LAW
    AI --- WB

    AI --> m1
    cos --> m2
    sr --> m3
    LAW --> m4

    m1 --> AG
    m2 --> AG
    m3 --> AG
    m4 --> AG
    l1 --> AG
    l2 --> AG
    l3 --> AG

    AG --> Admin
    b1 -- contact_emails --> Admin
    b2 -- contact_emails --> Admin
```

---

## 5. API data model and ownership

**Legend.** Each HTTP route group in `apps/api/src/main.ts`, the Cosmos
containers it touches, and the ownership point read on `devices` that the
cook, device and temperature routes do first.
Status codes on an edge are what a caller gets for a device it does not own;
IoT Hub is the only writer of `temperatures`.

```mermaid
flowchart LR
    caller(["Caller<br/>Easy Auth principal &quot;tid:oid&quot;"])

    subgraph Routes["HTTP route groups"]
        direction TB
        rCooks["cooks<br/>GET, POST cooks<br/>POST cooks/{cookId}/stop"]
        rDevices["devices<br/>GET, POST devices<br/>GET, PATCH devices/{id}"]
        rTemps["temperatures<br/>GET temperatures/current/{deviceId}<br/>GET temperatures/history"]
        rUsers["users<br/>GET, PUT users/me"]
        rRecipes["recipes<br/>GET, POST recipes<br/>GET, PATCH, DELETE recipes/{id}"]
    end

    own{"ownership check<br/>point read on devices<br/>getDeviceOwnership"}

    subgraph DB["CosmosDB shared-throughput db"]
        direction TB
        cDevices[("devices<br/>/id")]
        cTemps[("temperatures<br/>/deviceId")]
        cCooks[("cooks<br/>/userId")]
        cUsers[("users<br/>/id")]
        cRecipes[("recipes<br/>/userId")]
    end

    iot["IoT Hub cosmos-storage-route<br/>partition from {deviceid}"]

    caller --> Routes

    rCooks -- "start, stop: 403 DEVICE_NOT_OWNED" --> own
    rDevices -- "GET, PATCH devices/{id}: 404" --> own
    rTemps -- "current, history: 404" --> own
    own -- "point read" --> cDevices

    rCooks -- "caller partition" --> cCooks
    rDevices -- "list by userId, register, update" --> cDevices
    rTemps -- "read only, partition = deviceId" --> cTemps
    rUsers -- "point read/write, id = caller" --> cUsers
    rRecipes -- "caller partition" --> cRecipes

    iot -- "only writer" --> cTemps
```

---

## Notes on what this document does NOT show

- **Authentication / authorization**: the Function App runs under a
  **system-assigned managed identity**. Runtime access to Cosmos, host
  Storage, the IoT-telemetry Event Hub, and SignalR is **identity-based
  (RBAC + non-secret endpoints)** — the `app_settings` in
  `apps/infrastructure/modules/functions/main.tf` carry only non-secret
  endpoint URIs (`COSMOSDB__accountEndpoint`,
  `IOTHUB_EVENTS__fullyQualifiedNamespace`,
  `AzureSignalRConnectionString__serviceUri`) resolved against that
  identity, **never** connection strings or primary keys, and no such
  secret is emitted as a Terraform output. Alongside the Cosmos endpoint sit
  six plain (non-endpoint) values the API reads itself rather than the host
  resolving them: `COSMOSDB_DATABASE_NAME` and one container name per
  container, `COSMOSDB_COOKS_CONTAINER_NAME`,
  `COSMOSDB_DEVICES_CONTAINER_NAME`, `COSMOSDB_TEMPERATURES_CONTAINER_NAME`,
  `COSMOSDB_USERS_CONTAINER_NAME` and `COSMOSDB_RECIPES_CONTAINER_NAME`. All
  are Terraform-owned: the database name is
  `module.cosmos_db.destination_database_name`, the MG-53 shared-throughput
  destination the MG-62 cutover repointed both dev consumers onto, required
  with no default, so the app can never be deployed pointed at a database
  that does not exist (MG-51). The Flex deployment storage uses the same
  identity (`storage_authentication_type = "SystemAssignedIdentity"` on a
  `blobContainer`; shared-key access disabled).
  The single non-secret exception is Application Insights, wired via its
  telemetry `APPLICATIONINSIGHTS_CONNECTION_STRING`. App Service
  Authentication (Easy Auth) is configured **default-deny**. The caller
  identity every route uses is the Easy Auth principal, `"<tid>:<oid>"`.
  The diagrams above show logical data flows, not the full RBAC posture.
- **Cook session state recovery** detail: the SignalR producer side
  (API emitting `cook_started` / `cook_stopped`) **shipped in MG-14**, so
  the data-pusher's SignalR consumer now has a real producer. Until the
  MG-24 SignalR Service bootstrap makes the live path runnable (AC5, see
  `docs/api/signalr-cook-events-smoke.md`), `cooksession.Reconcile` against
  the REST API at startup remains the practical cook-id source. Diagram 3
  calls this out in the cook-start step.
