# Device Controller & Data Pusher

## Overview

The device layer consists of two Go applications running on Raspberry Pi:

1. **Device Controller**: Enhanced version of the existing temperature monitoring application
2. **Data Pusher**: New service that handles cook session management and IoT Hub communication

## Device Controller (Enhanced)

### **Purpose**
- Hardware interface for RTD temperature sensors
- Local temperature averaging and display
- HTTP API for temperature data access
- Maintains existing functionality while integrating with new architecture

### **Key Features**
- **5 RTD Sensors**: Grill + 4 probe temperatures
- **MCP3008 ADC**: Analog-to-digital conversion  
- **Temperature Averaging**: 100-sample queues for stability
- **LCD Display**: Real-time local temperature display
- **HTTP API**: Provides temperature data to Data Pusher

### **Implementation Structure**

```
apps/device-controller/
├── cmd/
│   └── main.go                 # Application entry point
├── internal/
│   ├── sensors/
│   │   ├── rtd.go             # RTD sensor interface  
│   │   ├── mcp3008.go         # ADC communication
│   │   └── averaging.go       # Temperature averaging queues
│   ├── display/
│   │   ├── lcd.go             # LCD management
│   │   └── formatter.go       # Temperature display formatting
│   ├── api/
│   │   ├── server.go          # HTTP API server
│   │   ├── handlers.go        # Request handlers
│   │   └── types.go           # API response types
│   └── config/
│       └── config.go          # Configuration management
├── pkg/
│   └── goqueue/              # Existing queue implementation
├── main.go                    # Legacy compatibility entry point
├── go.mod
├── go.sum
└── Makefile                   # Build commands
```

### **API Endpoints**

The Device Controller provides HTTP endpoints for the Data Pusher:

```go
// HTTP API endpoints (port 3000)
type APIServer struct {
    rtds []*RTD
    smokerStatus *Status
}

// GET /api/robots/MeatGeekBot/commands/get_temps
// Returns temperature readings only
func (s *APIServer) GetTemps(w http.ResponseWriter, r *http.Request) {
    temps := Temps{
        GrillTemp:  s.rtds[0].temp,
        Probe1Temp: s.rtds[1].temp,
        Probe2Temp: s.rtds[2].temp,
        Probe3Temp: s.rtds[3].temp,
        Probe4Temp: s.rtds[4].temp,
    }
    
    json.NewEncoder(w).Encode(temps)
}

// GET /api/robots/MeatGeekBot/commands/get_status  
// Returns complete device status
func (s *APIServer) GetStatus(w http.ResponseWriter, r *http.Request) {
    status := Status{
        SmokerID:    s.smokerStatus.SmokerID,
        Temps:       s.getCurrentTemps(),
        CurrentTime: time.Now(),
        // ... other status fields
    }
    
    json.NewEncoder(w).Encode(status)
}
```

### **Data Structures**

```go
// Temperature readings
type Temps struct {
    GrillTemp  float64 `json:"grillTemp"`
    Probe1Temp float64 `json:"probe1Temp"`
    Probe2Temp float64 `json:"probe2Temp"`
    Probe3Temp float64 `json:"probe3Temp"`
    Probe4Temp float64 `json:"probe4Temp"`
}

// Complete device status
type Status struct {
    ID          string    `json:"id"`
    SmokerID    string    `json:"smokerid"`
    Temps       Temps     `json:"temps"`
    AugerOn     bool      `json:"augerOn"`
    BlowerOn    bool      `json:"blowerOn"`
    IgniterOn   bool      `json:"igniterOn"`
    FireHealthy bool      `json:"fireHealthy"`
    Mode        string    `json:"mode"`
    SetPoint    int       `json:"setPoint"`
    CurrentTime time.Time `json:"currentTime"`
}

// RTD sensor with averaging
type RTD struct {
    title           string
    channel         int
    resistanceQueue queue.Queue  // 100-sample queue
    tempCorrection  float64
    temp            float64
}
```

### **Makefile Commands**

```makefile
# apps/device-controller/Makefile
BINARY_NAME=MeatGeek-DeviceController

.PHONY: build build-arm test lint format clean dev

# Local development build
build:
	go build -o dist/$(BINARY_NAME) main.go

# Cross-compile for Raspberry Pi
build-arm:
	GOARCH=arm64 GOOS=linux go build -o dist/$(BINARY_NAME)-arm main.go

# Run tests
test:
	go test -v ./...
	go test -v ./goqueue

# Development with mock sensors
dev:
	go run main.go --mock-sensors=true --debug=true

# Format code
format:
	go fmt ./...
	goimports -w .

# Clean build artifacts
clean:
	rm -rf dist/
	go clean
```

## Data Pusher Service (New)

### **Purpose**
- **Cook session management**: Maintains active cook state
- **Temperature enrichment**: Adds cookId to temperature data
- **IoT Hub communication**: Sends enriched telemetry to Azure
- **SignalR integration**: Receives cook notifications from cloud

