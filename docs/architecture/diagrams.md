# MeatGeek V2 — Architecture Diagrams

These four diagrams capture the current state of the system **and** the
proposed additions in ticket #6 (otel-integration). Throughout, the
convention is:

- **Solid edges, default-colored nodes** → exists in the codebase today
  (committed through ticket #5).
- **Dashed edges, blue-outlined nodes (`current` class)** → exists today
  but is touched by ticket #6 (configuration change, not a new
  component).
- **Dashed edges, orange-filled nodes (`proposed` class)** → introduced
  by ticket #6.
- **Red-outlined nodes (`blocked` class)** → defined by #6 but inert
  until a separate dependency lands (e.g. the MG-24 greenfield SignalR
  Service bootstrap that makes the shipped cook-event path live, ticket
  #7 for Sentry implementation).

Each diagram has a prose legend immediately above explaining what is
new versus established.

---

## 1. System Architecture (C4 Context + Container)

**Legend.** Pi-side binaries (`device-controller`, `data-pusher`), the
Azure managed plane (IoT Hub, Event Hub, CosmosDB, SignalR, Functions),
and the clients (mobile, web) all exist today. Ticket #6 does **not**
add any new container — it adds OTel SDK instrumentation **inside** the
existing containers (shown as `OTel` sub-nodes), and a Sentry SaaS
container that the mobile app talks to directly. The shape of the
parallel storage/realtime fan-out from IoT Hub is unchanged.

```mermaid
flowchart TB
    classDef current stroke:#1f77b4,stroke-width:2px,stroke-dasharray: 4 2
    classDef proposed fill:#ffd28a,stroke:#d97706,stroke-width:2px,stroke-dasharray: 4 2,color:#000
    classDef blocked fill:#fff,stroke:#dc2626,stroke-width:2px,stroke-dasharray: 2 2,color:#000
    classDef external fill:#eee,stroke:#666

    subgraph Pi["Raspberry Pi (ARM64)"]
        Sensors[(5 RTD Sensors<br/>grill + 4 probes)]
        DC[device-controller<br/>Go / Gobot<br/>:3000 local API]
        DP[data-pusher<br/>Go + disk-backed queue<br/>+ cooksession.Store]
        LCD[LCD Display]
        OTEL_DC[OTel Go SDK]:::proposed
        OTEL_DP[OTel Go SDK<br/>tracing.go skeleton<br/>exists, exporter wired]:::proposed
    end

    subgraph AzureIngest["Azure - Ingest"]
        IoTHub[IoT Hub<br/>2 parallel routes]
        EventHub[Event Hub<br/>temperature-data]
    end

    subgraph AzureProcess["Azure - Compute and Data"]
        Funcs[Azure Functions API<br/>TypeScript / Node 24<br/>Flex Consumption]
        OTEL_FN["@azure/monitor-opentelemetry<br/>50 pct sampling"]:::proposed
        Cosmos[(CosmosDB<br/>temperatures container<br/>partition /cookId)]
        SignalR[SignalR Service<br/>device-* and cook-* groups]
    end

    subgraph Observability["Azure - Observability"]
        AppI[Application Insights]:::current
        LAW[Log Analytics Workspace<br/>diagnostic settings<br/>for IoTHub/Cosmos/SignalR/Func]:::current
    end

    subgraph SaaS["Third-party SaaS"]
        Sentry[Sentry<br/>free tier]:::blocked
    end

    subgraph Clients["Clients"]
        Mobile[Mobile App<br/>React Native]
        Web[Web App<br/>React/Vite]
    end

    Sensors --> DC
    DC --> LCD
    DC -- "HTTP poll 5s" --> DP
    DP -- "telemetry +<br/>correlation.id property" --> IoTHub

    IoTHub -- "route: cosmos-storage-route<br/>identity-based" --> Cosmos
    IoTHub -- "route: eventhub-realtime-route" --> EventHub
    EventHub -- "EventHub trigger" --> Funcs
    Funcs -- "broadcast" --> SignalR
    SignalR -- "device-{id}, cook-{id}" --> Mobile
    SignalR -- "device-{id}, cook-{id}" --> Web

    Funcs -- "REST: cooks, devices,<br/>temperatures/current" --> Mobile
    Funcs -- "REST" --> Web
    Funcs -- "CosmosDB SDK" --> Cosmos

    Funcs -. "negotiate + cook_started/stopped<br/>shipped MG-14, live path pending MG-24" .-> SignalR
    SignalR -. "cook lifecycle events<br/>temperatureHub, group userId=deviceId" .-> DP

    OTEL_DC -. instruments .- DC
    OTEL_DP -. instruments .- DP
    OTEL_FN -. instruments .- Funcs

    OTEL_DC -. "AlwaysSample,<br/>exporter direct" .-> AppI
    OTEL_DP -. "AlwaysSample,<br/>exporter direct" .-> AppI
    OTEL_FN -. "50 pct standalone sampler" .-> AppI
    Mobile -. "crashes + RUM<br/>ticket 7" .-> Sentry
```

---

## 2. Deployment

**Legend.** What runs where. Pi binaries are cross-compiled to ARM64
and copied to the device. Functions deploy as a Flex Consumption
app. All Azure managed services exist today (provisioned by Terraform
in `apps/infrastructure/modules/`). Ticket #6 changes **deployment
artifacts** rather than topology: the Pi binaries gain the Azure
Monitor Go exporter (dashed orange), the Functions app gains the
`@azure/monitor-opentelemetry` package, and `APPLICATIONINSIGHTS_CONNECTION_STRING`
becomes a required env var on both sides. Sentry is shown as an
external SaaS dependency that the mobile app will talk to (ticket #7,
red-outlined as blocked here).

```mermaid
flowchart LR
    classDef current stroke:#1f77b4,stroke-width:2px,stroke-dasharray: 4 2
    classDef proposed fill:#ffd28a,stroke:#d97706,stroke-width:2px,stroke-dasharray: 4 2,color:#000
    classDef blocked fill:#fff,stroke:#dc2626,stroke-width:2px,stroke-dasharray: 2 2,color:#000
    classDef host fill:#f6f6f6,stroke:#888

    subgraph PiHost["Raspberry Pi linux/arm64 - physical device per smoker"]
        direction TB
        dcBin[device-controller binary<br/>built via nx build-arm]
        dpBin[data-pusher binary<br/>built via nx build-arm<br/>queue at /var/lib/meatgeek-pusher/queue<br/>state at cooksession.DefaultStatePath]
        otelGo1[OTel Go SDK<br/>+ Azure Monitor exporter]:::proposed
        otelGo2[OTel Go SDK<br/>+ Azure Monitor exporter]:::proposed
        envPi[/env: APPLICATIONINSIGHTS_CONNECTION_STRING<br/>IOTHUB_CONNECTION_STRING<br/>SIGNALR_HUB_URL, API_BASE_URL/]:::proposed
    end

    subgraph AzurePaaS["Azure - meatgeek-env-rg"]
        direction TB

        subgraph FnHost["Flex Consumption Function App<br/>FC1 plan<br/>node 24<br/>system-assigned managed identity"]
            apiBin[apps/api bundle<br/>HTTP triggers: cooks, devices, temperatures/current<br/>EventHub trigger: realtime broadcast]
            otelFn["@azure/monitor-opentelemetry<br/>useAzureMonitor + standalone sampler"]:::proposed
            envFn[/APPLICATIONINSIGHTS_CONNECTION_STRING<br/>APPLICATIONINSIGHTS_SAMPLING_PERCENTAGE=50<br/>COSMOSDB__accountEndpoint<br/>IOTHUB_EVENTS__fullyQualifiedNamespace<br/>AzureSignalRConnectionString__serviceUri<br/>all identity-based, non-secret endpoints/]
        end

        iotMgd[IoT Hub<br/>system-assigned identity<br/>cosmos-storage-route<br/>eventhub-realtime-route]
        ehMgd[Event Hub Namespace<br/>temperature-data, 2 partitions]
        cosmosMgd[(CosmosDB Account<br/>temperatures container)]
        signalrMgd[SignalR Service<br/>Serverless]
        appiMgd[Application Insights<br/>workspace-based]
        lawMgd[Log Analytics Workspace<br/>2 GB/day cap]
        wb["Workbook stub<br/>content lands in ticket 6"]:::current
        ag[Action Group<br/>email receiver]
    end

    subgraph SaaSExt["External SaaS"]
        sentryCloud["Sentry<br/>Developer free tier<br/>RN SDK + sourcemaps<br/>blocked on ticket 7"]:::blocked
    end

    subgraph ClientHosts["Client devices"]
        mob[Mobile App<br/>iOS/Android RN]
        webApp[Web App<br/>React/Vite static]
    end

    dpBin -- "AMQP/MQTT" --> iotMgd
    dpBin -- "WebSocket" --> signalrMgd
    iotMgd --> ehMgd
    iotMgd --> cosmosMgd
    ehMgd -- "EventHub trigger<br/>identity-based (RBAC)" --> apiBin
    apiBin -- "identity-based (RBAC)" --> cosmosMgd
    apiBin -- "identity-based (RBAC)" --> signalrMgd

    signalrMgd --> mob
    signalrMgd --> webApp
    apiBin -- HTTPS --> mob
    apiBin -- HTTPS --> webApp

    otelGo1 -. instruments .- dcBin
    otelGo2 -. instruments .- dpBin
    otelFn -. instruments .- apiBin

    otelGo1 -. "HTTPS, AlwaysSample" .-> appiMgd
    otelGo2 -. "HTTPS, AlwaysSample" .-> appiMgd
    otelFn -. "50 pct sampling" .-> appiMgd

    iotMgd -. diagnostic settings .-> lawMgd
    cosmosMgd -. diagnostic settings .-> lawMgd
    signalrMgd -. diagnostic settings .-> lawMgd
    FnHost -. diagnostic settings .-> lawMgd

    lawMgd --- appiMgd
    appiMgd --- wb
    appiMgd -- metric alerts --> ag

    mob -. crashes + RUM .-> sentryCloud
```

---

## 3. Cook Lifecycle Sequence — Two Correlation Axes

**Legend.** This sequence shows a single temperature reading flowing
through the system **after** a cook has started. Two independent
correlation identifiers are emphasized:

- **`correlation.id`** (purple notes) — *cook-scoped*. Originates in
  the SignalR `CorrelationContext.id` envelope when the API publishes
  a `cook_started` event. The data-pusher captures it in
  `correlationHolder` (see `apps/data-pusher/cmd/main.go:185`) and
  stamps it on **every** outbound IoT Hub message via the
  `correlation.id` message property (constant
  `iothub.CorrelationIDPropertyName`). It is essentially constant for
  the duration of a cook. **This is unchanged by ticket #6** — the
  ticket explicitly preserves it as the cook-grouping dimension.
- **`traceparent`** (orange notes) — *per-message*, W3C Trace Context.
  Newly introduced by ticket #6. The data-pusher's OTel span context
  is serialized into the standard `traceparent` header/property on
  the IoT Hub message; the Function reads it back into the trace
  context on receive. Independent of cook scope: every published
  message gets a fresh traceparent.

The SignalR producer side (API emitting `cook_started` / `cook_stopped`)
**shipped in MG-14**: `startCook` and `stopCook` (registered in
`apps/api/src/main.ts`) emit cook-lifecycle events to the `temperatureHub`
SignalR hub, scoped to the per-device user group (`userId = deviceId`), and
the data-pusher's SignalR consumer receives them and latches the propagated
correlation id into `correlationHolder`. The **live** end-to-end path still
awaits the MG-24 greenfield SignalR Service bootstrap (AC5, see
`docs/api/signalr-cook-events-smoke.md`); until an operator runs it against
live infrastructure, `cooksession.Reconcile` against the REST API on startup
remains the practical cook-id source.

```mermaid
sequenceDiagram
    autonumber
    participant User as Mobile App
    participant API as Functions API
    participant SR as SignalR Service
    participant DP as data-pusher (Pi)
    participant DC as device-controller (Pi)
    participant IoT as IoT Hub
    participant EH as Event Hub
    participant Fn as Functions broadcast
    participant Cos as CosmosDB
    participant AI as App Insights

    rect rgba(220,38,38,0.08)
        Note over User,SR: Cook start - producer shipped (MG-14); live path pending MG-24 bootstrap
        User->>API: POST /cooks  (start cook)
        API->>Cos: insert cook doc {id=cook-abc123}
        API-->>SR: publish cook_started<br/>envelope.correlation.id = "corr-xyz"
        SR-->>DP: cook_started event<br/>{cookId, correlation.id="corr-xyz"}
        Note over DP: cooksession.Store.SetActiveCookID(cook-abc123)<br/>correlationHolder.Set("corr-xyz")
    end

    Note over DC,DP: Steady state - every 5s

    DC->>DC: poll 5 RTD sensors (10ms loop)
    DP->>DC: HTTP GET /api/.../get_temps
    DC-->>DP: 5 temps
    Note over DP: enqueuer attaches:<br/>cookId = cooksession.ActiveCookID()<br/>queueRecord.Correlation = correlationHolder.Get()

    rect rgba(255,210,138,0.35)
        Note over DP: TICKET 6: OTel Go SDK starts span iothub.publish and serializes span context to traceparent property per-message
    end

    DP->>IoT: PublishTelemetry payload + properties with messageId, correlation.id=corr-xyz, traceparent=00-traceId-spanId-01

    par Storage path
        IoT->>Cos: cosmos-storage-route<br/>(identity-based, no Function)
        Note over Cos: doc stored with cookId in body<br/>correlation.id only in IoT Hub props,<br/>not promoted into Cosmos doc today
    and Realtime path
        IoT->>EH: eventhub-realtime-route
        EH->>Fn: trigger (batch)
        rect rgba(255,210,138,0.35)
            Note over Fn: TICKET 6: useAzureMonitor() initialized, standalone 50 pct sampler, approx 50 pct of device-originated traces truncated at this boundary by design (NOT parent-based)
            Note over Fn: read traceparent, restore span context, read correlation.id property, set span attribute correlation.id
        end
        Fn->>SR: sendToGroup(device-{id}, cook-{id})<br/>'temperatureUpdate'
        SR-->>User: live temperature
    end

    Note over DP,AI: TICKET 6 - both paths emit spans with standard dimensions: device.id, cook.id, correlation.id, processing.path in storage or realtime, component, environment

    DP-->>AI: span batch (AlwaysSample)
    Fn-->>AI: span batch (50 pct sampler)
```

---

## 4. Telemetry & Observability Flow

**Legend.** Where each OTel SDK lives, what metrics each component
emits, where data flows, and which alerts are live versus inert. The
"no-bridge" boundary between Sentry and App Insights is shown
explicitly: traces are joined by **human copy-paste of the trace ID**,
not by any automatic correlation pipeline.

- **Solid blue** edges: existing telemetry flow today.
- **Dashed orange** edges/nodes: introduced by ticket #6.
- **Red-outlined** alert nodes: defined in #6 but **inert** until the
  live cook-event path runs, since 3 of them depend on the
  `processing.path` and `cook.id` dimensions only being populated once
  the realtime path actually emits spans with a cook context. The SignalR
  producer shipped in MG-14; the live path now awaits the MG-24 SignalR
  Service bootstrap (see `docs/api/signalr-cook-events-smoke.md`).
- The vertical bar labelled **"no bridge"** between App Insights and
  Sentry is intentional: ticket #6 documents that the two tools are
  **never** wired together programmatically — the user opens both
  consoles and joins by trace ID.

```mermaid
flowchart TB
    classDef current stroke:#1f77b4,stroke-width:2px
    classDef proposed fill:#ffd28a,stroke:#d97706,stroke-width:2px,stroke-dasharray: 4 2,color:#000
    classDef blocked fill:#fff,stroke:#dc2626,stroke-width:2px,stroke-dasharray: 2 2,color:#000
    classDef live fill:#bbf7d0,stroke:#15803d,stroke-width:2px,color:#000
    classDef boundary fill:#fef3c7,stroke:#a16207,stroke-width:1px,stroke-dasharray: 1 3,color:#000

    subgraph Emitters["Telemetry emitters"]
        direction TB
        dpSDK[data-pusher<br/>OTel Go SDK<br/>AlwaysSample]:::proposed
        dcSDK[device-controller<br/>OTel Go SDK<br/>AlwaysSample]:::proposed
        fnSDK["Functions API<br/>@azure/monitor-opentelemetry<br/>standalone 50 percent sampler"]:::proposed
        mobSDK["Mobile RN<br/>Sentry SDK<br/>blocked on ticket 7"]:::blocked
    end

    subgraph Metrics["Custom metrics catalog"]
        direction TB
        mConn["meatgeek_device_connectivity<br/>UpDownCounter 0 or 1<br/>by device.id"]:::proposed
        mTemp[meatgeek_temperature<br/>by sensor, device.id, cook.id]:::proposed
        mPath["processing.path dimension<br/>storage or realtime<br/>emitted by Functions"]:::proposed
    end

    subgraph Sinks["Sinks"]
        AI[(Application Insights<br/>workspace-based)]:::current
        LAW[("Log Analytics Workspace<br/>cap: 2 GB per day")]:::current
        Sentry[(Sentry SaaS<br/>org + project,<br/>DSN per env)]:::blocked
    end

    subgraph SamplingBoundary["Sampling boundary"]
        sb["Standalone 50 percent sampler<br/>NOT parent-based<br/>approx 50 percent of device-originated traces<br/>truncated at Functions boundary<br/>by design, accepted trade-off"]:::proposed
    end

    subgraph JoinBoundary["Trace-ID join (manual)"]
        nob["no bridge<br/>operator copies trace ID<br/>between consoles"]:::boundary
    end

    subgraph AlertsLive["Live alerts - Phase 1, in ticket 6"]
        a1["device-disconnected<br/>meatgeek_device_connectivity == 0"]:::live
        a2["temperature-out-of-range<br/>value above 500F or below 32F"]:::live
    end

    subgraph AlertsInert["Inert stub alerts, defined in ticket 6, actionable once the live cook-event path runs (MG-24)"]
        a3["realtime-error-rate above 10 pct per 5min<br/>needs processing.path=realtime spans"]:::blocked
        a4["storage-path-p95-latency above 5s per 5min<br/>needs processing.path=storage spans"]:::blocked
        a5["cook-session-idle above 2min<br/>needs cook.id present on spans"]:::blocked
    end

    AG[Action Group<br/>email receiver]:::current

    dpSDK -- meatgeek_device_connectivity --> mConn
    dpSDK -- meatgeek_temperature --> mTemp
    dcSDK -- spans only --> AI
    fnSDK -- processing.path dimension --> mPath

    dpSDK -- "spans+metrics, AlwaysSample" --> sb
    dcSDK -- "spans, AlwaysSample" --> sb
    fnSDK -- spans+metrics --> sb
    sb -- "approx 50 pct sampled, approx 50 pct dropped" --> AI

    mConn --> AI
    mTemp --> AI
    mPath --> AI

    AI --- LAW

    mobSDK --> Sentry

    AI --- nob
    nob --- Sentry

    AI -- query --> a1
    AI -- query --> a2
    AI -- query --> a3
    AI -- query --> a4
    AI -- query --> a5

    a1 --> AG
    a2 --> AG
    a3 -. blocked .-> AG
    a4 -. blocked .-> AG
    a5 -. blocked .-> AG
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
  secret is emitted as a Terraform output. The Flex deployment storage uses the
  same identity (`storage_authentication_type = "SystemAssignedIdentity"` on a
  `blobContainer`; shared-key access disabled).
  The single non-secret exception is Application Insights, wired via its
  telemetry `APPLICATIONINSIGHTS_CONNECTION_STRING`. App Service
  Authentication (Easy Auth) is configured **default-deny**. The diagrams
  above show logical data flows, not the full RBAC posture.
- **Cook session state recovery** detail: the SignalR producer side
  (API emitting `cook_started` / `cook_stopped`) **shipped in MG-14**, so
  the data-pusher's SignalR consumer now has a real producer. Until the
  MG-24 SignalR Service bootstrap makes the live path runnable (AC5, see
  `docs/api/signalr-cook-events-smoke.md`), `cooksession.Reconcile` against
  the REST API at startup remains the practical cook-id source. Diagram 3
  calls this out in the cook-start swimlane.
- **Mobile/Web build pipelines and Sentry sourcemap upload**: filed
  under ticket #7; out of scope for #6's diagrams beyond establishing
  the architectural boundary.