### **Key Features**
- **Cook state management**: Tracks active cook sessions locally
- **Temperature polling**: Polls Device Controller every 5 seconds
- **Data enrichment**: Adds cookId and metadata to temperature readings
- **Reliable transmission**: Handles network outages with local buffering
- **State recovery**: Recovers cook state on restart

### **Implementation Structure**

```
apps/data-pusher/
├── cmd/
│   └── main.go                 # Service entry point
├── internal/
│   ├── collector/
│   │   ├── temperature.go     # Temperature data collection
│   │   └── client.go          # Device Controller HTTP client
│   ├── cook/
│   │   ├── session.go         # Cook session management
│   │   ├── state.go           # Local state persistence  
│   │   └── recovery.go        # State recovery on startup
│   ├── iothub/
│   │   ├── client.go          # IoT Hub communication
│   │   ├── message.go         # Message formatting
│   │   └── retry.go           # Retry logic for failures
│   ├── signalr/
│   │   ├── connection.go      # SignalR client connection
│   │   ├── handlers.go        # Event handlers
│   │   └── reconnect.go       # Reconnection logic
│   └── buffer/
│       ├── store.go           # Local message buffering
│       └── forward.go         # Store-and-forward logic
├── pkg/
│   ├── config/
│   └── telemetry/            # OpenTelemetry integration
├── go.mod
├── go.sum
└── Makefile                   # Build commands
```

### **Cook Session Management**

The Data Pusher maintains cook session state and enriches temperature data:

```go
// Cook session manager
type CookManager struct {
    activeCook   *ActiveCook
    stateFile    string
    mutex        sync.RWMutex
    deviceClient DeviceControllerClient
    iotClient    IoTHubClient
    signalrConn  SignalRConnection
}

type ActiveCook struct {
    CookID     string    `json:"cookId"`
    DeviceID   string    `json:"deviceId"`
    Name       string    `json:"name"`
    StartTime  time.Time `json:"startTime"`
    Status     string    `json:"status"`
}

// Start a new cook session
func (cm *CookManager) StartCook(cookId, deviceId, name string) error {
    cm.mutex.Lock()
    defer cm.mutex.Unlock()
    
    cm.activeCook = &ActiveCook{
        CookID:    cookId,
        DeviceID:  deviceId,
        Name:      name,
        StartTime: time.Now(),
        Status:    "active",
    }
    
    // Persist state to file for recovery
    return cm.saveState()
}

// Stop the current cook session
func (cm *CookManager) StopCook() error {
    cm.mutex.Lock()
    defer cm.mutex.Unlock()
    
    cm.activeCook = nil
    return cm.saveState()
}

// Get current active cook (thread-safe)
func (cm *CookManager) GetActiveCook() *ActiveCook {
    cm.mutex.RLock()
    defer cm.mutex.RUnlock()
    
    if cm.activeCook != nil {
        // Return copy to prevent modification
        cook := *cm.activeCook
        return &cook
    }
    return nil
}
```

### **Temperature Data Enrichment**

```go
// Temperature collector and enricher
type TemperatureCollector struct {
    deviceURL   string
    cookManager *CookManager
    httpClient  *http.Client
}

type EnrichedTemperatureReading struct {
    MessageType string    `json:"messageType"`
    DeviceID    string    `json:"deviceId"`
    CookID      *string   `json:"cookId,omitempty"`
    Timestamp   time.Time `json:"timestamp"`
    GrillTemp   *float64  `json:"grillTemp"`
    Probe1Temp  *float64  `json:"probe1Temp"`
    Probe2Temp  *float64  `json:"probe2Temp"`
    Probe3Temp  *float64  `json:"probe3Temp"`
    Probe4Temp  *float64  `json:"probe4Temp"`
}

// Collect and enrich temperature data
func (tc *TemperatureCollector) CollectTemperatures() (*EnrichedTemperatureReading, error) {
    // Get raw temperature data from Device Controller
    resp, err := tc.httpClient.Get(tc.deviceURL + "/api/robots/MeatGeekBot/commands/get_temps")
    if err != nil {
        return nil, fmt.Errorf("failed to get temperatures: %w", err)
    }
    defer resp.Body.Close()
    
    var temps Temps
    if err := json.NewDecoder(resp.Body).Decode(&temps); err != nil {
        return nil, fmt.Errorf("failed to decode temperatures: %w", err)
    }
    
    // Enrich with cook session data
    enriched := &EnrichedTemperatureReading{
        MessageType: "temperature",
        DeviceID:    "meatgeek3", // TODO: Make configurable
        Timestamp:   time.Now(),
        GrillTemp:   &temps.GrillTemp,
        Probe1Temp:  &temps.Probe1Temp,
        Probe2Temp:  &temps.Probe2Temp,
        Probe3Temp:  &temps.Probe3Temp,
        Probe4Temp:  &temps.Probe4Temp,
    }
    
    // Add cook ID if there's an active cook
    if activeCook := tc.cookManager.GetActiveCook(); activeCook != nil {
        enriched.CookID = &activeCook.CookID
    }
    
    return enriched, nil
}
```

### **SignalR Event Handling**

```go
// SignalR event handlers for cook management
type SignalRHandler struct {
    cookManager *CookManager
    connection  SignalRConnection
}

// Handle cook started event from cloud
func (sh *SignalRHandler) OnCookStarted(cookId, deviceId, name string) {
    log.Printf("Received cook started event: cookId=%s, name=%s", cookId, name)
    
    if err := sh.cookManager.StartCook(cookId, deviceId, name); err != nil {
        log.Printf("Failed to start cook: %v", err)
        return
    }
    
    log.Printf("Cook started successfully: %s", name)
}

// Handle cook stopped event from cloud
func (sh *SignalRHandler) OnCookStopped(cookId string) {
    log.Printf("Received cook stopped event: cookId=%s", cookId)
    
    if err := sh.cookManager.StopCook(); err != nil {
        log.Printf("Failed to stop cook: %v", err)
        return
    }
    
    log.Printf("Cook stopped successfully")
}

// Register SignalR event handlers
func (sh *SignalRHandler) RegisterHandlers() {
    sh.connection.On("cookStarted", sh.OnCookStarted)
    sh.connection.On("cookStopped", sh.OnCookStopped)
}
```

### **Main Service Loop**

```go
// Main data pusher service
func main() {
    // Initialize components
    cookManager := NewCookManager("meatgeek3", "/var/lib/meatgeek/cook-state.json")
    tempCollector := NewTemperatureCollector("http://localhost:3000", cookManager)
    iotClient := NewIoTHubClient(config.IoTHubConnectionString)
    signalrHandler := NewSignalRHandler(cookManager)
    
    // Recover cook state on startup
    if err := cookManager.RecoverState(); err != nil {
        log.Printf("Failed to recover cook state: %v", err)
    }
    
    // Connect to SignalR
    if err := signalrHandler.Connect(); err != nil {
        log.Fatalf("Failed to connect to SignalR: %v", err)
    }
    
    // Main collection loop
    ticker := time.NewTicker(5 * time.Second)
    defer ticker.Stop()
    
    for {
        select {
        case <-ticker.C:
            // Collect and send temperature data
            temps, err := tempCollector.CollectTemperatures()
            if err != nil {
                log.Printf("Failed to collect temperatures: %v", err)
                continue
            }
            
            // Send to IoT Hub
            if err := iotClient.SendTemperature(temps); err != nil {
                log.Printf("Failed to send temperature: %v", err)
                // Could implement local buffering here
            }
            
        case <-ctx.Done():
            log.Println("Shutting down data pusher")
            return
        }
    }
}
```

## Deployment

### **Systemd Services**

Both services run as systemd services on the Raspberry Pi:

**Device Controller Service** (`/etc/systemd/system/meatgeek-controller.service`):
```ini
[Unit]
Description=MeatGeek Device Controller
After=network.target
Wants=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/meatgeek
ExecStart=/usr/local/bin/MeatGeek-DeviceController
Restart=always
RestartSec=5
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
```

**Data Pusher Service** (`/etc/systemd/system/meatgeek-pusher.service`):
```ini
[Unit]
Description=MeatGeek Data Pusher
After=network.target meatgeek-controller.service
Wants=network.target
Requires=meatgeek-controller.service

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/meatgeek
ExecStart=/usr/local/bin/meatgeek-pusher
Restart=always
RestartSec=10
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
```

### **Deployment Commands**

```bash
# Build for Raspberry Pi
nx build-arm device-controller
nx build-arm data-pusher

# Copy to device  
scp dist/MeatGeek-DeviceController-arm pi@192.168.1.37:/tmp/
scp dist/meatgeek-pusher-arm pi@192.168.1.37:/tmp/

# Install on device
ssh pi@192.168.1.37
sudo mv /tmp/MeatGeek-DeviceController-arm /usr/local/bin/MeatGeek-DeviceController
sudo mv /tmp/meatgeek-pusher-arm /usr/local/bin/meatgeek-pusher
sudo chmod +x /usr/local/bin/MeatGeek-DeviceController
sudo chmod +x /usr/local/bin/meatgeek-pusher

# Restart services
sudo systemctl restart meatgeek-controller
sudo systemctl restart meatgeek-pusher

# Check status
sudo systemctl status meatgeek-controller
sudo systemctl status meatgeek-pusher
```

## Benefits of This Architecture

1. **Separation of Concerns**: Device Controller focuses on hardware, Data Pusher handles cloud communication
2. **Resilience**: If Data Pusher fails, Device Controller continues monitoring
3. **Cook Management**: Device maintains cook state locally for reliable association
4. **Backward Compatibility**: Existing Device Controller functionality preserved
5. **Easy Updates**: Can update Data Pusher independently of Device Controller
6. **Local Recovery**: Cook state persisted locally for recovery after restarts

This device architecture provides a robust foundation for the MeatGeek V2 system while maintaining the reliability and simplicity of the original design.